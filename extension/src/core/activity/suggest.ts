// The Pontis-native feature: browsing statistics that talk to the bookmarks.
//
// A pure time tracker can only say "you spent 3 hours on github.com". Pontis
// holds both sides — where the attention went (local segments) and what the
// person already decided to keep (the bookmark tree through the adapter) —
// so it can close the loop in two directions:
//
// - 频繁访问、还没收藏: a page visited on several distinct days but absent
//   from the tree. A bookmark is a decision; this hands the person the
//   candidate they keep re-deciding not to make, one click away.
// - 收藏了、却再没打开: bookmarks whose URL no segment has touched since
//   tracking began. Honest framing matters here — this is "not visited
//   while statistics were being kept", never "dead for a year": the window
//   is as old as the data, and the UI copy says so.
//
// Everything runs locally against the segment rows; nothing in this module
// uploads or reads anything new.

import type { BrowserAdapter, BrowserNode } from '../browser/types';
import { urlVisits } from './aggregate';
import type { ActivityDB } from './store';

/** The suggestion folder lives under "other bookmarks" and holds one-click
 *  creates from this tab. Created on first use. */
export const SUGGESTION_FOLDER_TITLE = '来自浏览建议';

/** A page must appear on this many distinct local days … */
export const SUGGEST_MIN_DAYS = 2;
/** … and this many total episodes, before it is worth suggesting. */
export const SUGGEST_MIN_VISITS = 3;

export interface FrequentUnbookmarked {
  url: string;
  title: string;
  host: string;
  visits: number;
  days: number;
}

export interface ZombieBookmark {
  id: string;
  title: string;
  url: string;
}

export interface ActivitySuggestions {
  frequentUnbookmarked: FrequentUnbookmarked[];
  zombies: ZombieBookmark[];
  /** How many pages the suggestion window actually covers, for the UI copy. */
  observedUrls: number;
}

/** Canonical form for URL comparison: hash dropped, host lowercased. Query
 *  strings stay — two pages that differ only by query are usually two
 *  pages (a search, a doc anchor pair), and collapsing them would suggest
 *  the wrong thing. */
export function normalizeForCompare(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Every bookmark URL in the tree, keyed by canonical form, plus the
 *  bookmark rows themselves for the zombie side. A tree the adapter cannot
 *  walk (no root, or a browser error) yields an empty index: suggestions
 *  degrade to "none found", never to an exception in the settings page. */
export async function indexBookmarkUrls(adapter: BrowserAdapter): Promise<{
  byUrl: Map<string, BrowserNode>;
  all: BrowserNode[];
}> {
  const byUrl = new Map<string, BrowserNode>();
  const all: BrowserNode[] = [];
  let level: string[] = ['0'];
  const seen = new Set<string>(level);
  try {
    while (level.length > 0) {
      const groups = await Promise.all(level.map((id) => adapter.getChildren(id)));
      const next: string[] = [];
      for (const group of groups) {
        for (const node of group) {
          if (node.type === 'bookmark' && node.url) {
            all.push(node);
            const key = normalizeForCompare(node.url);
            if (key) byUrl.set(key, node);
          } else if (node.type === 'folder' && !node.unmodifiable && !seen.has(node.id)) {
            seen.add(node.id);
            next.push(node.id);
          }
        }
      }
      level = next;
    }
  } catch {
    // Half a walk is better than none: the maps hold whatever was read.
  }
  return { byUrl, all };
}

/** Compute both suggestion lists. Caps keep the settings page a glance, not
 *  a report. */
export async function computeSuggestions(
  db: ActivityDB,
  adapter: BrowserAdapter,
  limits: { unbookmarked: number; zombies: number } = { unbookmarked: 5, zombies: 10 },
): Promise<ActivitySuggestions> {
  const [visits, index] = await Promise.all([urlVisits(db), indexBookmarkUrls(adapter)]);
  // Normalize once per side, not per pair: a thousand-bookmark tree against
  // a few hundred browsed pages would otherwise pay for a URL parse every
  // combination.
  const visitedKeys = new Set<string>();
  for (const v of visits) {
    const key = normalizeForCompare(v.url);
    if (key) visitedKeys.add(key);
  }

  const unbookmarked: FrequentUnbookmarked[] = [];
  for (const v of visits) {
    if (v.visits < SUGGEST_MIN_VISITS || v.days.size < SUGGEST_MIN_DAYS) continue;
    if (index.byUrl.has(normalizeForCompare(v.url) ?? '')) continue;
    unbookmarked.push({ url: v.url, title: v.title || v.host, host: v.host, visits: v.visits, days: v.days.size });
  }
  unbookmarked.sort((a, b) => b.visits - a.visits || b.days - a.days);

  const zombies: ZombieBookmark[] = [];
  for (const node of index.all) {
    const key = node.url ? normalizeForCompare(node.url) : null;
    if (!key) continue;
    if (visitedKeys.has(key)) continue;
    zombies.push({ id: node.id, title: node.title, url: node.url ?? '' });
  }
  zombies.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));

  return {
    frequentUnbookmarked: unbookmarked.slice(0, limits.unbookmarked),
    zombies: zombies.slice(0, limits.zombies),
    observedUrls: visits.length,
  };
}

/**
 * File one suggestion into the dedicated folder under "other bookmarks".
 * Returns the created node's id. The write goes through the adapter, so the
 * resulting browser event flows through the ordinary sync pipeline like any
 * other local edit.
 */
export async function createSuggestedBookmark(
  adapter: BrowserAdapter,
  url: string,
  title: string,
): Promise<string> {
  const folderId = await ensureSuggestionFolder(adapter);
  const node = await adapter.create(folderId, { title: title.slice(0, 200) || url, url });
  return node.id;
}

async function ensureSuggestionFolder(adapter: BrowserAdapter): Promise<string> {
  const roots = await adapter.getChildren('0');
  const other =
    roots.find((n) => n.folderType === 'other' && n.type === 'folder') ??
    roots.find((n) => n.type === 'folder' && n.folderType !== 'bookmarks-bar' && n.folderType !== 'managed');
  if (!other) throw new Error('找不到可以存放建议书签的根目录');
  const children = await adapter.getChildren(other.id);
  const existing = children.find((n) => n.type === 'folder' && n.title === SUGGESTION_FOLDER_TITLE);
  if (existing) return existing.id;
  const created = await adapter.create(other.id, { title: SUGGESTION_FOLDER_TITLE });
  return created.id;
}
