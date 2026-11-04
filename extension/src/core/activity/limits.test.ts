import { describe, expect, it } from 'vitest';

import { ActivityDB, dayKeyOf, defaultActivityPrefs, saveActivityPrefs } from './store';
import { checkDailyLimits, normalizeLimit } from './limits';

const NOW = new Date(2026, 10, 5, 20, 0, 0).getTime();
const TODAY = dayKeyOf(NOW);

async function db() {
  const d = new ActivityDB(`test-limits-${Math.random().toString(36).slice(2)}`);
  await saveActivityPrefs(d, { ...defaultActivityPrefs(), limits: [{ host: 'bilibili.com', minutes: 30 }] });
  return d;
}

async function seedSeconds(d: Awaited<ReturnType<typeof db>>, host: string, seconds: number) {
  await d.daily.put({ day: TODAY, host, seconds, visits: 1 });
}

describe('checkDailyLimits', () => {
  it('is silent when no limits are set', async () => {
    const d = new ActivityDB(`test-limits-${Math.random().toString(36).slice(2)}`);
    await saveActivityPrefs(d, defaultActivityPrefs());
    await seedSeconds(d, 'bilibili.com', 999 * 60);
    expect(await checkDailyLimits(d, NOW)).toEqual([]);
  });

  it('fires once when the budget is crossed, then stays quiet all day', async () => {
    const d = await db();
    await seedSeconds(d, 'bilibili.com', 31 * 60);

    const hits = await checkDailyLimits(d, NOW);
    expect(hits).toEqual([{ host: 'bilibili.com', minutes: 30, seconds: 31 * 60 }]);

    // The mark survives in prefs; the next heartbeat ten seconds later,
    // or a worker replacement, cannot nag a second time today.
    expect(await checkDailyLimits(d, NOW + 10_000)).toEqual([]);
  });

  it('counts the open segment, so the nudge lands while the person is on the site', async () => {
    const d = await db();
    await seedSeconds(d, 'bilibili.com', 28 * 60);
    // Four minutes into the very segment that is about to cross the line.
    await d.state.put({
      id: 'current',
      host: 'bilibili.com',
      url: 'https://bilibili.com/',
      title: '',
      tabId: 1,
      startedAt: NOW - 4 * 60_000,
      lastBeatAt: NOW,
    });

    const hits = await checkDailyLimits(d, NOW);
    expect(hits).toEqual([{ host: 'bilibili.com', minutes: 30, seconds: 32 * 60 }]);
  });

  it('stays silent below the budget and writes nothing to prefs', async () => {
    const d = await db();
    await seedSeconds(d, 'bilibili.com', 29 * 60);
    // saveActivityPrefs stamped the row when the helper set the limit; the
    // check below the budget must leave it exactly as it was.
    const before = (await d.prefs.get('prefs'))?.updatedAt ?? 0;
    expect(await checkDailyLimits(d, NOW)).toEqual([]);
    expect((await d.prefs.get('prefs'))?.updatedAt).toBe(before); // untouched
  });

  it('lets the same host be announced again the next day', async () => {
    const d = await db();
    await seedSeconds(d, 'bilibili.com', 31 * 60);
    expect(await checkDailyLimits(d, NOW)).toHaveLength(1);

    const tomorrow = NOW + 24 * 60 * 60 * 1000;
    await seedSeconds(d, 'bilibili.com', 40 * 60);
    await d.daily.put({ day: dayKeyOf(tomorrow), host: 'bilibili.com', seconds: 40 * 60, visits: 1 });
    expect(await checkDailyLimits(d, tomorrow)).toEqual([
      { host: 'bilibili.com', minutes: 30, seconds: 40 * 60 },
    ]);
  });

  it('prunes marks from other days when it writes', async () => {
    const d = await db();
    await saveActivityPrefs(d, {
      ...(await d.prefs.get('prefs'))!,
      limits: [{ host: 'bilibili.com', minutes: 30 }],
      limitsNotified: { 'bilibili.com': '2026-11-04', 'old.example': '2026-11-03' },
    });
    await seedSeconds(d, 'bilibili.com', 31 * 60);
    await checkDailyLimits(d, NOW);
    const prefs = (await d.prefs.get('prefs'))!;
    expect(prefs.limitsNotified).toEqual({ 'bilibili.com': TODAY });
  });
});

describe('normalizeLimit', () => {
  it('accepts bare hosts and urls, lowercases, clamps minutes to whole days', () => {
    expect(normalizeLimit({ host: ' Bilibili.Com ', minutes: 45 })).toEqual({ host: 'bilibili.com', minutes: 45 });
    expect(normalizeLimit({ host: 'https://www.youtube.com/watch?v=x', minutes: 20 })).toEqual({
      host: 'www.youtube.com',
      minutes: 20,
    });
    // Out of range is refused, not silently clamped: 1500 turning into 1440
    // would be a budget the person did not set.
    expect(normalizeLimit({ host: 'x.example', minutes: 1500 })).toBeNull();
  });

  it('refuses junk', () => {
    expect(normalizeLimit({ host: '', minutes: 30 })).toBeNull();
    expect(normalizeLimit({ host: 'has space.example', minutes: 30 })).toBeNull();
    expect(normalizeLimit({ host: 'x.example', minutes: 0 })).toBeNull();
    expect(normalizeLimit({ host: 'x.example', minutes: 1.5 })).toBeNull();
  });
});
