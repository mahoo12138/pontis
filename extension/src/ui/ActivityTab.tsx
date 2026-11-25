// The 活动 tab: browsing statistics, their switch, and what they can do for
// the bookmarks — in that order of importance.
//
// The tab reads the activity database directly (the same pattern the sync
// tab uses on the replica DB): the worker writes rows on its own schedule,
// the page polls, and no message routing is involved. Everything shown here
// works without a pairing; the upload section is the only one that needs a
// server, and it is the person who turns it on.

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  Progress,
  SegmentedControl,
  Stack,
  TagsInput,
  Text,
  TextInput,
} from '@mantine/core';
import { Section } from './Section';
import { fmtDuration } from './duration';
import { navigableUrl } from '../core/start-page/url';
import { runtime } from './optionsRuntime';
import { errText, type Runtime } from './runtime';
import {
  clearActivityData,
  dayKeyOf,
  loadActivityPrefs,
  saveActivityPrefs,
  type ActivityPrefsRecord,
} from '../core/activity/store';
import { dayHosts, rangeByDay, rangeTotals } from '../core/activity/aggregate';
import {
  computeSuggestions,
  createSuggestedBookmark,
  type ActivitySuggestions,
} from '../core/activity/suggest';
import { normalizeLimit } from '../core/activity/limits';

/** The trailing N local days, oldest first: `YYYY-MM-DD` strings the
 *  aggregate tables are keyed by. */
function lastNDays(n: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const at = now.getTime() - i * 24 * 60 * 60 * 1000;
    out.push(dayKeyOf(at, new Date(at)));
  }
  return out;
}

