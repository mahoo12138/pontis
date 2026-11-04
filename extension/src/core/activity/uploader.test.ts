// Flush tests: replace-per-day batches, per-day backoff, and the gates
// (mode, pairing) that keep the network touch deliberate.

import { describe, expect, it } from 'vitest';

import { ActivityDB, defaultActivityPrefs, saveActivityPrefs, type ActivityPrefsRecord } from './store';
import { flushActivity, retryDelayMs, type ActivityTransport } from './uploader';
import type { ActivityBatchWire } from './wire';

class FakeTransport implements ActivityTransport {
  batches: ActivityBatchWire[] = [];
  ackDays: string[] | null = null; // null = ack everything sent
  error: Error | null = null;

  async uploadActivityBatch(req: ActivityBatchWire) {
    this.batches.push(req);
    if (this.error) {
      const err = this.error;
      this.error = null;
      throw err;
    }
    const days = this.ackDays ?? req.days.map((d) => d.day);
    return { results: days.map((day) => ({ day, status: 'accepted' as const })) };
  }
}

const NOW = new Date(2026, 10, 4, 12, 0, 0).getTime();

async function db(): Promise<ActivityDB> {
  const d = new ActivityDB(`test-up-${Math.random().toString(36).slice(2)}`);
  await saveActivityPrefs(d, defaultActivityPrefs());
  return d;
}

async function seedDay(
  d: ActivityDB,
  day: string,
  hosts: Array<[string, number, number]>,
  hours: Array<[number, number]> = [],
): Promise<void> {
  await d.daily.bulkPut(hosts.map(([host, seconds, visits]) => ({ day, host, seconds, visits })));
  await d.hourly.bulkPut(hours.map(([hour, seconds]) => ({ day, hour, seconds })));
  await d.queue.put({ day, status: 'QUEUED', attempts: 0, nextAttemptAt: 0 });
}

const gate = (mode: ActivityPrefsRecord['mode'] = 'upload', paired = true) => ({ mode, paired });

