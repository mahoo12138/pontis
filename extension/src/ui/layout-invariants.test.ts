// Layout invariants for the extension's settings surfaces (issue #4).
//
// The complaint was that the pages had drifted into a mess: three different
// section-heading shapes, spacing values off the theme scale, and one tab on
// Mantine's default palette while the rest used the registered colors. Those are
// properties of the source rather than of any single render, so they are checked
// at the source: a grep guard fails where a component test would stay quiet, and
// it fails at the moment the second pattern is reintroduced.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');

/** Files that make up the settings surfaces the issue is about. */
const SURFACES = [
  'entrypoints/options/App.tsx',
  'ui/StartPageSettings.tsx',
  'ui/AccountTab.tsx',
  'ui/DiagnosticsPanel.tsx',
  'ui/ResyncIntents.tsx',
  'ui/SyncTab.tsx',
  'ui/Emptyish.tsx',
  'ui/Section.tsx',
  'ui/BindForm.tsx',
  'ui/PairingForm.tsx',
];

/**
 * Mantine spacing tokens; a bare number in these props is off the scale.
 * The leading whitespace matters: without it `step={5}` reads as `p={5}`.
 */
const OFF_SCALE_SPACING = /(?:^|\s)(?:gap|mt|mb|ml|mr|p|px|py|mx|my)=\{(?!0\b)[0-9]+\}/gm;

/**
 * Palette names Mantine ships that this app re-declares under its own tokens.
 * No trailing word boundary: the pattern ends on a quote, and `\b` after a
 * non-word character never matches — which is what made this check vacuous.
 */
const DEFAULT_PALETTE = /\b(?:color|c)="(?:blue|red|amber|gray|grey|green|orange|violet|teal)"/g;

/**
 * `<Group grow>` with no `align`: Mantine's Group defaults to `center`, which
 * floats a field without a description above its neighbour's control. Every
 * field row has to say how it aligns, even when the answer is `center`.
 */
const IMPLICIT_GROUP_ALIGN = /<Group\s+grow(?![^>]*\balign=)/g;

/** The theme key that decides where a description lands. Both apps must agree. */
const WRAPPER_ORDER = /inputWrapperOrder:\s*\[([^\]]*)\]/;

/**
 * A failure pinned in the page. Action results are corner notifications now
 * (`ui/notify.ts`); a red banner here means a fourth failure surface grew back.
 * Blue and amber stay allowed — those state what a surface cannot do yet, which
 * is content the page has to keep showing after the moment passes.
 */
const PINNED_FAILURE = /<Alert[^>]*color="errorRed"/g;

describe('settings layout invariants', () => {
  it('uses no Divider as a section heading', () => {
    const offenders = SURFACES.filter((f) => /<Divider\s+label=/.test(read(f)));
    expect(offenders, `section headings come from Section/SectionHeading only: ${offenders.join(', ')}`).toEqual([]);
  });

  it('keeps every spacing prop on the theme scale', () => {
    const found: string[] = [];
    for (const file of SURFACES) {
      for (const match of read(file).matchAll(OFF_SCALE_SPACING)) {
        found.push(`${file}: ${match[0]}`);
      }
    }
    expect(found, 'use gap="sm" / mt="xs" etc. from pontisTheme spacing').toEqual([]);
  });

  it('colors the settings surfaces with the registered palette only', () => {
    const found: string[] = [];
    for (const file of SURFACES) {
      for (const match of read(file).matchAll(DEFAULT_PALETTE)) {
        found.push(`${file}: ${match[0]}`);
      }
    }
    expect(found, 'accentBlue / errorRed / warningAmber / coolGray / healthyGreen are the theme colors').toEqual([]);
  });

  it('routes section headings through the shared Section module', () => {
    // A raw `.pontis-sectionTitle` outside Section.tsx means a second heading
    // shape has grown somewhere else.
    const strays = SURFACES.filter((f) => f !== 'ui/Section.tsx' && read(f).includes('pontis-sectionTitle'));
    expect(strays).toEqual([]);
  });

  it('states the alignment of every row of fields', () => {
    const found: string[] = [];
    for (const file of SURFACES) {
      for (const match of read(file).matchAll(IMPLICIT_GROUP_ALIGN)) {
        found.push(`${file}: ${match[0]}`);
      }
    }
    expect(
      found,
      'Mantine centres a Group by default, which lifts a field without a description off its row: say align="" explicitly',
    ).toEqual([]);
  });

  it('surfaces an action failure as a notification, not a banner', () => {
    const found: string[] = [];
    for (const file of SURFACES) {
      for (const match of read(file).matchAll(PINNED_FAILURE)) {
        found.push(`${file}: ${match[0]}`);
      }
    }
    expect(found, 'use notifyError from ui/notify.ts: a banner pushes the section it is about out of the way').toEqual([]);
  });

  it('keeps the description on the same side of the control as the web app', () => {
    // The two themes are hand-ported copies of each other; the order is what
    // decides whether a row of fields lines up, so it cannot drift per app.
    const extensionOrder = read('theme/pontisTheme.ts').match(WRAPPER_ORDER)?.[1];
    const webOrder = readFileSync(join(here, '..', '..', '..', 'web', 'src', 'theme', 'pontis-theme.ts'), 'utf8').match(
      WRAPPER_ORDER,
    )?.[1];
    expect(extensionOrder).toBeTruthy();
    expect(webOrder).toBe(extensionOrder);
  });
});