function dayLabel(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}`;
}

interface ActivityView {
  prefs: ActivityPrefsRecord;
  today: { total: number; visits: number; switches: number; hosts: { host: string; seconds: number }[] };
  week: { day: string; seconds: number }[];
  weekTotal: number;
  queued: number;
  suggestions: ActivitySuggestions | null;
}

async function readActivityView(activityDb: Runtime['activityDb'], adapter: Runtime['adapter']): Promise<ActivityView> {
  const prefs = await loadActivityPrefs(activityDb);
  const today = dayKeyOf(Date.now());
  const week = lastNDays(7);
  const weekFrom = week[0]!;
  const weekTo = week[week.length - 1]!;
  const [todayHosts, weekRows, todayTotals, weekTotals, queued, todayMetrics] = await Promise.all([
    dayHosts(activityDb, today),
    rangeByDay(activityDb, weekFrom, weekTo),
    rangeTotals(activityDb, today, today),
    rangeTotals(activityDb, weekFrom, weekTo),
    activityDb.queue.where('status').equals('QUEUED').count(),
    activityDb.metrics.get(today),
  ]);
  const suggestions = await computeSuggestions(activityDb, adapter);
  return {
    prefs,
    today: {
      total: todayTotals.seconds,
      visits: todayTotals.visits,
      switches: todayMetrics?.switches ?? 0,
      hosts: todayHosts.slice(0, 6).map((r) => ({ host: r.host, seconds: r.seconds })),
    },
    week: weekRows.map((r) => ({ day: r.day, seconds: r.seconds })),
    weekTotal: weekTotals.seconds,
    queued,
    suggestions,
  };
}

export function ActivityTab({ paired }: { paired: boolean }) {
  const { activityDb, adapter } = runtime;
  const [view, setView] = useState<ActivityView | null>(null);
  const [blocklistDraft, setBlocklistDraft] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [bookmarking, setBookmarking] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [limitHost, setLimitHost] = useState('');
  const [limitMinutes, setLimitMinutes] = useState(30);
  const [limitNotice, setLimitNotice] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);

  const refresh = useCallback(() => {
    readActivityView(activityDb, adapter)
      .then((v) => {
        setView(v);
        setBlocklistDraft(v.prefs.blocklist);
      })
      .catch((e) => setError(errText(e)));
  }, [activityDb, adapter]);

  useEffect(() => {
    refresh();
    // The worker writes while the page sits open; a lazy poll keeps the
    // numbers honest without any message routing.
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const savePrefs = async (patch: Partial<ActivityPrefsRecord>) => {
    if (!view) return;
    try {
      const next = { ...view.prefs, ...patch };
      await saveActivityPrefs(activityDb, next);
      setView({ ...view, prefs: next });
    } catch (e) {
      setError(errText(e));
    }
  };

  const doBookmark = async (url: string, title: string) => {
    setBookmarking(url);
    try {
      await createSuggestedBookmark(adapter, url, title);
      refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBookmarking(null);
    }
  };

  const doClear = async () => {
    setClearing(true);
    try {
      await clearActivityData(activityDb);
      setClearOpen(false);
      refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setClearing(false);
    }
  };

  /**
   * The one runtime ask of the OPTIONAL notifications permission, and it
   * happens inside the click that adds a limit — the copy above the form has
   * already said what the permission is for, so the browser's own grant
   * bubble arrives with the context in place. A person who never adds a
   * limit never sees this call.
   */
  const ensureNotificationPermission = async (): Promise<boolean> => {
    const { chrome } = runtime;
    const granted = await chrome.permissions.contains({ permissions: ['notifications'] });
    if (granted) return true;
    return new Promise<boolean>((resolve) =>
      chrome.permissions.request({ permissions: ['notifications'] }, resolve),
    );
  };

  const doAddLimit = async () => {
    const limit = normalizeLimit({ host: limitHost, minutes: limitMinutes });
    if (!limit) {
      setLimitNotice({ kind: 'warn', text: '域名或分钟数不对：填主机名（如 bilibili.com）和 1–1440 的整数分钟。' });
      return;
    }
    try {
      const granted = await ensureNotificationPermission();
      const others = (view?.prefs.limits ?? []).filter((l) => l.host !== limit.host);
      await savePrefs({ limits: [...others, limit] });
      setLimitNotice(
        granted
          ? { kind: 'ok', text: `已设定：${limit.host} 每天 ${limit.minutes} 分钟，到点会弹一条通知。` }
          : {
              kind: 'warn',
              text: '通知权限没有授予：限额仍会记录，到点在活动页可见，但不弹提醒；下次添加限额时会再次询问。',
            },
      );
      setLimitHost('');
      setLimitMinutes(30);
    } catch (e) {
      setError(errText(e));
    }
  };

  if (error) {
    return (
      <Alert color="errorRed" title="活动统计读取失败">
        {error}
      </Alert>
    );
  }
  if (!view) return null;

  const { prefs, today, week, weekTotal, queued, suggestions } = view;
  const maxToday = Math.max(1, ...today.hosts.map((h) => h.seconds));
  const maxWeek = Math.max(1, ...week.map((d) => d.seconds));
  const modeValue = prefs.mode === 'upload' && !paired ? 'local' : prefs.mode;

  return (
    <Stack gap="lg">
      <Section
        title="采集设置"
        hint="原始浏览记录（含 URL 和标题）只保存在本机。开启上报后，发送给服务器的只有「日期 + 域名 + 时长」级别的汇总，不含 URL、不含标题；隐私模式下的标签页从一开始就不会被记录。"
      >
        <Stack gap="sm">
          <Group gap="sm">
            <SegmentedControl
              size="xs"
              value={modeValue}
              onChange={(v) => void savePrefs({ mode: v as ActivityPrefsRecord['mode'] })}
              data={[
                { value: 'off', label: '关闭' },
                { value: 'local', label: '仅本地' },
                { value: 'upload', label: '本地 + 上报', disabled: !paired },
              ]}
            />
            {!paired && (
              <Text size="xs" c="dimmed">
                配对后才能开启上报
              </Text>
            )}
          </Group>
          <TagsInput
            size="xs"
            label="不记录的域名"
            description="这些站点的访问既不入库也不上报，用完整主机名，例如 bank.example.com"
            placeholder="输入后回车添加"
            value={blocklistDraft}
            onChange={(values) => {
              const cleaned = [...new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))];
              setBlocklistDraft(cleaned);
              void savePrefs({ blocklist: cleaned });
            }}
          />
          <Text size="xs" c="dimmed">
            原始记录保留 {prefs.segmentRetentionDays} 天，按天汇总保留 {prefs.aggregateRetentionDays} 天，到期自动删除。
          </Text>
        </Stack>
      </Section>

      <Section
        title="每日限额"
        hint="给特定站点设一天的预算，到点弹一条系统通知——只提醒、不拦截、不上报。通知权限只在添加第一个限额时申请，也只用于这个提醒。"
      >
        <Stack gap="sm">
          {(prefs.limits ?? []).length === 0 ? (
            <Text size="xs" c="dimmed">
              还没有限额。比较常见的用法是给容易刷起来的站点设一个上限，比如 30 分钟。
            </Text>
          ) : (
            (prefs.limits ?? []).map((l) => (
              <Group key={l.host} gap="xs" wrap="nowrap" justify="space-between">
                <Text size="sm" truncate style={{ flex: 1 }}>
                  {l.host}
                  <Text size="xs" c="dimmed" component="span" ml={6}>
                    {l.minutes} 分钟 / 天
                  </Text>
                </Text>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="coolGray"
                  onClick={() => {
                    setLimitNotice(null);
                    void savePrefs({ limits: (prefs.limits ?? []).filter((x) => x.host !== l.host) });
                  }}
                >
                  删除
                </Button>
              </Group>
            ))
          )}
          <Group gap="xs" wrap="nowrap" align="flex-end">
            <TextInput
              size="xs"
              placeholder="站点，如 bilibili.com"
              value={limitHost}
              onChange={(e) => setLimitHost(e.currentTarget.value)}
              style={{ flex: 1 }}
            />
            <NumberInput
              size="xs"
              w={120}
              min={1}
              max={1440}
              value={limitMinutes}
              onChange={(v) => setLimitMinutes(Number(v) || 0)}
              suffix=" 分钟"
            />
            <Button size="xs" variant="light" onClick={() => void doAddLimit()}>
              添加
            </Button>
          </Group>
          {limitNotice && (
            <Alert
              color={limitNotice.kind === 'ok' ? 'healthyGreen' : 'warningAmber'}
              variant="light"
              maw={480}
            >
              {limitNotice.text}
            </Alert>
          )}
        </Stack>
      </Section>

      <Section
        title="今日"
        hint={`共 ${fmtDuration(today.total)} · ${today.visits} 段专注 · 切换 ${today.switches} 次`}
        right={
          prefs.mode === 'upload' ? (
            <Group gap="xs" wrap="nowrap">
              <Text size="xs" c="dimmed">
                {queued > 0 ? `${queued} 天待上传` : '已全部上传'}
              </Text>
              {queued > 0 && (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="coolGray"
                  loading={uploading}
                  onClick={() =>
                    void (async () => {
                      setUploading(true);
                      try {
                        await runtime.chrome.runtime.sendMessage({ type: 'pontis/activity-flush' });
                        refresh();
                      } finally {
                        setUploading(false);
                      }
                    })()
                  }
                >
                  立即上传
                </Button>
              )}
            </Group>
          ) : undefined
        }
      >
        {today.hosts.length === 0 ? (
          <Text size="sm" c="dimmed">
            还没有记录。在浏览器里正常使用一会儿，这里就会出现今天去过的地方。
          </Text>
        ) : (
          <Stack gap={6}>
            {today.hosts.map((h) => (
              <Group key={h.host} gap="sm" wrap="nowrap">
                <Text size="xs" w={180} truncate>
                  {h.host}
                </Text>
                <Progress value={(h.seconds / maxToday) * 100} flex={1} size="sm" color="accentBlue" />
                <Text size="xs" c="dimmed" w={90} ta="right">
                  {fmtDuration(h.seconds)}
                </Text>
              </Group>
            ))}
          </Stack>
        )}
      </Section>

      <Section title="近 7 天" hint={`合计 ${fmtDuration(weekTotal)}`}>
        {week.length === 0 ? (
          <Text size="sm" c="dimmed">
            暂无数据。
          </Text>
        ) : (
          <Stack gap={6}>
            {week.map((d) => (
              <Group key={d.day} gap="sm" wrap="nowrap">
                <Text size="xs" w={48}>
                  {dayLabel(d.day)}
                </Text>
                <Progress value={(d.seconds / maxWeek) * 100} flex={1} size="sm" color="coolGray" />
                <Text size="xs" c="dimmed" w={90} ta="right">
                  {d.seconds > 0 ? fmtDuration(d.seconds) : '—'}
                </Text>
              </Group>
            ))}
          </Stack>
        )}
      </Section>

      <Section
        title="收藏建议"
        hint={`对比的是本机浏览记录（覆盖 ${suggestions?.observedUrls ?? 0} 个页面）与当前书签树，全部在本机完成。`}
        right={
          <Button size="xs" variant="subtle" color="coolGray" onClick={refresh}>
            重新检查
          </Button>
        }
      >
        {suggestions === null ? null : (
          <Stack gap="md">
            <div>
              <Text size="sm" fw={600} mb={4}>
                常去但还没收藏
              </Text>
              {suggestions.frequentUnbookmarked.length === 0 ? (
                <Text size="xs" c="dimmed">
                  暂无候选。连续两天以上访问、且书签里找不到的页面才会出现在这里。
                </Text>
              ) : (
                <Stack gap={4}>
                  {suggestions.frequentUnbookmarked.map((s) => (
                    <Group key={s.url} gap="xs" wrap="nowrap" justify="space-between">
                      <Text size="sm" truncate style={{ flex: 1 }}>
                        {s.title}
                        <Text size="xs" c="dimmed" component="span" ml={4}>
                          {s.host} · {s.days} 天 {s.visits} 次
                        </Text>
                      </Text>
                      <Button
                        size="xs"
                        variant="light"
                        loading={bookmarking === s.url}
                        onClick={() => void doBookmark(s.url, s.title)}
                      >
                        收藏
                      </Button>
                    </Group>
                  ))}
                </Stack>
              )}
              <Text size="xs" c="dimmed" mt={4}>
                收藏会进入「其他书签 → 来自浏览建议」，之后可以随时移动或改标题。
              </Text>
            </div>

            <div>
              <Text size="sm" fw={600} mb={4}>
                收藏了但统计期内没再打开
              </Text>
              {suggestions.zombies.length === 0 ? (
                <Text size="xs" c="dimmed">
                  书签都能在浏览记录里对上，或者还没有足够的数据。
                </Text>
              ) : (
                <Stack gap={4}>
                  {suggestions.zombies.map((z) => {
                    const safeUrl = navigableUrl(z.url);
                    return (
                      <Group key={z.id} gap="xs" wrap="nowrap" justify="space-between">
                        <Text size="sm" truncate style={{ flex: 1 }}>
                          {z.title || z.url}
                        </Text>
                        {safeUrl && (
                          <Button
                            size="xs"
                            variant="subtle"
                            color="coolGray"
                            component="a"
                            href={safeUrl.href}
                            target="_blank"
                            rel="noreferrer"
                          >
                            打开
                          </Button>
                        )}
                      </Group>
                    );
                  })}
                </Stack>
              )}
              <Text size="xs" c="dimmed" mt={4}>
                「没再打开」只覆盖开始统计之后的时间——统计开始前的访问不在这份数据里，清理前不妨先打开确认。
              </Text>
            </div>
          </Stack>
        )}
      </Section>

      <Section title="数据管理">
        <Group gap="sm">
          <Button size="xs" variant="light" color="errorRed" onClick={() => setClearOpen(true)}>
            清除本机统计数据
          </Button>
          <Text size="xs" c="dimmed">
            只清除浏览统计，书签与同步不受影响。
          </Text>
        </Group>
      </Section>

      <Modal opened={clearOpen} onClose={() => setClearOpen(false)} title="清除本机统计数据">
        <Stack gap="md">
          <Text size="sm">
            本机的浏览段落、按天汇总和上传队列都会被删除；服务器上已上报的数据不受影响。采集设置（模式、屏蔽名单）保留。
          </Text>
          <Group justify="flex-end" mt="lg">
            <Button variant="subtle" color="coolGray" onClick={() => setClearOpen(false)}>
              取消
            </Button>
            <Button color="errorRed" loading={clearing} onClick={() => void doClear()}>
              确认清除
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
