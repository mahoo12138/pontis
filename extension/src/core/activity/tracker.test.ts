// Tracker state machine tests: a fake tabs/windows/idle surface and a
// deterministic clock, asserting what lands in the activity database.
//
// Every scenario follows the same shape the MV3 worker lives in: events
// arrive, the tracker persists, the worker may be replaced between any two
// of them — so the assertions always read IndexedDB, never tracker memory.

import { describe, expect, it } from 'vitest';

import { ActivityDB, dayKeyOf, defaultActivityPrefs, saveActivityPrefs } from './store';
import {
  ActivityTracker,
  HEARTBEAT_GRACE_MS,
  MAX_SEGMENT_MS,
  trackableHost,
  type ActivityChromeApi,
  type ActivityTabInfo,
} from './tracker';

function eventLike<T extends (...args: never[]) => void>() {
  const listeners = new Set<T>();
  return {
    addListener: (cb: T) => listeners.add(cb),
    removeListener: (cb: T) => listeners.delete(cb),
    fire: (...args: Parameters<T>) => {
      for (const l of listeners) l(...args);
    },
  };
}

function fakeChrome() {
  const activated = eventLike<(info: { tabId: number; windowId: number }) => void>();
  const updated = eventLike<(tabId: number, changeInfo: { url?: string }) => void>();
  const removed = eventLike<(tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void>();
  const focus = eventLike<(windowId: number) => void>();
  const idle = eventLike<(state: 'active' | 'idle' | 'locked') => void>();
  let activeTab: ActivityTabInfo | null = null;
  const api: ActivityChromeApi = {
    tabs: {
      onActivated: activated,
      onUpdated: updated,
      onRemoved: removed,
      query: async () => (activeTab ? [activeTab] : []),
    },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: focus },
    idle: { setDetectionInterval: () => {}, onStateChanged: idle },
  };
  return {
    api,
    setActive: (tab: ActivityTabInfo | null) => {
      activeTab = tab;
    },
    fireActivated: activated.fire,
    fireUpdated: updated.fire,
    fireRemoved: removed.fire,
    fireFocus: focus.fire,
    fireIdle: idle.fire,
  };
}

/** Local-time base instant: 2026-11-04 10:00:00, whatever the TZ. */
const T0 = new Date(2026, 10, 4, 10, 0, 0).getTime();
const DAY = dayKeyOf(T0);

interface Fixture {
  db: ActivityDB;
  chrome: ReturnType<typeof fakeChrome>;
  tracker: ActivityTracker;
  nowMs: number;
  advance(ms: number): void;
}

