// Local activity store — a Dexie database of its own, apart from the
// bookmark replica (`pontis-replica`).
//
// Two reasons for the split. The replica's schema versions exist to serve the
// sync engine's watermarks; activity rows have a completely different
// lifecycle (write often, age out, wipe at will) and must never share a
// migration chain with something whose integrity the sync engine assumes.
// And "clear browsing statistics" has to mean one `delete()`, not a careful
// dance around tables the replica still needs.
//
// The same MV3 rule applies as everywhere else (doc 05 §1): the service
// worker may be killed at any await, so the current dwell segment is
// persisted on every event and the tracker resumes from the row, not from
// memory.

import Dexie, { type Table } from 'dexie';

/** Raw URL-level dwell episodes. Local only — this table is never uploaded. */
export interface ActivitySegmentRecord {
  id?: number;
  startedAt: number;
  endedAt: number;
  /** Full hostname, lowercased, no port. */
  host: string;
  /** Full page URL. Stays on this device; the bookmark suggestions need it. */
  url: string;
  title: string;
  /** Local calendar day of `startedAt` ('YYYY-MM-DD'). */
  day: string;
  /** Local clock hour of `startedAt` (0-23): the hourly histogram attributes
   *  a segment to the hour it began. A segment is capped well under an hour,
   *  so the worst drift is that cap. */
  hour: number;
}

/** Day × host aggregate: the local view the popup-level UI reads and the
 *  upload entry is built from. Deterministically rebuilt from segments, so
 *  corrections (idle mis-attribution, a late close) self-heal. */
export interface ActivityDailyRecord {
  day: string;
  host: string;
  seconds: number;
  visits: number;
}

/** Day × hour attention seconds, host-agnostic. Uploaded with the day. */
export interface ActivityHourlyRecord {
  day: string;
  hour: number;
  seconds: number;
}

export type ActivityQueueStatus = 'QUEUED' | 'SENT';

/**
 * One row per day that owes the server a batch entry. The payload is not
 * stored here: a replace-per-day batch is rebuilt from the aggregates at
 * send time, so a day re-sent after a correction carries the freshest
 * totals rather than a frozen snapshot.
 */
export interface ActivityQueueRecord {
  day: string;
  status: ActivityQueueStatus;
  attempts: number;
  /** Backoff gate: earliest epoch ms the next flush may retry this day. */
  nextAttemptAt: number;
  lastError?: string;
  sentAt?: number;
}

/** The one open dwell segment. Exactly one row, id 'current'. */
export interface ActivityCurrentState {
  id: 'current';
  host: string;
  url: string;
  title: string;
  tabId: number;
  startedAt: number;
  lastBeatAt: number;
}

export type ActivityMode = 'off' | 'local' | 'upload';

export interface ActivityPrefsRecord {
  id: 'prefs';
  /**
   * 'local' out of the box: counting starts immediately, but nothing leaves
   * the device until the person switches this to 'upload' themselves.
   * A tracking default that includes the network is not ours to make.
   */
  mode: ActivityMode;
  /** Hosts that are never recorded, not even locally. */
  blocklist: string[];
  /** Raw segment retention in days (URL-level data, the sensitive tier). */
  segmentRetentionDays: number;
  /** Day-aggregate retention in days (also bounds what the server holds:
   *  days that fall off locally stop being re-sent, and the server GCs
   *  older rows on its own schedule). */
  aggregateRetentionDays: number;
  updatedAt: number;
}

export const DEFAULT_SEGMENT_RETENTION_DAYS = 14;
export const DEFAULT_AGGREGATE_RETENTION_DAYS = 180;

export function defaultActivityPrefs(): ActivityPrefsRecord {
  return {
    id: 'prefs',
    mode: 'local',
    blocklist: [],
    segmentRetentionDays: DEFAULT_SEGMENT_RETENTION_DAYS,
    aggregateRetentionDays: DEFAULT_AGGREGATE_RETENTION_DAYS,
    updatedAt: 0,
  };
}

/** Local calendar day of an epoch-ms instant, in the device's timezone. */
export function dayKeyOf(ts: number, now = new Date(ts)): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Local clock hour of an epoch-ms instant. */
export function hourOf(ts: number, now = new Date(ts)): number {
  return now.getHours();
}

export class ActivityDB extends Dexie {
  segments!: Table<ActivitySegmentRecord, number>;
  daily!: Table<ActivityDailyRecord, [string, string]>;
  hourly!: Table<ActivityHourlyRecord, [string, number]>;
  queue!: Table<ActivityQueueRecord, string>;
  state!: Table<ActivityCurrentState, string>;
  prefs!: Table<ActivityPrefsRecord, string>;

  constructor(name = 'pontis-activity') {
    super(name);
    this.version(1).stores({
      segments: '++id, day, startedAt',
      daily: '[day+host], day',
      hourly: '[day+hour], day',
      // The flush walks QUEUED rows by backoff gate; SENT rows linger only
      // until retention prunes them.
      queue: 'day, status, nextAttemptAt',
      state: 'id',
      prefs: 'id',
    });
  }
}

/** Read the prefs row, creating the default on first touch. */
export async function loadActivityPrefs(db: ActivityDB): Promise<ActivityPrefsRecord> {
  const row = await db.prefs.get('prefs');
  if (row) return row;
  const fresh = defaultActivityPrefs();
  await db.prefs.put(fresh);
  return fresh;
}

export async function saveActivityPrefs(db: ActivityDB, prefs: ActivityPrefsRecord): Promise<void> {
  await db.prefs.put({ ...prefs, id: 'prefs', updatedAt: Date.now() });
}

/**
 * Age out rows past retention. Segments (URL-level) go first and youngest:
 * they are the sensitive tier and only the suggestion feature needs them.
 * Aggregates are the long-lived tier the analysis page is built from.
 * Returns the number of rows removed, for a diagnostics line.
 */
export async function purgeActivityBefore(
  db: ActivityDB,
  segmentCutoffTs: number,
  aggregateCutoffDay: string,
): Promise<{ segments: number; daily: number; hourly: number }> {
  const oldSegments = await db.segments.where('startedAt').below(segmentCutoffTs).primaryKeys();
  await db.segments.bulkDelete(oldSegments);
  const oldDaily = await db.daily.where('day').below(aggregateCutoffDay).primaryKeys();
  await db.daily.bulkDelete(oldDaily);
  const oldHourly = await db.hourly.where('day').below(aggregateCutoffDay).primaryKeys();
  await db.hourly.bulkDelete(oldHourly);
  return { segments: oldSegments.length, daily: oldDaily.length, hourly: oldHourly.length };
}

/** Drop everything local. The options page's 清除统计数据 button. */
export async function clearActivityData(db: ActivityDB): Promise<void> {
  await db.transaction('rw', [db.segments, db.daily, db.hourly, db.queue, db.state], async () => {
    await Promise.all([
      db.segments.clear(),
      db.daily.clear(),
      db.hourly.clear(),
      db.queue.clear(),
      db.state.clear(),
    ]);
  });
}
