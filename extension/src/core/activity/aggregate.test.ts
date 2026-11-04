// Rollup tests: the aggregate tables are a pure function of the segments,
// and the queue re-arm is what keeps "today" converging on the server.

import { describe, expect, it } from 'vitest';

import { ActivityDB, defaultActivityPrefs, saveActivityPrefs } from './store';
import { rebuildDay } from './aggregate';

const DAY = '2026-11-04';

async function db(): Promise<ActivityDB> {
  const d = new ActivityDB(`test-agg-${Math.random().toString(36).slice(2)}`);
  await saveActivityPrefs(d, defaultActivityPrefs());
  return d;
}

function seg(host: string, startedAtHour: number, minutes: number) {
  const startedAt = new Date(2026, 10, 4, startedAtHour, 0, 0).getTime();
  return {
    startedAt,
    endedAt: startedAt + minutes * 60_000,
    host,
    url: `https://${host}/`,
    title: host,
    day: DAY,
    hour: startedAtHour,
  };
}

describe('rebuildDay', () => {
  it('computes host ranking and hourly histogram from segments', async () => {
    const d = await db();
    await d.segments.bulkAdd([
      seg('github.com', 10, 30),
      seg('github.com', 15, 10),
      seg('news.example', 10, 5),
    ]);
    await rebuildDay(d, DAY);

    expect((await d.daily.where('day').equals(DAY).toArray()).sort((a, b) => b.seconds - a.seconds)).toEqual([
      { day: DAY, host: 'github.com', seconds: 40 * 60, visits: 2 },
      { day: DAY, host: 'news.example', seconds: 5 * 60, visits: 1 },
    ]);
    expect(await d.hourly.where('day').equals(DAY).toArray()).toEqual([
      { day: DAY, hour: 10, seconds: 35 * 60 },
      { day: DAY, hour: 15, seconds: 10 * 60 },
    ]);
  });

  it('creates the queue row the first time a day gets totals', async () => {
    const d = await db();
    await d.segments.bulkAdd([seg('github.com', 10, 30)]);
    const changed = await rebuildDay(d, DAY);
    expect(changed).toBe(true);
    expect(await d.queue.get(DAY)).toMatchObject({ day: DAY, status: 'QUEUED', attempts: 0 });
  });

  it('re-arms a SENT day whose totals moved, keeping its backoff', async () => {
    const d = await db();
    await d.segments.bulkAdd([seg('github.com', 10, 30)]);
    await rebuildDay(d, DAY);
    // The flush marked the day SENT after two failed attempts.
    await d.queue.put({ day: DAY, status: 'SENT', attempts: 2, nextAttemptAt: 12345, sentAt: 99 });
    // Late-evening segment arrives; the day is no longer what the server has.
    await d.segments.add(seg('github.com', 22, 5));
    const changed = await rebuildDay(d, DAY);
    expect(changed).toBe(true);
    expect(await d.queue.get(DAY)).toMatchObject({
      status: 'QUEUED',
      attempts: 2,
      nextAttemptAt: 12345,
    });
  });

  it('leaves a day untouched and the queue alone when nothing changed', async () => {
    const d = await db();
    await d.segments.bulkAdd([seg('github.com', 10, 30)]);
    await rebuildDay(d, DAY);
    await d.queue.put({ day: DAY, status: 'SENT', attempts: 0, nextAttemptAt: 0, sentAt: 1 });
    const changed = await rebuildDay(d, DAY);
    expect(changed).toBe(false);
    expect(await d.queue.get(DAY)).toMatchObject({ status: 'SENT', sentAt: 1 });
    expect(await d.daily.count()).toBe(1);
  });

  it('is idempotent under repeat runs and rebuilds cleanly after corrections', async () => {
    const d = await db();
    await d.segments.bulkAdd([seg('github.com', 10, 30)]);
    await rebuildDay(d, DAY);
    await rebuildDay(d, DAY);
    expect(await d.daily.count()).toBe(1);
    // A mis-closed segment is deleted; the rebuild reflects the truth.
    const rows = await d.segments.toArray();
    await d.segments.delete(rows[0]!.id!);
    await rebuildDay(d, DAY);
    expect(await d.daily.count()).toBe(0);
    expect(await d.hourly.count()).toBe(0);
  });
});
