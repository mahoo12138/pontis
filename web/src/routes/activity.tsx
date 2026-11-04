/**
 * 浏览分析 (/activity) — what the extension's upload says about attention.
 *
 * The page is a pure reader over two aggregates the server keeps (day × host
 * totals and the 24-hour histogram). It borrows the space-analytics visual
 * vocabulary wholesale — same sections, same bars, same caveat discipline —
 * because docs/23's "冷灰理性工作台" rules do not reset at a route boundary.
 * Charts stay divs: no chart library, per the analytics precedent.
 */
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Group, SegmentedControl, Select, Skeleton } from '@mantine/core';
import type { CountBucket } from '../features/analytics/buckets';
import { BarList, Caveat, EmptyState, Histogram, Readout, Section, SectionBody } from '../components/analytics/parts';
import Header from '../components/app-shell/Header';
import ErrorState from '../components/common/ErrorState';
import { contentRegion } from '../styles/app-shell.css';
import { pagePad } from '../styles/management.css';
import {
  barFill,
  barFillLead,
  barLabel,
  barNote,
  barRow,
  barTrack,
  barValue,
} from '../styles/analytics.css';
import { tokens } from '../styles/semantic-tokens.css';
import { ACTIVITY_HOST_PAGE_SIZE, useBrowsingHosts, useBrowsingOverview } from '../hooks/use-activity';
import { CATEGORY_LABELS, summarizeByCategory } from '../features/activity/categories';
import { useDeviceOverview } from '../hooks/use-devices';

type Range = '7' | '30' | '90';

