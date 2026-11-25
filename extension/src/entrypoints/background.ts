// MV3 service worker: wires the sync core to the browser. Keep thin —
// all logic lives in the core modules. The worker may be killed at any
// await; every durable fact is in IndexedDB / storage.local.
//
// Everything below is chrome.* plumbing and message routing. The trigger
// orchestration an alarm, a manual click, a wake and a recovery all share is
// core/sync/workerLoop, where it can be tested.

import { defineBackground } from 'wxt/utils/define-background';
import { createChromiumAdapter } from '../core/browser/chromium';
import { ApiClient } from '../core/transport/client';
import { BootstrapStore } from '../core/store/bootstrap';
import { PontisDB, logDiagnostic, releaseAllRunLocks } from '../core/store/db';
import { InitialReconciler } from '../core/sync/initialReconcile';
import { ReplicaVerifier } from '../core/sync/verifyReplica';
import { RemoteChangeApplier } from '../core/sync/remoteChangeApplier';
import { ResyncService, type IntentDecision } from '../core/sync/resync';
import { SyncCoordinator } from '../core/sync/syncCoordinator';
import { WorkerLoop } from '../core/sync/workerLoop';
import { ActivityDB, dayKeyOf, loadActivityPrefs } from '../core/activity/store';
import { ActivityTracker, type ActivityChromeApi } from '../core/activity/tracker';
import { flushActivity } from '../core/activity/uploader';
import { checkDailyLimits } from '../core/activity/limits';
import { chromeApi, kvArea } from '../runtime/chromeApi';