describe('flushActivity', () => {
  it('refuses to touch the network without the mode and the pairing', async () => {
    const d = await db();
    const t = new FakeTransport();
    await seedDay(d, '2026-11-04', [['github.com', 60, 1]]);

    expect((await flushActivity(d, t, gate('off'))).skipped).toBe('mode');
    expect((await flushActivity(d, t, gate('local'))).skipped).toBe('mode');
    expect((await flushActivity(d, t, gate('upload', false))).skipped).toBe('unpaired');
    expect(t.batches).toHaveLength(0);
  });

  it('sends complete day payloads and marks the days SENT', async () => {
    const d = await db();
    const t = new FakeTransport();
    await seedDay(
      d,
      '2026-11-04',
      [
        ['github.com', 600, 3],
        ['news.example', 1200, 2],
      ],
      [
        [9, 600],
        [10, 1200],
      ],
    );

    const out = await flushActivity(d, t, gate(), NOW);
    expect(out.skipped).toBeNull();
    expect(out.sent).toEqual(['2026-11-04']);
    expect(t.batches).toHaveLength(1);
    // Hosts ride in seconds-descending order; hours in clock order.
    expect(t.batches[0]!.days).toEqual([
      {
        day: '2026-11-04',
        hosts: [
          { host: 'news.example', seconds: 1200, visits: 2 },
          { host: 'github.com', seconds: 600, visits: 3 },
        ],
        hours: [
          { hour: 9, seconds: 600 },
          { hour: 10, seconds: 1200 },
        ],
      },
    ]);
    expect(await d.queue.get('2026-11-04')).toMatchObject({ status: 'SENT', sentAt: NOW });
  });

  it('backs a failing day off and honours the gate on later flushes', async () => {
    const d = await db();
    const t = new FakeTransport();
    t.error = new Error('NETWORK down');
    await seedDay(d, '2026-11-04', [['github.com', 60, 1]]);

    const first = await flushActivity(d, t, gate(), NOW);
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0]!.error).toContain('NETWORK down');
    const row = await d.queue.get('2026-11-04');
    expect(row).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(row!.nextAttemptAt).toBe(NOW + retryDelayMs(1));

    // Inside the backoff window the flush finds nothing due.
    expect((await flushActivity(d, t, gate(), NOW + 1000)).skipped).toBe('empty');
    // After the gate opens, the same day is retried — and succeeds.
    const later = await flushActivity(d, t, gate(), NOW + retryDelayMs(1));
    expect(later.sent).toEqual(['2026-11-04']);
    expect((await d.queue.get('2026-11-04'))?.attempts).toBe(1);
  });

  it('marks only the days the server actually acknowledged', async () => {
    const d = await db();
    const t = new FakeTransport();
    t.ackDays = ['2026-11-03']; // the server accepted one, stayed silent on the other
    await seedDay(d, '2026-11-03', [['github.com', 60, 1]]);
    await seedDay(d, '2026-11-04', [['github.com', 60, 1]]);

    const out = await flushActivity(d, t, gate(), NOW);
    expect(out.sent).toEqual(['2026-11-03']);
    expect(out.failed.map((f) => f.day)).toEqual(['2026-11-04']);
    expect(await d.queue.get('2026-11-03')).toMatchObject({ status: 'SENT' });
    expect(await d.queue.get('2026-11-04')).toMatchObject({ status: 'QUEUED', attempts: 1 });
  });

  it('drains at most MAX_DAYS_PER_BATCH days per flush, oldest first', async () => {
    const d = await db();
    const t = new FakeTransport();
    const many = Array.from({ length: 20 }, (_, i) => `2026-10-${String(16 + i).padStart(2, '0')}`);
    for (const day of many) {
      await seedDay(d, day, [['github.com', 60, 1]]);
    }
    const out = await flushActivity(d, t, gate(), NOW);
    expect(out.sent).toHaveLength(14);
    expect(t.batches[0]!.days[0]!.day).toBe('2026-10-16');
    expect((await d.queue.where('status').equals('QUEUED').count())).toBe(6);
  });

  it('caps a day at MAX_HOSTS_PER_DAY host rows', async () => {
    const d = await db();
    const t = new FakeTransport();
    const hosts = Array.from({ length: 600 }, (_, i) => [`host${i}.example`, 10, 1] as [string, number, number]);
    await seedDay(d, '2026-11-04', hosts);

    await flushActivity(d, t, gate(), NOW);
    expect(t.batches[0]!.days[0]!.hosts).toHaveLength(500);
  });

  it('re-sends a corrected day: replace semantics make the retry the fix', async () => {
    const d = await db();
    const t = new FakeTransport();
    const episode = (hour: number) => {
      const startedAt = new Date(2026, 10, 4, hour, 0, 0).getTime();
      return {
        startedAt,
        endedAt: startedAt + 300_000,
        host: 'github.com',
        url: 'https://github.com/',
        title: 'gh',
        day: '2026-11-04',
        hour,
      };
    };
    // Two real episodes earlier in the day, rolled up and uploaded.
    await d.segments.bulkAdd([episode(9), episode(10)]);
    const { rebuildDay } = await import('./aggregate');
    await rebuildDay(d, '2026-11-04');
    await flushActivity(d, t, gate(), NOW);
    expect(t.batches[0]!.days[0]!.hosts).toEqual([{ host: 'github.com', seconds: 600, visits: 2 }]);

    // A late episode lands; the rebuild flips the SENT day back to QUEUED
    // and the next flush carries the corrected totals — no ledger needed.
    await d.segments.add(episode(22));
    await rebuildDay(d, '2026-11-04');
    t.batches = [];
    await flushActivity(d, t, gate(), NOW + 1000);
    expect(t.batches[0]!.days[0]!.hosts).toEqual([{ host: 'github.com', seconds: 900, visits: 3 }]);
    expect((await d.queue.get('2026-11-04'))?.status).toBe('SENT');
  });
});

describe('retryDelayMs', () => {
  it('grows and caps at 15 minutes', () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(10)).toBe(15 * 60 * 1000);
  });
});
