// Deterministic day rollup: segments → daily × host and day × hour rows.
//
// The aggregates are always REBUILT for a day, never incremented. That is
// what makes the whole reporting pipeline self-healing: a segment closed
// late, an idle mis-attribution, a crash that stretched a duration — the
// next rebuild for that day recomputes the truth from the raw rows, and the
// replace-per-day batch carries the corrected totals to the server. An
// increment-based design would need a ledger of what was already counted;
// the raw segments are the ledger, and they are kept longer than the upload
// window needs.
//
// A rebuild that actually changes a day's totals also re-arms that day's
// upload queue row: a SENT day that received new segments goes back to
// QUEUED (keeping its backoff), so "today" keeps converging on the server
// until the day is over and quiet.

import type { ActivityDB } from './store';
import type { ActivityDailyRecord, ActivityHourlyRecord, ActivitySegmentRecord } from './store';

/** Recompute the aggregates of one local day from its segments.
 *
 * Days older than segment retention cannot be rebuilt (their segments are
 * gone) and are left exactly as last computed — the upload window (14 days)
 * is bounded by segment retention for *corrections*, while a day that was
 * never sent still uploads fine from its aggregates alone.
 *
 * Returns whether the day's totals moved. */
export async function rebuildDay(db: ActivityDB, day: string): Promise<boolean> {
  const segments = await db.segments.where('day').equals(day).toArray();
  const byHost = new Map<string, ActivityDailyRecord>();
  const hours = new Map<number, number>();
  for (const seg of segments) {
    const seconds = Math.max(0, seg.endedAt - seg.startedAt) / 1000;
    const row = byHost.get(seg.host) ?? { day, host: seg.host, seconds: 0, visits: 0 };
    row.seconds += seconds;
    row.visits += 1;
    byHost.set(seg.host, row);
    hours.set(seg.hour, (hours.get(seg.hour) ?? 0) + seconds);
  }
  const daily: ActivityDailyRecord[] = [...byHost.values()]
    .map((r) => ({ ...r, seconds: Math.round(r.seconds) }))
    .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
  const hourly: ActivityHourlyRecord[] = [...hours.entries()]
    .map(([hour, seconds]) => ({ day, hour, seconds: Math.round(seconds) }))
    .sort((a, b) => a.hour - b.hour);

  let changed = false;
  await db.transaction('rw', [db.daily, db.hourly, db.queue], async () => {
    const oldDaily = await db.daily.where('day').equals(day).toArray();
    const oldHourly = await db.hourly.where('day').equals(day).toArray();
    changed = !rowsEqual(oldDaily, daily) || !rowsEqual(oldHourly, hourly);
    if (!changed) return;
    await db.daily.where('day').equals(day).delete();
    await db.hourly.where('day').equals(day).delete();
    await db.daily.bulkPut(daily);
    await db.hourly.bulkPut(hourly);
    // Re-arm the upload for a day whose numbers moved. A QUEUED row is left
    // alone — its backoff gate still applies; only a SENT day flips back.
    const queued = await db.queue.get(day);
    if (!queued || queued.status === 'SENT') {
      await db.queue.put({
        day,
        status: 'QUEUED',
        attempts: queued?.attempts ?? 0,
        nextAttemptAt: queued?.nextAttemptAt ?? 0,
      });
    }
  });
  return changed;
}

function rowsEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  const left = a.map((r) => JSON.stringify(r)).sort();
  const right = b.map((r) => JSON.stringify(r)).sort();
  return left.every((v, i) => v === right[i]);
}

/** Rebuild several days in one pass. */
export async function rebuildDays(db: ActivityDB, days: string[]): Promise<void> {
  for (const day of days) {
    await rebuildDay(db, day);
  }
}

/** The distinct local days that currently hold segment rows. */
export async function daysWithSegments(db: ActivityDB): Promise<string[]> {
  const rows = await db.segments.toArray();
  return [...new Set(rows.map((r) => r.day))].sort();
}

/** Aggregate read for UI: one day's host ranking, seconds descending. */
export async function dayHosts(db: ActivityDB, day: string): Promise<ActivityDailyRecord[]> {
  const rows = await db.daily.where('day').equals(day).toArray();
  return rows.sort((a, b) => b.seconds - a.seconds);
}

/** Aggregate read for UI: total seconds and visits across a day range. */
export async function rangeTotals(
  db: ActivityDB,
  fromDay: string,
  toDay: string,
): Promise<{ seconds: number; visits: number }> {
  const rows = await db.daily.where('day').between(fromDay, toDay, true, true).toArray();
  return rows.reduce(
    (acc, r) => ({ seconds: acc.seconds + r.seconds, visits: acc.visits + r.visits }),
    { seconds: 0, visits: 0 },
  );
}

/** Per-day totals across a range, day ascending — the weekly trend row set. */
export async function rangeByDay(
  db: ActivityDB,
  fromDay: string,
  toDay: string,
): Promise<{ day: string; seconds: number; visits: number }[]> {
  const rows = await db.daily.where('day').between(fromDay, toDay, true, true).toArray();
  const byDay = new Map<string, { day: string; seconds: number; visits: number }>();
  for (const r of rows) {
    const row = byDay.get(r.day) ?? { day: r.day, seconds: 0, visits: 0 };
    row.seconds += r.seconds;
    row.visits += r.visits;
    byDay.set(r.day, row);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

/** URL-level read for the suggestion feature: segments grouped by page URL,
 *  with the latest title seen. Local only — nothing here is uploaded. */
export async function urlVisits(
  db: ActivityDB,
): Promise<{ url: string; title: string; host: string; visits: number; days: Set<string> }[]> {
  const segments = await db.segments.toArray();
  const byUrl = new Map<string, { url: string; title: string; host: string; visits: number; days: Set<string> }>();
  for (const seg of segments) {
    const row = byUrl.get(seg.url) ?? { url: seg.url, title: seg.title, host: seg.host, visits: 0, days: new Set<string>() };
    row.visits += 1;
    if (seg.title) row.title = seg.title;
    row.days.add(seg.day);
    byUrl.set(seg.url, row);
  }
  return [...byUrl.values()];
}