export default defineBackground(() => {
  const chrome = chromeApi();
  const db = new PontisDB();
  const bootstrap = new BootstrapStore(kvArea(chrome.storage.local));
  const adapter = createChromiumAdapter(chrome.bookmarks);
  const client = new ApiClient(async () => {
    const b = await bootstrap.get();
    return { serverUrl: b.serverUrl ?? '', token: b.deviceToken };
  });
  const coordinator = new SyncCoordinator(db, new RemoteChangeApplier(db, adapter), client, client);
  const verifier = new ReplicaVerifier(db, adapter, coordinator);
  const reconciler = new InitialReconciler(db, adapter, client);
  const resync = new ResyncService(db, bootstrap, reconciler, verifier);
  const loop = new WorkerLoop({ db, adapter, coordinator, reconciler, resync, verifier });

  // --- browsing statistics (core/activity) ---
  //
  // A separate concern from sync: its own database, its own alarm, its own
  // mode switch. Collection starts immediately in 'local' mode; touching the
  // network requires the person to pick 'upload' in settings, and the flush
  // additionally requires a paired device credential.
  const activityDb = new ActivityDB();
  const tracker = new ActivityTracker(activityDb, chrome as unknown as ActivityChromeApi);
  tracker.start();
  const flushActivityNow = () =>
    void (async () => {
      const [b, prefs] = await Promise.all([bootstrap.get(), loadActivityPrefs(activityDb)]);
      await flushActivity(activityDb, client, {
        mode: prefs.mode,
        paired: Boolean(b.serverUrl && b.deviceToken),
      });
    })().catch(() => {
      // The queue rows hold the failure (attempts, backoff, lastError); the
      // next alarm piggyback retries. A flush that throws out of here would
      // only risk an unhandled rejection on a worker that is about to die.
    });

  // Daily-budget nudges ride the same heartbeat. One notification per host
  // per day — the dedupe lives in the prefs row, durable across worker
  // replacements — and only when the OPTIONAL notifications permission has
  // actually been granted at add-a-limit time. A click on the notification
  // opens the activity tab; that is the whole interaction.
  const notifyLimitHits = () =>
    void (async () => {
      const hits = await checkDailyLimits(activityDb);
      for (const hit of hits) {
        if (!chrome.notifications) return;
        const granted = await chrome.permissions.contains({ permissions: ['notifications'] });
        if (!granted) return;
        const today = dayKeyOf(Date.now());
        try {
          await chrome.notifications.create(`pontis-limit-${today}-${hit.host}`, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('/icon/128.png'),
            title: 'Pontis 每日限额',
            message: `今日 ${hit.host} 已达 ${hit.minutes} 分钟预算（累计 ${Math.round(hit.seconds / 60)} 分钟）。`,
          });
        } catch {
          // A notification that cannot be shown is not an error to surface:
          // the numbers remain in the activity tab either way.
        }
      }
    })().catch(() => undefined);

  // A fresh install has nothing paired and no way to know where to start.
  // Opening the guide is the only moment the extension puts a window in front of
  // a person; after that everything is theirs to reopen. An update never does
  // this — interrupting someone mid-sync to show them a changelog is not ours to
  // decide.
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason !== 'install') return;
    void (async () => {
      const b = await bootstrap.get();
      if (b.serverUrl && b.deviceToken) return; // reinstalled over a kept profile
      await chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    })();
  });

  // Create periodic alarms only when absent or reconfigured so MV3 service
  // worker wakeups do not continuously reset the countdown timer (R18).
  const ensureAlarm = (name: string, periodInMinutes: number) => {
    const schedule = () => chrome.alarms.create(name, { periodInMinutes });
    if (typeof chrome.alarms.get !== 'function') {
      schedule();
      return;
    }
    void Promise.resolve(chrome.alarms.get(name))
      .then((existing) => {
        if (!existing || existing.periodInMinutes !== periodInMinutes) {
          schedule();
        }
      })
      .catch(() => schedule());
  };

  ensureAlarm('pontis-sync', 5);
  ensureAlarm('pontis-integrity', 24 * 60);
  // The dwell tracker's beat: keeps an open segment's lastBeatAt fresh while
  // the person really is on the page, and is the wake path that settles a
  // segment left open by a dead worker.
  ensureAlarm('pontis-activity-hb', 1);
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'pontis-sync') {
      void loop.runSync('alarm');
      flushActivityNow();
    }
    if (alarm.name === 'pontis-integrity') void loop.runIntegrity('daily');
    if (alarm.name === 'pontis-activity-hb') {
      void tracker.onHeartbeat();
      notifyLimitHits();
    }
  });
  chrome.runtime.onStartup.addListener(() => {
    void loop.runSync('startup');
    void loop.runIntegrity('startup');
    flushActivityNow();
  });

  // A budget nudge clicked mid-evening wants the page where the numbers and
  // the edit button live, not a generic greeting.
  chrome.notifications?.onClicked.addListener((id) => {
    if (!id.startsWith('pontis-limit-')) return;
    void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#activity') });
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (isMessage(msg, 'pontis/manual-sync')) {
      // A click means the person just changed something and wants it out, so a
      // pass already running owes this one a second sweep. The alarm and the
      // wake do not: they ask for the same catch-up scan.
      void loop.runSync('manual', { rerunOnJoin: true }).then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: String(err) }),
      );
      return true; // async response
    }
    if (isMessage(msg, 'pontis/resolve-intents')) {
      const { bindingId, decisions } = msg as { bindingId: string; decisions: IntentDecision[] };
      void resync
        .resolveIntents(bindingId, decisions)
        .then((outcome) => sendResponse({ ok: true, outcome }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    if (isMessage(msg, 'pontis/integrity-check')) {
      const { bindingId } = msg as { bindingId: string };
      void loop
        .integrityFor(bindingId)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    if (isMessage(msg, 'pontis/initial-reconcile-answer')) {
      const { bindingId, decisions } = msg as { bindingId: string; decisions: Record<string, string> };
      void reconciler
        .answer(bindingId, decisions)
        .then((outcome) => sendResponse({ ok: true, outcome }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    if (isMessage(msg, 'pontis/remount')) {
      const { bindingId, folderBrowserId } = msg as { bindingId: string; folderBrowserId: string };
      void reconciler
        .remount(bindingId, folderBrowserId)
        .then((outcome) => sendResponse({ ok: true, outcome }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    if (isMessage(msg, 'pontis/activity-flush')) {
      // The settings page's 立即上传: nobody should wait out a five-minute
      // alarm to see the badge clear after deliberately switching upload on.
      // Failures land in the queue rows, so the answer only says it ran.
      flushActivityNow();
      sendResponse({ ok: true });
      return true;
    }
    return undefined;
  });

  // --- event capture: never pauses (doc 05 §13) ---

  adapter.onCreated((node) => void loop.dispatch({ kind: 'created', node }));
  adapter.onChanged((node) => void loop.dispatch({ kind: 'changed', node }));
  adapter.onMoved((node, oldParentId) => void loop.dispatch({ kind: 'moved', node, oldParentId }));
  adapter.onRemoved((node) => void loop.dispatch({ kind: 'removed', node }));

  // A lock left behind belongs to the worker this one replaced: MV3 runs a
  // single service worker, so anything still held was abandoned by a kill.
  void releaseAllRunLocks(db)
    .then((cleared) => {
      if (cleared > 0) {
        return logDiagnostic(db, 'warn', 'background', '已清除上一个 worker 遗留的运行锁', { cleared });
      }
      return undefined;
    })
    .then(() => loop.runSync('wake'));
});

function isMessage(msg: unknown, type: string): boolean {
  return typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === type;
}