async function fixture(blocklist: string[] = [], mode: 'off' | 'local' | 'upload' = 'local'): Promise<Fixture> {
  const db = new ActivityDB(`test-tracker-${Math.random().toString(36).slice(2)}`);
  await saveActivityPrefs(db, { ...defaultActivityPrefs(), blocklist, mode });
  const chrome = fakeChrome();
  let nowMs = T0;
  const tracker = new ActivityTracker(db, chrome.api, () => nowMs);
  return {
    db,
    chrome,
    tracker,
    get nowMs() {
      return nowMs;
    },
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

const tab = (id: number, url: string, extra: Partial<ActivityTabInfo> = {}): ActivityTabInfo => ({
  id,
  url,
  title: `page ${id}`,
  ...extra,
});

describe('trackableHost', () => {
  it('accepts http(s) hosts and lowercases them', () => {
    expect(trackableHost(tab(1, 'https://GitHub.Example/a'), [])).toBe('github.example');
    expect(trackableHost(tab(1, 'http://github.example/'), [])).toBe('github.example');
  });

  it('refuses non-web schemes, unparseable urls, incognito and blocklisted hosts', () => {
    expect(trackableHost(tab(1, 'chrome://newtab'), [])).toBeNull();
    expect(trackableHost(tab(1, 'not a url'), [])).toBeNull();
    expect(trackableHost(tab(1, 'https://github.example/', { incognito: true }), [])).toBeNull();
    expect(trackableHost(tab(1, 'https://bank.example/'), ['bank.example'])).toBeNull();
    expect(trackableHost(null, [])).toBeNull();
  });
});

describe('ActivityTracker', () => {
  it('opens a segment on activation and settles it when the host rotates', async () => {
    const f = await fixture();
    f.chrome.setActive(tab(1, 'https://github.com/pontis'));
    f.tracker.start();
    await f.tracker.drain();
    expect((await f.db.state.get('current'))?.host).toBe('github.com');

    f.advance(30_000);
    f.chrome.setActive(tab(2, 'https://gitlab.com/x'));
    f.chrome.fireActivated({ tabId: 2, windowId: 1 });
    await f.tracker.drain();

    const segments = await f.db.segments.toArray();
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ host: 'github.com', startedAt: T0, endedAt: T0 + 30_000, day: DAY });
    expect((await f.db.state.get('current'))?.host).toBe('gitlab.com');

    const daily = await f.db.daily.toArray();
    expect(daily).toEqual([{ day: DAY, host: 'github.com', seconds: 30, visits: 1 }]);
    expect(await f.db.hourly.toArray()).toEqual([{ day: DAY, hour: 10, seconds: 30 }]);
    f.tracker.stop();
  });

  it('keeps one episode across same-host navigations, refreshing url and title', async () => {
    const f = await fixture();
    f.chrome.setActive(tab(1, 'https://github.com/a'));
    f.tracker.start();
    await f.tracker.drain();
    f.advance(10_000);
    f.chrome.setActive(tab(1, 'https://github.com/b'));
    f.chrome.fireUpdated(1, { url: 'https://github.com/b' });
    await f.tracker.drain();

    f.advance(10_000);
    f.chrome.setActive(tab(2, 'https://gitlab.com/'));
    f.chrome.fireActivated({ tabId: 2, windowId: 1 });
    await f.tracker.drain();

    const segments = await f.db.segments.toArray();
    expect(segments).toHaveLength(1);
    // One episode, one visit, carrying the LAST url seen on the host.
    expect(segments[0]).toMatchObject({ host: 'github.com', url: 'https://github.com/b', endedAt: T0 + 20_000 });
    expect((await f.db.daily.get([DAY, 'github.com']))?.visits).toBe(1);
    f.tracker.stop();
  });

  it('never records incognito, internal pages or blocklisted hosts', async () => {
    const f = await fixture(['secret.example']);
    f.chrome.setActive(tab(1, 'https://secret.example/'));
    f.tracker.start();
    await f.tracker.drain();
    f.chrome.setActive(tab(1, 'chrome://newtab'));
    f.chrome.fireUpdated(1, { url: 'chrome://newtab' });
    await f.tracker.drain();
    f.chrome.setActive(tab(1, 'https://private.example/', { incognito: true }));
    f.chrome.fireActivated({ tabId: 1, windowId: 1 });
    await f.tracker.drain();

    expect(await f.db.state.get('current')).toBeUndefined();
    expect(await f.db.segments.count()).toBe(0);
    f.tracker.stop();
  });

  it('closes the segment on idle and on losing window focus', async () => {
    const f = await fixture();
    f.chrome.setActive(tab(1, 'https://github.com/'));
    f.tracker.start();
    await f.tracker.drain();
    f.advance(60_000);
    f.chrome.fireIdle('idle');
    await f.tracker.drain();
    expect(await f.db.state.get('current')).toBeUndefined();
    expect((await f.db.segments.toArray())[0]).toMatchObject({ endedAt: T0 + 60_000 });

    // Attention returns, then the whole browser loses focus.
    f.chrome.setActive(tab(1, 'https://github.com/'));
    f.chrome.fireIdle('active');
    await f.tracker.drain();
    expect((await f.db.state.get('current'))?.host).toBe('github.com');
    f.advance(5_000);
    f.chrome.fireFocus(-1);
    await f.tracker.drain();
    expect(await f.db.state.get('current')).toBeUndefined();
    expect(await f.db.segments.count()).toBe(2);
    f.tracker.stop();
  });

  it('caps a segment at MAX_SEGMENT_MS and reopens the same host', async () => {
    const f = await fixture();
    f.chrome.setActive(tab(1, 'https://github.com/'));
    f.tracker.start();
    await f.tracker.drain();
    // Sixteen minutes of real heartbeats: the beat stays fresh the whole
    // time, so only the cap can rotate the segment.
    for (let i = 0; i < 16; i += 1) {
      f.advance(60_000);
      await f.tracker.onHeartbeat();
    }

    const segments = await f.db.segments.toArray();
    expect(segments).toHaveLength(1);
    expect(segments[0]!.endedAt - segments[0]!.startedAt).toBe(MAX_SEGMENT_MS);
    expect((await f.db.state.get('current'))?.host).toBe('github.com');
    f.tracker.stop();
  });

  it('bills only up to the last confirmed beat after a dead stretch', async () => {
    const f = await fixture();
    f.chrome.setActive(tab(1, 'https://github.com/'));
    f.tracker.start();
    await f.tracker.drain();
    // A real beat refreshes lastBeatAt, then the worker disappears for 10
    // minutes (OS sleep). The stretch after the beat is nobody's attention.
    f.advance(30_000);
    f.chrome.fireActivated({ tabId: 1, windowId: 1 });
    await f.tracker.drain();
    f.advance(10 * 60 * 1000);
    await f.tracker.onHeartbeat();

    const segments = await f.db.segments.toArray();
    expect(segments).toHaveLength(1);
    expect(segments[0]!.endedAt).toBe(T0 + 30_000);
    // The tracker does not pretend to know what is on top after the sleep
    // until it has looked: the wake path re-resolves and reopens.
    expect((await f.db.state.get('current'))?.host).toBe('github.com');
    f.tracker.stop();
  });

  it('discards sub-second flicks and honours mode off', async () => {
    const f = await fixture();
    f.chrome.setActive(tab(1, 'https://github.com/'));
    f.tracker.start();
    await f.tracker.drain();
    f.advance(1_000);
    f.chrome.setActive(tab(2, 'https://gitlab.com/'));
    f.chrome.fireActivated({ tabId: 2, windowId: 1 });
    await f.tracker.drain();
    expect(await f.db.segments.count()).toBe(0);

    await saveActivityPrefs(f.db, { ...defaultActivityPrefs(), mode: 'off' });
    await f.tracker.onHeartbeat();
    expect(await f.db.state.get('current')).toBeUndefined();
    f.tracker.stop();
  });

  it('settles the closed tab and picks up its neighbour', async () => {
    const f = await fixture();
    f.chrome.setActive(tab(1, 'https://github.com/'));
    f.tracker.start();
    await f.tracker.drain();
    f.advance(20_000);
    f.chrome.setActive(tab(2, 'https://news.example/'));
    f.chrome.fireRemoved(1, { windowId: 1, isWindowClosing: false });
    await f.tracker.drain();

    const segments = await f.db.segments.toArray();
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ host: 'github.com', endedAt: T0 + 20_000 });
    expect((await f.db.state.get('current'))?.host).toBe('news.example');
    f.tracker.stop();
  });

  it('counts tab activations as context switches', async () => {
    const f = await fixture();
    f.chrome.setActive(tab(1, 'https://github.com/'));
    f.tracker.start();
    await f.tracker.drain();
    f.chrome.setActive(tab(2, 'https://gitlab.com/'));
    f.chrome.fireActivated({ tabId: 2, windowId: 1 });
    await f.tracker.drain();
    f.chrome.setActive(tab(1, 'https://github.com/'));
    f.chrome.fireActivated({ tabId: 1, windowId: 1 });
    await f.tracker.drain();
    // Same-host reactivations count too — a switch is a switch.
    f.chrome.setActive(tab(3, 'https://github.com/other'));
    f.chrome.fireActivated({ tabId: 3, windowId: 1 });
    await f.tracker.drain();

    // Three activations fired; start()'s initial reading is not a switch.
    expect((await f.db.metrics.get(DAY))?.switches).toBe(3);
    f.tracker.stop();
  });

  it('beats refresh lastBeatAt without rotating the episode', async () => {
    const f = await fixture();
    f.chrome.setActive(tab(1, 'https://github.com/'));
    f.tracker.start();
    await f.tracker.drain();
    f.advance(HEARTBEAT_GRACE_MS - 10_000);
    await f.tracker.onHeartbeat();
    const state = await f.db.state.get('current');
    expect(state?.lastBeatAt).toBe(T0 + HEARTBEAT_GRACE_MS - 10_000);
    expect(await f.db.segments.count()).toBe(0);
    f.tracker.stop();
  });
});
