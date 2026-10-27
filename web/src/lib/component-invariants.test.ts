// Which component library a web surface is allowed to reach into.
//
// The browser's own <select> is drawn by the platform: its radius, font size and
// arrow come from macOS or Windows rather than from pontis-theme, so a form that
// mixes the two reads as two products. docs/23 §27.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(fileURLToPath(import.meta.url), '..', '..');

const components = readdirSync(src, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && e.name.endsWith('.tsx') && !e.name.includes('.test.'))
  .map((e) => join(e.parentPath, e.name));

/** An import of the native select, or a hand-written <select> element. */
const NATIVE = /NativeSelect|<select[\s>]/g;

/**
 * Hover painted from JS rather than CSS. Besides duplicating what a component
 * already does, it only ever covers the two things the handler says: the focus
 * ring and the press are never added, so the control is unusable from the
 * keyboard without looking broken. `onMouseEnter` that moves a highlight index
 * — the command palette, search results — is a different thing and stays.
 */
const JS_HOVER = /onMouse(?:Enter|Leave)=\{[^}]*\.style\./g;

describe('web component invariants', () => {
  it('picks every option list with the themed Select', () => {
    const found: string[] = [];
    for (const file of components) {
      for (const match of readFileSync(file, 'utf8').matchAll(NATIVE)) {
        found.push(`${relative(src, file)}: ${match[0].trim()}`);
      }
    }
    expect(found, 'use Select from @mantine/core — a native select cannot be themed').toEqual([]);
  });

  it('paints hover from CSS, not from a mouse handler', () => {
    const found: string[] = [];
    for (const file of components) {
      for (const match of readFileSync(file, 'utf8').matchAll(JS_HOVER)) {
        found.push(`${relative(src, file)}: ${match[0].trim()}`);
      }
    }
    expect(found, 'a &:hover rule (see styles/*.css.ts) or a themed Button — not e.currentTarget.style').toEqual([]);
  });
});
