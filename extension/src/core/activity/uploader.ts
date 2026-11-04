// The flush path: local day aggregates → replace-per-day batches on the
// server.
//
// Replace-per-day is the load-bearing decision. A batch entry for a day
// carries that day's COMPLETE current totals, and the server swaps its
// stored rows for (device, day) in one transaction. Re-sending a day is
// therefore always safe — there is no ledger of already-counted seconds to
// get out of step, a day corrected locally converges on the server at the
// next flush, and a batch that reached the server but whose ack was lost is
// repaired by the retry instead of duplicated.
//
// Failures are per-day queue rows with attempts and a backoff gate, so one
// unreachable server cannot wedge the whole pipeline: the flush keeps
// finding the same rows, waits out the gate, and tries again on the next
// sync-alarm piggyback.

import {
  MAX_DAYS_PER_BATCH,
  MAX_HOSTS_PER_DAY,
  type ActivityBatchWire,
  type ActivityDayWire,
  type ActivityHourWire,
  type ActivityHostWire,
} from './wire';
import type { ActivityDB, ActivityQueueRecord } from './store';

/** Transport contract consumed by the flush (mockable), as implemented by
 *  ApiClient. */
export interface ActivityTransport {
  uploadActivityBatch(req: ActivityBatchWire): Promise<{ results: { day: string; status: 'accepted' }[] }>;
}

export interface FlushGate {
  /** Upload is a mode the person chose; anything else never touches the network. */
  mode: 'off' | 'local' | 'upload';
  /** A device credential must exist: unpaired devices have nowhere to send. */
  paired: boolean;
}

export interface FlushOutcome {
  sent: string[];
  failed: { day: string; error: string }[];
  /** Why nothing was attempted, when nothing was. */
  skipped: 'mode' | 'unpaired' | 'empty' | null;
}

/** Retry delay after the Nth consecutive failure of a day. Grows fast
 *  enough to stop hammering a downed server, caps low enough that a device
 *  back from offline catches up within a couple of flush piggybacks. */
export function retryDelayMs(attempts: number): number {
  const step = Math.min(attempts, 5);
  return Math.min(15 * 60 * 1000, (1 << step) * 30 * 1000);
}

/**
 * Build and send at most one batch of due days. Called from the background
 * on the sync alarm, on startup, and after tracking events left work behind;
 * each call drains up to MAX_DAYS_PER_BATCH days, so a long backlog drains
 * over consecutive ticks.
 */
export async function flushActivity(
  db: ActivityDB,
  transport: ActivityTransport,
  gate: FlushGate,
  now = Date.now(),
): Promise<FlushOutcome> {
  if (gate.mode !== 'upload') return { sent: [], failed: [], skipped: 'mode' };
  if (!gate.paired) return { sent: [], failed: [], skipped: 'unpaired' };

  const due = (await db.queue.where('status').equals('QUEUED').toArray())
    .filter((row) => row.nextAttemptAt <= now)
    .sort((a, b) => (a.day < b.day ? -1 : 1))
    .slice(0, MAX_DAYS_PER_BATCH);
  if (due.length === 0) return { sent: [], failed: [], skipped: 'empty' };

  const days: ActivityDayWire[] = [];
  for (const row of due) {
    const entry = await buildDayEntry(db, row.day);
    if (entry) days.push(entry);
  }
  if (days.length === 0) return { sent: [], failed: [], skipped: 'empty' };

  try {
    const ack = await transport.uploadActivityBatch({ days });
    const acked = new Set(ack.results.map((r) => r.day));
    const sent: string[] = [];
    const failed: { day: string; error: string }[] = [];
    for (const row of due) {
      if (acked.has(row.day)) {
        await db.queue.put({ ...row, status: 'SENT', sentAt: now, lastError: undefined });
        sent.push(row.day);
      } else {
        // The server answers for every day it accepted; a day missing from
        // the ack is a refusal we must not mark as done.
        const err = `server acknowledged ${acked.size}/${due.length} days`;
        await failDay(db, row, err, now);
        failed.push({ day: row.day, error: err });
      }
    }
    return { sent, failed, skipped: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const failed: { day: string; error: string }[] = [];
    for (const row of due) {
      await failDay(db, row, message, now);
      failed.push({ day: row.day, error: message });
    }
    return { sent: [], failed, skipped: null };
  }
}

async function failDay(db: ActivityDB, row: ActivityQueueRecord, message: string, now: number): Promise<void> {
  const attempts = row.attempts + 1;
  await db.queue.put({
    ...row,
    status: 'QUEUED',
    attempts,
    nextAttemptAt: now + retryDelayMs(attempts),
    lastError: message.slice(0, 300),
  });
}

/** Assemble one day's wire entry from the local aggregates. Hosts beyond
 *  MAX_HOSTS_PER_DAY are dropped from the tail: they are the long tail of
 *  seconds, and the cap is what bounds a batch for a pathological day. */
async function buildDayEntry(db: ActivityDB, day: string): Promise<ActivityDayWire | null> {
  const dailyRows = await db.daily.where('day').equals(day).toArray();
  const hourlyRows = await db.hourly.where('day').equals(day).toArray();
  if (dailyRows.length === 0) return null;
  dailyRows.sort((a, b) => b.seconds - a.seconds);
  const hosts: ActivityHostWire[] = dailyRows
    .slice(0, MAX_HOSTS_PER_DAY)
    .map((r) => ({ host: r.host, seconds: r.seconds, visits: r.visits }));
  const hours: ActivityHourWire[] = hourlyRows
    .slice()
    .sort((a, b) => a.hour - b.hour)
    .map((r) => ({ hour: r.hour, seconds: r.seconds }));
  return { day, hosts, hours };
}