/** Seconds → 1 小时 20 分 / 15 分 / 40 秒, the granularity a human skims at. */
function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分钟`;
  return `${s} 秒`;
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** The inclusive local-day range a preset names. */
function rangeDays(range: Range): { from: string; to: string } {
  const to = dayKey(new Date());
  const days = range === '7' ? 6 : range === '30' ? 29 : 89;
  return { from: dayKey(new Date(Date.now() - days * 86_400_000)), to };
}

function dayLabel(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/**
 * Ranking bars whose value is a duration. BarList formats its value as a
 * bare count; seconds rendered raw would make "5400" the headline, so the
 * page runs the same row structure with a duration formatter. One leader,
 * same as BarList: the accent is a budget of exactly one per surface.
 */
function DurationBarList({
  items,
  emptyText,
  note,
}: {
  items: { label: string; seconds: number; visits: number }[];
  emptyText: string;
  /** Right-hand note; defaults to the episode count. */
  note?: (item: { visits: number }) => string;
}) {
  if (items.length === 0) return <EmptyState text={emptyText} />;
  const max = Math.max(...items.map((item) => item.seconds), 1);
  const leadIndex = items.findIndex((item) => item.seconds === max);
  return (
    <div>
      {items.map((item, index) => (
        <div key={item.label} className={barRow} title={item.label}>
          <div className={barLabel}>{item.label}</div>
          <div className={barTrack}>
            <div
              className={`${barFill} ${index === leadIndex ? barFillLead : ''}`}
              style={{ width: `${Math.max((item.seconds / max) * 100, 1.5)}%` }}
            />
          </div>
          <div className={barValue}>
            {fmtDuration(item.seconds)}
            <span className={barNote}> {note ? note(item) : `${item.visits} 段`}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ActivityPage() {
  const [params, setParams] = useSearchParams();
  const range = (params.get('range') || '7') as Range;
  const deviceId = params.get('device') ?? '';

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const { from, to } = rangeDays(range);
  const filter = useMemo(() => ({ from, to, ...(deviceId ? { device_id: deviceId } : {}) }), [from, to, deviceId]);

  const overview = useBrowsingOverview(filter);
  const hosts = useBrowsingHosts(filter);
  const devices = useDeviceOverview();

  const data = overview.data;
  const hostItems = hosts.data ? hosts.data.pages.flatMap((page) => page.items) : [];
  // Every page carries the same pre-paging total; the first page's copy is
  // the canonical one.
  const hostTotal = hosts.data?.pages[0]?.total ?? 0;
  const topHost = hostItems[0];
  const dayCount = data?.by_day.length ?? 0;
  const dailyAvg = data && dayCount > 0 ? data.totals.seconds / dayCount : 0;

  const hourBuckets = useMemo<CountBucket[]>(() => {
    // Minutes, not seconds: the count label sits in a small column, and
    // "5400" is noise where "90" reads at a glance.
    return (data?.by_hour ?? Array.from({ length: 24 }, () => 0)).map((seconds, hour) => ({
      label: String(hour),
      count: Math.round(seconds / 60),
    }));
  }, [data]);

  const deviceOptions = (devices.data?.devices ?? []).map((d) => ({ value: d.id, label: d.name }));

  // Categories are client-side rules over the loaded ranking; the caveat
  // under the section says exactly what the grouping saw.
  const categorySummary = useMemo(() => summarizeByCategory(hostItems), [hostItems]);

  return (
    <>
      <Header breadcrumb="浏览分析" />
      <div className={`${contentRegion} ${pagePad}`}>
        <Group gap="xs" mb="md">
          <SegmentedControl
            size="xs"
            value={range}
            onChange={(v) => setParam('range', v)}
            data={[
              { label: '近 7 天', value: '7' },
              { label: '近 30 天', value: '30' },
              { label: '近 90 天', value: '90' },
            ]}
            styles={{ root: { backgroundColor: tokens.hoverBg } }}
          />
          <Select
            size="xs"
            w={200}
            placeholder="全部设备"
            clearable
            data={deviceOptions}
            value={deviceId || null}
            onChange={(v) => setParam('device', v ?? '')}
          />
        </Group>

        {overview.isError ? (
          <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
        ) : overview.isLoading || !data ? (
          <Skeleton height={220} radius="md" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 860 }}>
            <Section title="概览" hint={`${data.from} 至 ${data.to}`}>
              <SectionBody>
                <Readout
                  items={[
                    { label: '总时长', value: fmtDuration(data.totals.seconds) },
                    { label: '专注段', value: data.totals.visits.toLocaleString('zh-CN') },
                    {
                      label: '日均',
                      value: dayCount > 0 ? fmtDuration(dailyAvg) : '—',
                    },
                    { label: '最长专注', value: data.metrics.longest_focus_seconds > 0 ? fmtDuration(data.metrics.longest_focus_seconds) : '—' },
                    {
                      label: '标签切换',
                      value: data.metrics.switches > 0 ? `${data.metrics.switches.toLocaleString('zh-CN')} 次` : '—',
                    },
                    { label: '最常去', value: topHost?.host ?? '—' },
                  ]}
                />
              </SectionBody>
            </Section>

            <Section title="每日趋势" hint="一天里在各处停留的总和">
              {data.by_day.length === 0 ? (
                <EmptyState text="这段时间没有记录" />
              ) : (
                <SectionBody>
                  <DurationBarList
                    items={data.by_day.map((d) => ({ label: dayLabel(d.day), seconds: d.seconds, visits: d.visits }))}
                    emptyText="这段时间没有记录"
                  />
                </SectionBody>
              )}
            </Section>

            <Section title="时间分布" hint="各小时的注意力（分钟），跟随上传设备的本地时钟">
              {data.totals.seconds === 0 ? (
                <EmptyState text="这段时间没有记录" />
              ) : (
                <Histogram buckets={hourBuckets} unitLabel="24 小时注意力分布" />
              )}
            </Section>

            {categorySummary.length > 0 && (
              <Section title="分类构成" hint="内置规则把域名归到大类；仅统计当前已加载的排行">
                <SectionBody>
                  <DurationBarList
                    items={categorySummary.map((c) => ({
                      label: CATEGORY_LABELS[c.category],
                      seconds: c.seconds,
                      visits: c.hosts,
                    }))}
                    emptyText="这段时间没有记录"
                    note={(item) => `${item.visits} 个域名`}
                  />
                </SectionBody>
              </Section>
            )}

            <Section title="域名排行" hint={hostTotal > hostItems.length ? `共 ${hostTotal} 个域名` : undefined}>
              <SectionBody>
                <DurationBarList
                  items={hostItems.map((h) => ({ label: h.host, seconds: h.seconds, visits: h.visits }))}
                  emptyText="这段时间没有记录"
                />
                {hosts.hasNextPage && (
                  <Button
                    mt="sm"
                    size="compact-xs"
                    variant="subtle"
                    color="coolGray"
                    loading={hosts.isFetchingNextPage}
                    onClick={() => void hosts.fetchNextPage()}
                  >
                    加载更多（已显示 {hostItems.length}/{hostTotal}）
                  </Button>
                )}
                {hostItems.length > ACTIVITY_HOST_PAGE_SIZE && (
                  <Caveat>
                    排行只统计停留秒数的前几名；长尾域名的合计时长不会出现在这里，总量以概览为准。
                  </Caveat>
                )}
              </SectionBody>
            </Section>

            <Caveat>
              数据来自开启了「上报」的浏览器插件，粒度为「日期 × 域名」；URL 与页面标题不会离开那台设备。某天的数字后来被插件修正过，会以修正后的为准。
            </Caveat>
          </div>
        )}
      </div>
    </>
  );
}
