// Daily budget checking — the "限额提醒" half of the activity feature.
//
// The philosophy is the one the whole subsystem runs on: local judgment,
// minimal interruption. A limit is a number a person set for themselves;
// the check runs from the tracker's one-minute heartbeat; and the output is
// at most one notification per host per day. Nothing blocks, nothing
// uploads, and a host that never crosses its budget costs nothing.
//
// The notification permission behind this is OPTIONAL and requested at
// runtime, inside the click that adds the first limit — see wxt.config.ts
// and the settings page copy, both of which name the single purpose.

import {
  dayKeyOf,
  loadActivityPrefs,
  saveActivityPrefs,
  type ActivityDB,
  type ActivityHostLimit,
} from './store';

/** One budget that was crossed today. */
export interface LimitHit {
  host: string;
  minutes: number;
  /** Seconds actually spent today, open segment included. */
  seconds: number;
}

/** Turn what the add-limit form holds into a storable row, or null when the
 *  input is not a usable host+minutes pair. */
export function normalizeLimit(raw: { host: string; minutes: number }): ActivityHostLimit | null {
  let host = raw.host.trim().toLowerCase().replace(/\.$/, '');
  if (/^[a-z]+:\/\//.test(host)) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  if (!host || host.includes('/') || host.includes(' ') || host.length > 253) return null;
  // Whole minutes only: half-minute budgets are precision the heartbeat's
  // one-minute cadence cannot honour anyway.
  if (!Number.isInteger(raw.minutes) || raw.minutes < 1 || raw.minutes > 24 * 60) return null;
  return { host, minutes: raw.minutes };
}

/**
 * Which of the stored limits crossed their budget today and have not been
 * announced yet. Called from the heartbeat, so the open segment's running
 * time counts: the point of the reminder is to land while the person is
 * still on the site, not after the segment closes.
 *
 * Marks what it returns in the prefs row, so a second heartbeat ten seconds
 * later cannot nag again — the dedupe is durable because the worker can be
 * replaced at any moment and "already told them today" is a fact worth
 * surviving that.
 */
export async function checkDailyLimits(db: ActivityDB, now = Date.now()): Promise<LimitHit[]> {
  const prefs = await loadActivityPrefs(db);
  const limits = prefs.limits ?? [];
  if (limits.length === 0) return [];
  const today = dayKeyOf(now, new Date(now));
  const notified = prefs.limitsNotified ?? {};

  const dailyRows = await db.daily.where('day').equals(today).toArray();
  const secondsByHost = new Map(dailyRows.map((r) => [r.host, r.seconds]));
  const current = await db.state.get('current');

  const hits: LimitHit[] = [];
  const marked = { ...notified };
  for (const limit of limits) {
    if (notified[limit.host] === today) continue;
    let seconds = secondsByHost.get(limit.host) ?? 0;
    if (current?.host === limit.host) {
      seconds += Math.max(0, now - current.startedAt) / 1000;
    }
    if (seconds >= limit.minutes * 60) {
      hits.push({ host: limit.host, minutes: limit.minutes, seconds: Math.round(seconds) });
      marked[limit.host] = today;
    }
  }
  if (hits.length === 0) return [];

  // Keep only today's marks: yesterday's are noise the map never needs again.
  const pruned = Object.fromEntries(Object.entries(marked).filter(([, day]) => day === today));
  await saveActivityPrefs(db, { ...prefs, limitsNotified: pruned });
  return hits;
}
