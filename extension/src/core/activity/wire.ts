// Activity wire protocol: the only shape that ever leaves this device.
//
// The privacy line is drawn here, in the type itself: a day entry carries a
// host label, a second count and a visit count, plus a host-agnostic hourly
// histogram. There is no URL field, no title, no favicon — those live only in
// the local segment rows, and an uploader that wanted more would have to
// invent a new type rather than widen this one.
//
// Like core/protocol, the types mirror the Go server's DTO by convention and
// the response is validated at the HTTP boundary (parseActivityBatchAck), so
// a malformed body cannot reach the code that marks a day as uploaded.

/** At most this many days ride in one batch: a device returning after a
 *  month offline still splits its catch-up, and one oversized request can
 *  never hold the whole queue hostage. */
export const MAX_DAYS_PER_BATCH = 14;

/** At most this many host rows in one day entry. A day touched by more hosts
 *  than this is truncated client-side (the long tail is seconds, not hours). */
export const MAX_HOSTS_PER_DAY = 500;

/** A host label is a hostname, not a URL: this is the length of the longest
 *  hostname DNS allows, and the server refuses anything longer. */
export const MAX_HOST_LENGTH = 253;

export interface ActivityHostWire {
  /** Full hostname, lowercased, no port, no scheme, no path. */
  host: string;
  /** Total dwell seconds attributed to the host that day. */
  seconds: number;
  /** Distinct dwell episodes (a tab switch back counts again). */
  visits: number;
}

export interface ActivityHourWire {
  /** 0-23, local clock of this device. */
  hour: number;
  /** Attention seconds across all hosts — enough for a time-of-day view
   *  without attaching a host to a clock position. */
  seconds: number;
}

/** One local day, complete: the server REPLACES its stored rows for
 *  (device, day) with this entry, so re-sending a day is always safe. */
export interface ActivityDayWire {
  /** `YYYY-MM-DD`, the device's local calendar day. */
  day: string;
  hosts: ActivityHostWire[];
  hours: ActivityHourWire[];
  /**
   * Focus metrics for the day, optional so an older uploader stays
   * wire-compatible. `switches` counts tab activations the tracker saw;
   * `longest_focus_seconds` is the longest single dwell episode — both are
   * attention-quality readouts, not another way to name a host.
   */
  switches?: number;
  longest_focus_seconds?: number;
}

export interface ActivityBatchWire {
  days: ActivityDayWire[];
}

export interface ActivityBatchAckWire {
  results: { day: string; status: 'accepted' }[];
}

export class ActivityWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActivityWireError';
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ActivityWireError(`field "${field}" must be a string`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ActivityWireError(`field "${field}" must be a finite number`);
  }
  return value;
}

/** Assert an ingest answer names every day the batch carried. A day missing
 *  from the ack stays unsent, so the next flush rebuilds and re-sends it. */
export function parseActivityBatchAck(json: unknown): ActivityBatchAckWire {
  if (json == null || typeof json !== 'object') {
    throw new ActivityWireError('activity ack must be an object');
  }
  const body = json as Record<string, unknown>;
  if (!Array.isArray(body.results)) {
    throw new ActivityWireError('activity ack field "results" must be an array');
  }
  for (const r of body.results) {
    if (r == null || typeof r !== 'object') {
      throw new ActivityWireError('activity ack contains a non-object result');
    }
    const row = r as Record<string, unknown>;
    requireString(row.day, 'result.day');
    if (row.status !== 'accepted') {
      throw new ActivityWireError(`activity ack result status must be "accepted"`);
    }
  }
  return json as ActivityBatchAckWire;
}
