// Suggestion tests: the two directions of the bookmark loop — pages that
// keep coming back without a bookmark, and bookmarks nothing ever opens.

import { describe, expect, it } from 'vitest';

import { ActivityDB, defaultActivityPrefs, saveActivityPrefs } from './store';
import {
  computeSuggestions,
  createSuggestedBookmark,
  normalizeForCompare,
  SUGGESTION_FOLDER_TITLE,
  SUGGEST_MIN_DAYS,
  SUGGEST_MIN_VISITS,
} from './suggest';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';

const DAY = '2026-11-04';

async function db(): Promise<ActivityDB> {
  const d = new ActivityDB(`test-sug-${Math.random().toString(36).slice(2)}`);
  await saveActivityPrefs(d, defaultActivityPrefs());
  return d;
}

function seg(url: string, day: string, hour = 10) {
  const [y, m, d] = day.split('-').map((n) => Number(n)!);
  const startedAt = new Date(y!, m! - 1, d!, hour, 0, 0).getTime();
  return {
    startedAt,
    endedAt: startedAt + 60_000,
    host: new URL(url).hostname,
    url,
    title: `page of ${url}`,
    day,
    hour,
  };
}

function adapterWith(urls: string[]): FakeBrowserAdapter {
  const adapter = new FakeBrowserAdapter();
  adapter.seed({ id: '0', parentId: null, title: '' });
  adapter.seed({ id: '1', parentId: '0', title: 'Bookmarks Bar', folderType: 'bookmarks-bar' });
  adapter.seed({ id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other' });
  urls.forEach((url, i) => {
    adapter.seed({ id: `b${i}`, parentId: '2', title: `bm ${url}`, url });
  });
  return adapter;
}

describe('normalizeForCompare', () => {
  it('drops the hash, lowercases the host, keeps the query', () => {
    expect(normalizeForCompare('https://GitHub.Example/docs#section')).toBe('https://github.example/docs');
    expect(normalizeForCompare('https://github.example/search?q=x')).toBe('https://github.example/search?q=x');
    expect(normalizeForCompare('chrome://newtab')).toBeNull();
    expect(normalizeForCompare('nonsense')).toBeNull();
  });
});

describe('computeSuggestions', () => {
  it('suggests pages visited on enough distinct days that have no bookmark', async () => {
    const d = await db();
    const adapter = adapterWith(['https://bookmarked.example/a']);
    // A frequent, never-bookmarked page: 5 episodes over 3 days.
    const days = ['2026-11-02', '2026-11-03', '2026-11-04'];
    for (const day of days) {
      for (let i = 0; i < 2; i += 1) {
        await d.segments.add(seg(`https://github.com/pr-${i}`, day, 9 + i));
      }
    }
    // Below the day threshold, even with plenty of visits.
    for (let i = 0; i < 6; i += 1) {
      await d.segments.add(seg('https://oneday.example/x', DAY, 9 + i));
    }
    // A bookmarked page never becomes a candidate.
    await d.segments.add(seg('https://bookmarked.example/a', DAY));

    const out = await computeSuggestions(d, adapter);
    expect(out.frequentUnbookmarked.map((s) => s.url).sort()).toEqual([
      'https://github.com/pr-0',
      'https://github.com/pr-1',
    ]);
    // Each URL saw 3 episodes across the 3 days.
    expect(out.frequentUnbookmarked[0]).toMatchObject({ visits: 3, days: 3 });
    expect(out.observedUrls).toBe(4);
  });

  it('lists bookmarks nothing opened during the observed window', async () => {
    const d = await db();
    const adapter = adapterWith(['https://zombie.example/old', 'https://alive.example/']);
    await d.segments.add(seg('https://alive.example/', DAY));

    const out = await computeSuggestions(d, adapter);
    expect(out.zombies.map((z) => z.url)).toEqual(['https://zombie.example/old']);
  });

  it('respects the thresholds as exported constants', async () => {
    expect(SUGGEST_MIN_DAYS).toBeGreaterThanOrEqual(2);
    expect(SUGGEST_MIN_VISITS).toBeGreaterThanOrEqual(2);
  });
});

describe('createSuggestedBookmark', () => {
  it('creates the suggestion folder under "other" once and files into it', async () => {
    const adapter = adapterWith([]);
    const first = await createSuggestedBookmark(adapter, 'https://github.com/x', 'A fine page');
    const second = await createSuggestedBookmark(adapter, 'https://gitlab.com/y', 'Another');

    const other = await adapter.getChildren('2');
    const folder = other.find((n) => n.title === SUGGESTION_FOLDER_TITLE);
    expect(folder).toBeTruthy();
    const inside = await adapter.getChildren(folder!.id);
    expect(inside.map((n) => n.url)).toEqual(['https://github.com/x', 'https://gitlab.com/y']);
    expect(first).not.toBe(second);
  });
});
