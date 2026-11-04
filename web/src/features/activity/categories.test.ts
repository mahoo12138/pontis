import { describe, expect, it } from 'vitest';

import { categorizeAll, classifyHost, summarizeByCategory, CATEGORY_LABELS } from './categories';

describe('classifyHost', () => {
  it('claims subdomains with the domain rule', () => {
    expect(classifyHost('github.com')).toBe('dev');
    expect(classifyHost('gist.github.com')).toBe('dev');
    expect(classifyHost('Gist.GitHub.com.')).toBe('dev'); // case and FQDN dot
  });

  it('matches brand-prefix rules ending with a dot', () => {
    expect(classifyHost('outlook.live.com')).toBe('comms');
    expect(classifyHost('outlook.office365.com')).toBe('comms');
    expect(classifyHost('amazon.cn')).toBe('shop');
  });

  it('does not let a suffix rule eat a longer name', () => {
    // "notgithub.com" is not a subdomain of github.com.
    expect(classifyHost('notgithub.com')).toBe('other');
    // mail.google.com is comms; other google properties stay unclassified.
    expect(classifyHost('mail.google.com')).toBe('comms');
    expect(classifyHost('google.com')).toBe('other');
    expect(classifyHost('docs.google.com')).toBe('other');
  });

  it('resolves to "other" for the unclassified long tail', () => {
    expect(classifyHost('some-blog.example')).toBe('other');
    expect(CATEGORY_LABELS.other).toBe('其他');
  });
});

describe('summarizeByCategory', () => {
  it('groups hosts, sums seconds, and keeps "other" visible', () => {
    const summary = summarizeByCategory([
      { host: 'github.com', seconds: 600, visits: 3 },
      { host: 'gist.github.com', seconds: 300, visits: 1 },
      { host: 'youtube.com', seconds: 1200, visits: 2 },
      { host: 'random-blog.example', seconds: 60, visits: 1 },
    ]);
    expect(summary).toEqual([
      { category: 'fun', seconds: 1200, visits: 2, hosts: 1 },
      { category: 'dev', seconds: 900, visits: 4, hosts: 2 },
      { category: 'other', seconds: 60, visits: 1, hosts: 1 },
    ]);
  });

  it('returns an empty list for no data', () => {
    expect(summarizeByCategory([])).toEqual([]);
  });
});

describe('categorizeAll', () => {
  it('labels every host, defaulting to "other"', () => {
    const out = categorizeAll([
      { host: 'github.com', seconds: 10, visits: 1 },
      { host: 'mystery.example', seconds: 20, visits: 2 },
    ]);
    expect(out.map((r) => r.category)).toEqual(['dev', 'other']);
    expect(out[0]).toMatchObject({ host: 'github.com', seconds: 10, visits: 1 });
  });
});
