// The start page's activity strip: one dimmed line at the foot of the launch
// surface, nothing more.
//
// The start page is a door, not a dashboard (start-page doc §1) — so the
// browsing numbers get exactly one quiet line: today's total, the host that
// took the most of it, the switch count, and a link into the settings tab
// where the full view lives. It renders only when tracking is on AND the day
// has something in it: an all-zero strip is noise, and a strip next to
// "关闭" would advertise a feature the person already declined.

import { useEffect, useState } from 'react';
import { dayKeyOf, loadActivityPrefs, type ActivityPrefsRecord } from '../core/activity/store';
import { dayHosts, rangeTotals } from '../core/activity/aggregate';
import { chromeApi } from '../runtime/chromeApi';
import type { Runtime } from './runtime';
import { fmtDuration } from './duration';

interface ActivityStripData {
  total: number;
  topHost: string | null;
  switches: number;
  mode: ActivityPrefsRecord['mode'];
}

async function readStrip(activityDb: Runtime['activityDb']): Promise<ActivityStripData | null> {
  const prefs = await loadActivityPrefs(activityDb);
  if (prefs.mode === 'off') return null;
  const today = dayKeyOf(Date.now());
  const [hosts, totals] = await Promise.all([dayHosts(activityDb, today), rangeTotals(activityDb, today, today)]);
  if (totals.seconds <= 0) return null;
  return {
    total: totals.seconds,
    topHost: hosts[0]?.host ?? null,
    switches: (await activityDb.metrics.get(today))?.switches ?? 0,
    mode: prefs.mode,
  };
}

export function ActivityStrip({ activityDb, refreshKey = 0 }: { activityDb: Runtime['activityDb']; refreshKey?: number }) {
  const [data, setData] = useState<ActivityStripData | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readStrip(activityDb).then((next) => {
      if (!cancelled) setData(next);
    });
    return () => {
      cancelled = true;
    };
  }, [activityDb, refreshKey]);

  if (!data) return null;
  const parts = [`今日浏览 ${fmtDuration(data.total)}`];
  if (data.topHost) parts.push(`最常去 ${data.topHost}`);
  if (data.switches > 0) parts.push(`切换 ${data.switches} 次`);

  return (
    <div className="pontis-spActivity">
      <span>
        {parts.join(' · ')}
        {data.mode === 'local' ? '（仅本机）' : ''}
      </span>
      <a href={`${chromeApi().runtime.getURL('options.html')}#activity`}>在设置中查看</a>
    </div>
  );
}
