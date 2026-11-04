// The dwell tracker: turns tab/window/idle events into "who was on top"
// segments, persisted through every transition.
//
// The model is a single open segment — one row, id 'current' — naming the
// host the person is actually looking at. Every relevant event re-resolves
// the active tab and either extends the segment (same host), rotates it
// (different host: close one row into `segments`, open the next) or clears
// it (browser unfocused, idle, locked, or a host on the blocklist). MV3 can
// kill the worker between any two events, so nothing lives only in memory:
// the wake path treats "heartbeat older than grace" as "I was asleep" and
// closes the stale segment at its last confirmed beat instead of claiming
// the sleep as browsing.
//
// Attribution rules, on purpose:
// - only the focused window's active tab counts (background tabs are not
//   attention, and multi-window simultaneity is not worth the ambiguity);
// - idle or locked closes the segment at the moment the state fires — up to
//   the detection interval of "reading without input" stays counted, the
//   same trade the reference trackers make;
// - a segment is capped at MAX_SEGMENT_MS so a lost close event can never
//   bill one row for an afternoon;
// - a segment shorter than MIN_SEGMENT_MS is discarded: tab flicking is
//   noise, and it is what keeps the raw row count human.

import {
  ActivityDB,
  dayKeyOf,
  hourOf,
  loadActivityPrefs,
  purgeActivityBefore,
  type ActivityCurrentState,
  type ActivityPrefsRecord,
  type ActivitySegmentRecord,
} from './store';
import { rebuildDay } from './aggregate';

/** A dwell episode shorter than this is not recorded at all. */
export const MIN_SEGMENT_MS = 2_000;

/** Hard cap on one segment: bounds the error of a close event that never
 *  arrived, and keeps day attribution within the hour it started in. */
export const MAX_SEGMENT_MS = 15 * 60 * 1000;

/** The heartbeat alarm runs every minute. A beat older than this means the
 *  worker was dead (OS sleep, browser closed) — the stretch after the last
 *  confirmed beat is not billed. */
export const HEARTBEAT_GRACE_MS = 90_000;

/** How often the wake path runs retention purge at most. */
export const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;

/** A structural slice of the chrome APIs the tracker touches — no more than
 *  it needs, so a test can fake the whole surface in a few lines. */
export interface ChromeEventLike<T extends (...args: never[]) => void> {
  addListener(cb: T): void;
  removeListener(cb: T): void;
}

export interface ActivityTabInfo {
  id: number;
  url?: string;
  title?: string;
  incognito?: boolean;
}

export interface ActivityChromeApi {
  tabs: {
    onActivated: ChromeEventLike<(info: { tabId: number; windowId: number }) => void>;
    onUpdated: ChromeEventLike<(tabId: number, changeInfo: { url?: string }) => void>;
    onRemoved: ChromeEventLike<(tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void>;
    query(info: { active: true; lastFocusedWindow: true }): Promise<ActivityTabInfo[]>;
  };
  windows: {
    WINDOW_ID_NONE: number;
    onFocusChanged: ChromeEventLike<(windowId: number) => void>;
  };
  idle: {
    setDetectionInterval(periodSeconds: number): void;
    onStateChanged: ChromeEventLike<(state: 'active' | 'idle' | 'locked') => void>;
  };
}

/** The hostname a tab is worth counting for, or null when it is not:
 *  incognito, non-web schemes, an unparseable url, or a host the person
 *  put on the blocklist. */
export function trackableHost(
  tab: ActivityTabInfo | null | undefined,
  blocklist: readonly string[],
): string | null {
  if (!tab || tab.incognito) return null;
  const raw = tab.url ?? '';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  if (blocklist.includes(host)) return null;
  return host;
}

/** A segment worth one row. Exported for tests. */
export function segmentFrom(state: ActivityCurrentState, endedAt: number): ActivitySegmentRecord | null {
  const ended = Math.max(state.startedAt, Math.min(endedAt, state.startedAt + MAX_SEGMENT_MS));
  if (ended - state.startedAt < MIN_SEGMENT_MS) return null;
  return {
    startedAt: state.startedAt,
    endedAt: ended,
    host: state.host,
    url: state.url,
    title: state.title,
    day: dayKeyOf(state.startedAt, new Date(state.startedAt)),
    hour: hourOf(state.startedAt, new Date(state.startedAt)),
  };
}

export class ActivityTracker {
  private unsubs: Array<() => void> = [];
  private lastPurgeAt = 0;
  /** In-flight event handlers, so a test can await the settle of every
   *  operation the wired events kicked off (`drain`). */
  private ops = new Set<Promise<void>>();

  constructor(
    private db: ActivityDB,
    private chrome: ActivityChromeApi,
    private now: () => number = Date.now,
  ) {}

