/**
 * Host → category, as pure client-side rules.
 *
 * Deliberately NOT a server table: the mapping only decides how the /activity
 * page groups what the user already sees, and a server-side table would drag
 * in an editing UI, an API and a migration for what is, today, presentation.
 * The rules ship as data so they can grow (or move server-side, shared
 * across the instance) without touching any call site.
 *
 * Matching is suffix-based on the full hostname: a rule "github.com" claims
 * "gist.github.com" too, and nothing else. First hit wins, so order the
 * specific domains before their catch-all parents.
 */

export type CategoryId = 'dev' | 'comms' | 'social' | 'news' | 'learning' | 'fun' | 'shop' | 'other';

export const CATEGORY_LABELS: Record<CategoryId, string> = {
  dev: '开发',
  comms: '沟通',
  social: '社交',
  news: '资讯',
  learning: '学习',
  fun: '娱乐',
  shop: '购物',
  other: '其他',
};

export const CATEGORY_ORDER: CategoryId[] = [
  'dev',
  'comms',
  'social',
  'news',
  'learning',
  'fun',
  'shop',
  'other',
];

/** The seed rule table. Hostname suffixes, lowercase, no scheme. */
export const HOST_RULES: ReadonlyArray<{ host: string; category: CategoryId }> = [
  // 开发 — code hosts and their ecosystems first, then docs.
  { host: 'github.com', category: 'dev' },
  { host: 'gist.github.com', category: 'dev' },
  { host: 'gitlab.com', category: 'dev' },
  { host: 'gitee.com', category: 'dev' },
  { host: 'stackoverflow.com', category: 'dev' },
  { host: 'stackexchange.com', category: 'dev' },
  { host: 'npmjs.com', category: 'dev' },
  { host: 'developer.mozilla.org', category: 'dev' },
  { host: 'juejin.cn', category: 'dev' },
  { host: 'segmentfault.com', category: 'dev' },
  { host: 'cnblogs.com', category: 'dev' },
  { host: 'oschina.net', category: 'dev' },
  { host: 'v2ex.com', category: 'dev' },
  { host: 'vercel.com', category: 'dev' },
  { host: 'netlify.com', category: 'dev' },
  { host: 'cloudflare.com', category: 'dev' },
  { host: 'hub.docker.com', category: 'dev' },
  { host: 'kubernetes.io', category: 'dev' },
  { host: 'go.dev', category: 'dev' },
  { host: 'rust-lang.org', category: 'dev' },
  { host: 'python.org', category: 'dev' },

  // 沟通
  { host: 'mail.google.com', category: 'comms' },
  { host: 'outlook.', category: 'comms' },
  { host: 'slack.com', category: 'comms' },
  { host: 'zoom.us', category: 'comms' },
  { host: 'feishu.cn', category: 'comms' },
  { host: 'dingtalk.com', category: 'comms' },
  { host: 'teams.microsoft.com', category: 'comms' },
  { host: 'discord.com', category: 'comms' },
  { host: 'telegram.org', category: 'comms' },
  { host: 'web.wechat.com', category: 'comms' },

  // 社交
  { host: 'twitter.com', category: 'social' },
  { host: 'x.com', category: 'social' },
  { host: 'weibo.com', category: 'social' },
  { host: 'instagram.com', category: 'social' },
  { host: 'facebook.com', category: 'social' },
  { host: 'xiaohongshu.com', category: 'social' },
  { host: 'tieba.baidu.com', category: 'social' },
  { host: 'douban.com', category: 'social' },

  // 资讯
  { host: 'news.ycombinator.com', category: 'news' },
  { host: 'reddit.com', category: 'news' },
  { host: 'zhihu.com', category: 'news' },
  { host: '36kr.com', category: 'news' },
  { host: 'sspai.com', category: 'news' },
  { host: 'theverge.com', category: 'news' },
  { host: 'bbc.com', category: 'news' },
  { host: 'nytimes.com', category: 'news' },
  { host: 'thepaper.cn', category: 'news' },
  { host: 'caixin.com', category: 'news' },

  // 学习
  { host: 'coursera.org', category: 'learning' },
  { host: 'udemy.com', category: 'learning' },
  { host: 'edx.org', category: 'learning' },
  { host: 'icourse163.org', category: 'learning' },
  { host: 'bilibili.com', category: 'learning' },
  { host: 'wikipedia.org', category: 'learning' },
  { host: 'runoob.com', category: 'learning' },
  { host: 'leetcode.cn', category: 'learning' },
  { host: 'leetcode.com', category: 'learning' },

  // 娱乐
  { host: 'youtube.com', category: 'fun' },
  { host: 'netflix.com', category: 'fun' },
  { host: 'twitch.tv', category: 'fun' },
  { host: 'spotify.com', category: 'fun' },
  { host: 'music.163.com', category: 'fun' },
  { host: 'douyu.com', category: 'fun' },
  { host: 'huya.com', category: 'fun' },
  { host: 'iqiyi.com', category: 'fun' },
  { host: 'youku.com', category: 'fun' },
  { host: 'douyin.com', category: 'fun' },

  // 购物
  { host: 'taobao.com', category: 'shop' },
  { host: 'tmall.com', category: 'shop' },
  { host: 'jd.com', category: 'shop' },
  { host: 'pinduoduo.com', category: 'shop' },
  { host: 'smzdm.com', category: 'shop' },
  { host: 'amazon.', category: 'shop' },
  { host: 'ebay.com', category: 'shop' },
];

/**
 * Rule match: `github.com` claims the host itself and any subdomain
 * (`gist.github.com`); a trailing dot makes a rule a brand prefix
 * (`outlook.` claims `outlook.live.com` and `outlook.office.com` alike).
 */
export function classifyHost(host: string): CategoryId {
  const h = host.toLowerCase().replace(/\.$/, '');
  for (const rule of HOST_RULES) {
    const r = rule.host.toLowerCase();
    if (r.endsWith('.')) {
      if (h.startsWith(r)) return rule.category;
    } else if (h === r || h.endsWith(`.${r}`)) {
      return rule.category;
    }
  }
  return 'other';
}

export interface CategorizedHost {
  host: string;
  seconds: number;
  visits: number;
}

export interface CategorySummary {
  category: CategoryId;
  seconds: number;
  visits: number;
  hosts: number;
}

/** Group a ranked host list into categories, seconds descending (ties keep
 *  the canonical category order), dropping empty ones. The "other" bucket
 *  stays visible: pretending the unclassified mass away would overstate how
 *  well the rules cover reality. */
export function summarizeByCategory(items: readonly CategorizedHost[]): CategorySummary[] {
  const byCategory = new Map<CategoryId, CategorySummary>();
  for (const item of items) {
    const category = classifyHost(item.host);
    const row = byCategory.get(category) ?? { category, seconds: 0, visits: 0, hosts: 0 };
    row.seconds += item.seconds;
    row.visits += item.visits;
    row.hosts += 1;
    byCategory.set(category, row);
  }
  const orderOf = (c: CategoryId) => CATEGORY_ORDER.indexOf(c);
  return [...byCategory.values()].sort(
    (a, b) => b.seconds - a.seconds || orderOf(a.category) - orderOf(b.category),
  );
}

export interface CategorizedRow extends CategorizedHost {
  category: CategoryId;
}

/** Label every row, for list displays that annotate per line. */
export function categorizeAll(items: readonly CategorizedHost[]): CategorizedRow[] {
  return items.map((item) => ({ ...item, category: classifyHost(item.host) }));
}