  /** Wire the browser events and take an initial reading. Idempotent per
   *  worker: each worker instance wires its own listeners exactly once. */
  start(): void {
    this.chrome.idle.setDetectionInterval(60);
    const on = <T extends (...args: never[]) => void>(
      event: ChromeEventLike<T>,
      handler: T,
    ): void => {
      event.addListener(handler);
      this.unsubs.push(() => event.removeListener(handler));
    };
    const run = (op: Promise<void>): void => {
      this.ops.add(op);
      void op.finally(() => this.ops.delete(op));
    };

    on(this.chrome.tabs.onActivated, () => run(this.resolveAndTrack()));
    // URL changes cover the "clicked a link to another host in the same tab"
    // case; same-host navigations land in the same-host branch and only
    // refresh the stored url/title.
    on(this.chrome.tabs.onUpdated, (_tabId, changeInfo) => {
      if (changeInfo.url !== undefined) run(this.resolveAndTrack());
    });
    on(this.chrome.tabs.onRemoved, (tabId) => run(this.onTabRemoved(tabId)));
    on(this.chrome.windows.onFocusChanged, (windowId) => {
      if (windowId === this.chrome.windows.WINDOW_ID_NONE) {
        run(this.closeCurrent(this.now()));
        return;
      }
      run(this.resolveAndTrack());
    });
    on(this.chrome.idle.onStateChanged, (state) => {
      if (state === 'active') run(this.resolveAndTrack());
      else run(this.closeCurrent(this.now()));
    });

    run(this.wake());
  }

  stop(): void {
    for (const off of this.unsubs) off();
    this.unsubs = [];
  }

  /** Resolves when every operation the events (and the initial wake) kicked
   *  off has settled. The worker never calls this; tests do, because the
   *  browser event handlers are fire-and-forget by design. */
  async drain(): Promise<void> {
    while (this.ops.size > 0) {
      await Promise.all([...this.ops]);
    }
  }

  /**
   * One alarm tick. Doubles as the wake path after a worker kill: both are
   * "some time passed unobserved — reconcile the persisted segment with the
   * world and run whatever housekeeping came due".
   */
  async onHeartbeat(): Promise<void> {
    await this.wake();
  }

  private async wake(): Promise<void> {
    const prefs = await loadActivityPrefs(this.db);
    const current = await this.db.state.get('current');
    const ts = this.now();
    if (current) {
      // A stale beat means the worker died since the last confirmed beat: the
      // stretch after it is not attributable, so the segment settles at the
      // beat before the world is re-read. An over-cap segment (someone parked
      // on one host for ages) rotates for a different reason: the hourly
      // histogram attributes a segment to its starting hour, so letting one
      // run all afternoon would bury the whole day under 10am.
      const stale = ts - current.lastBeatAt > HEARTBEAT_GRACE_MS;
      const capped = ts - current.startedAt >= MAX_SEGMENT_MS;
      if (stale || capped) {
        await this.closeCurrent(stale ? current.lastBeatAt : ts);
      }
    }
    await this.resolveAndTrack(prefs);
    await this.purgeIfNeeded(prefs);
  }

  /** Read the browser's actual top tab and continue / rotate / clear. */
  private async resolveAndTrack(prefsHint?: ActivityPrefsRecord): Promise<void> {
    const prefs = prefsHint ?? (await loadActivityPrefs(this.db));
    if (prefs.mode === 'off') {
      await this.closeCurrent(this.now());
      return;
    }
    let tab: ActivityTabInfo | null = null;
    try {
      const [active] = await this.chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tab = active ?? null;
    } catch {
      tab = null; // no focused window, or the query raced a window close
    }
    await this.continueOrRotate(tab, prefs);
  }

  private async continueOrRotate(tab: ActivityTabInfo | null, prefs: ActivityPrefsRecord): Promise<void> {
    const host = trackableHost(tab, prefs.blocklist);
    const current = await this.db.state.get('current');
    const ts = this.now();
    if (!host) {
      if (current) await this.closeCurrent(ts);
      return;
    }
    if (current && current.host === host) {
      // Same host, possibly a different tab of it or a navigation within it:
      // one continuous episode of attention on this host.
      const next: ActivityCurrentState = {
        ...current,
        tabId: tab?.id ?? current.tabId,
        url: tab?.url ?? current.url,
        title: tab?.title ?? current.title,
        lastBeatAt: ts,
      };
      await this.db.state.put(next);
      return;
    }
    if (current) await this.closeCurrent(ts);
    await this.db.state.put({
      id: 'current',
      host,
      url: tab?.url ?? '',
      title: tab?.title ?? '',
      tabId: tab?.id ?? -1,
      startedAt: ts,
      lastBeatAt: ts,
    });
  }

  private async onTabRemoved(tabId: number): Promise<void> {
    const current = await this.db.state.get('current');
    if (!current || current.tabId !== tabId) return;
    await this.closeCurrent(this.now());
    // Closing a tab activates its neighbour; pick it up the same tick.
    await this.resolveAndTrack();
  }

  /** Settle the open segment into a row (or discard it as too short) and
   *  clear the current marker. `endAt` may be in the past: the wake path
   *  closes at the last confirmed beat. */
  private async closeCurrent(endAt: number): Promise<void> {
    const current = await this.db.state.get('current');
    if (!current) return;
    await this.db.state.delete('current');
    const seg = segmentFrom(current, endAt);
    if (!seg) return;
    await this.db.segments.add(seg);
    await rebuildDay(this.db, seg.day);
  }

  private async purgeIfNeeded(prefs: ActivityPrefsRecord): Promise<void> {
    const ts = this.now();
    if (ts - this.lastPurgeAt < PURGE_EVERY_MS) return;
    this.lastPurgeAt = ts;
    const segCutoff = ts - prefs.segmentRetentionDays * 24 * 60 * 60 * 1000;
    const aggCutoff = dayKeyOf(ts - prefs.aggregateRetentionDays * 24 * 60 * 60 * 1000);
    await purgeActivityBefore(this.db, segCutoff, aggCutoff);
  }
}
