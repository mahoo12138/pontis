#!/usr/bin/env node
// The web console's whole business surface, walked in one real Chromium (doc 21 §10).
//
// The unit suites use a fake API (MSW) and the Go tests use httptest, so every
// double is theirs. What no double can show is the meeting: a real React app on
// a real server, where a Mantine Select really opens, a controlled input really
// takes a native setter, a download really lands on disk and a Bearer token
// really is (or is not) accepted by the route that issued it. This script runs
// that meeting against the built binary — the same artifact a release ships —
// with a fresh data dir, so the first-run setup wizard is part of the walk:
//
//   setup (first admin) → login/logout → spaces → explorer tree (create,
//   rename, move, inspector, keyboard) → delete → activity undo → export →
//   import (Netscape merge / JSON replace + safety backup) → organizer (link
//   check, duplicates) → backups (create, restore, epoch, safety) → tasks
//   (schedule, run now) → plaza (publish → member registers → imports →
//   snapshot update → re-import → unpublish, with permission boundaries) →
//   admin users → devices → settings → API token (works, then revoked) →
//   search → password change.
//
// It drives Chrome over the DevTools protocol with Node's global
// fetch/WebSocket and adds no dependency, like e2e-dual-profile.mjs. Headless
// by default (no extension pages here need a real window); --headed to watch.
//
//   pnpm build && node scripts/e2e-web-console.mjs [--headed] [--keep] [--debug]

import { spawn } from 'node:child_process';
import { existsSync, openSync, readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const ARGS = new Set(process.argv.slice(2));
const HEADED = ARGS.has('--headed') || process.env.PONTIS_E2E_HEADED === '1';
const KEEP = ARGS.has('--keep');
const DEBUG = ARGS.has('--debug');
const PORT = Number(process.env.PONTIS_E2E_PORT || 8211);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = Number(process.env.PONTIS_E2E_DEBUG_PORT || 9411);
const WORK = path.join(os.tmpdir(), 'pontis-web-e2e');
const DOWNLOADS = path.join(WORK, 'downloads');

const ADMIN = { username: 'admin', password: 'pontis-e2e-admin', display: '站长', email: 'admin@pontis.test' };
const MEMBER = { username: 'member', password: 'pontis-e2e-member', display: '成员' };
const BOB = { username: 'bob', password: 'pontis-e2e-bob', display: 'Bob' };
// The link check runs with the server's own network identity, and its policy
// never opens loopback — a self-hosted scanner must not become a port scanner
// of the machine it sits on (server/internal/organizer/outbound.go). So the
// deterministic reachable target has to be a real public one, and the broken
// one a name DNS refuses instantly (.invalid never resolves, online or not).
const OK_URL = 'https://example.com/';
const DEAD_URL = 'https://e2e-unreachable.invalid/';

const CDP_TIMEOUT_MS = 30_000;
const wsUrlRef = { current: null };
let failed = 0;
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function annotate(message) {
  const oneLine = String(message).replace(/\r/g, '').replace(/\n/g, '%0A').slice(0, 900);
  console.log(`::error::${oneLine}`);
}

function check(ok, label, detail) {
  if (ok) {
    log(`  ok   ${label}`);
    return true;
  }
  failed++;
  log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  annotate(`web e2e check failed: ${label}${detail ? ` — ${detail}` : ''}`);
  return false;
}

const launched = [];
function killGroup(proc) {
  if (!proc || !proc.pid) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  }
}
let serverProc;
function shutdownAll() {
  for (const proc of launched.splice(0)) killGroup(proc);
  if (serverProc) killGroup(serverProc);
}
const die = (msg) => {
  console.error(`web e2e: ${msg}`);
  annotate(`web e2e aborted: ${msg}`);
  shutdownAll();
  process.exit(2);
};
process.on('SIGINT', () => { shutdownAll(); process.exit(130); });
process.on('SIGTERM', () => { shutdownAll(); process.exit(143); });

// --- Chromium ----------------------------------------------------------------

// Same source of browsers as e2e-dual-profile.mjs: whatever Playwright keeps
// in its cache, newest build first. PONTIS_E2E_CHROME overrides.
function chromeExecutable() {
  if (process.env.PONTIS_E2E_CHROME) return process.env.PONTIS_E2E_CHROME;
  const layouts = {
    darwin: {
      root: () => path.join(os.homedir(), 'Library/Caches', 'ms-playwright'),
      dirs: ['chrome-mac', 'chrome-mac-arm64'],
      exe: ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
    },
    linux: {
      root: () => process.env.PLAYWRIGHT_BROWSERS_PATH
        || path.join(os.homedir(), '.cache', 'ms-playwright'),
      dirs: ['chrome-linux', 'chrome-linux64'],
      exe: ['chrome'],
    },
    win32: {
      root: () => path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
      dirs: ['chrome-win', 'chrome-win-x64'],
      exe: ['chrome.exe'],
    },
  };
  const layout = layouts[process.platform] || layouts.linux;
  const root = layout.root();
  if (!existsSync(root)) die(`no playwright browser cache at ${root}; set PONTIS_E2E_CHROME`);
  const builds = readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort()
    .reverse();
  for (const b of builds) {
    for (const dir of layout.dirs) {
      for (const exe of layout.exe) {
        const candidate = path.join(root, b, dir, exe);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  die(`no Google Chrome for Testing binary under ${root}; set PONTIS_E2E_CHROME`);
}

// --- DevTools protocol -------------------------------------------------------

class Session {
  static onHang = null;
  static hangProbed = false;
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.trace = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      // Page exceptions and console errors are the difference between "the
      // modal vanished" and knowing why it vanished.
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        log(`  [page exception] ${(d.exception?.description || d.text || '').slice(0, 300)}`);
      } else if (msg.method === 'Runtime.consoleAPICalled'
        && msg.params.type === 'error') {
        log(`  [page console.error] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
      }
      const hit = this.pending.get(msg.id);
      if (!hit) return;
      this.pending.delete(msg.id);
      msg.error ? hit.reject(new Error(msg.error.message)) : hit.resolve(msg.result);
    });
    ws.addEventListener('close', () => this.failAll(new Error('cdp socket closed')));
  }
  failAll(err) {
    for (const [, hit] of this.pending) hit.reject(err);
    this.pending.clear();
  }
  static async connect(wsUrl, { enableRuntime = true } = {}) {
    const ws = new WebSocket(wsUrl);
    wsUrlRef.current = wsUrl;
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error(`cdp connect failed: ${wsUrl}`)));
    });
    const s = new Session(ws);
    if (enableRuntime) await s.send('Runtime.enable');
    return s;
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // The frozen JS stack is the answer to a hang — probe it the moment
        // the first call times out, while the loop is still running.
        if (typeof Session.onHang === 'function' && !Session.hangProbed) {
          Session.hangProbed = true;
          try { Session.onHang(this.ws.url); } catch { /* probe is best-effort */ }
        }
        reject(new Error(`cdp ${method} never answered`));
      }, CDP_TIMEOUT_MS);
      timer.unref?.();
      const settle = (fn) => (v) => {
        clearTimeout(timer);
        this.pending.delete(id);
        fn(v);
      };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      this.trace.push(`${method}@${Date.now() % 100000}`);
      if (this.trace.length > 14) this.trace.shift();
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  }
  close() {
    this.ws.close();
  }
}

class Browser {
  constructor(debugPort) {
    this.debugPort = debugPort;
    this.dir = path.join(WORK, 'profile');
  }
  async start() {
    const occupied = await fetch(`http://127.0.0.1:${this.debugPort}/json/version`)
      .then((r) => r.ok).catch(() => false);
    if (occupied) die(`debug port ${this.debugPort} is already answering; a stale browser is holding it`);
    mkdirSync(DOWNLOADS, { recursive: true });
    this.chromeLogFd = openSync(path.join(WORK, 'chrome.log'), 'a');
    this.proc = spawn(chromeExecutable(), [
      ...(HEADED ? [] : ['--headless=new']),
      `--user-data-dir=${this.dir}`,
      `--remote-debugging-port=${this.debugPort}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-background-timer-throttling',
      // macOS pops a keychain prompt on the first cookie write and every fetch
      // in the profile hangs behind it — same reason e2e-dual-profile passes it.
      '--use-mock-keychain',
      '--window-size=1440,900',
      '--no-proxy-server',
      ...(process.env.PONTIS_E2E_NO_SANDBOX ? ['--no-sandbox'] : []),
      'about:blank',
    ], { stdio: ["ignore", this.chromeLogFd, this.chromeLogFd], detached: true });
    launched.push(this.proc);
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${this.debugPort}/json/version`)).ok) return;
      } catch { /* not up yet */ }
      await sleep(100);
    }
    throw new Error('devtools never came up');
  }
  /** One tab for the whole run; URL jumps go through Page.navigate. */
  async open(url) {
    await this.sendBrowser('Target.createTarget', { url });
    const session = await this.findPage(url);
    // Transitions (Mantine modals, route fades) move elements while a rect is
    // being measured; the console under test never needs them, so they stop
    // existing for this run.
    await session.evaluate(`${HELPERS}${KILL_ANIMATIONS}`);
    return session;
  }
  async findPage(url, { tries = 100 } = {}) {
    for (let i = 0; i < tries; i++) {
      const list = await (await fetch(`http://127.0.0.1:${this.debugPort}/json/list`)).json();
      const target = list.find((t) => t.url === url && t.webSocketDebuggerUrl);
      if (target) return Session.connect(target.webSocketDebuggerUrl);
      await sleep(150);
    }
    throw new Error(`page ${url} never appeared`);
  }
  async sendBrowser(method, params) {
    if (!this.browserSession) {
      const info = await (await fetch(`http://127.0.0.1:${this.debugPort}/json/version`)).json();
      this.browserSession = await Session.connect(info.webSocketDebuggerUrl, { enableRuntime: false });
    }
    return this.browserSession.send(method, params);
  }
  async enableDownloads() {
    await this.sendBrowser('Browser.setDownloadBehavior', {
      behavior: 'allow', downloadPath: DOWNLOADS, eventsEnabled: false,
    });
  }
  stop() {
    this.browserSession?.close();
    killGroup(this.proc);
  }
}

// --- the server --------------------------------------------------------------

async function startServer() {
  const bin = path.join(ROOT, 'server', 'pontis');
  if (!existsSync(bin)) die('server/pontis missing — run `pnpm build` first');
  const logFd = openSync(path.join(WORK, 'server.log'), 'a');
  serverProc = spawn(bin, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      PONTIS_LISTEN: `127.0.0.1:${PORT}`,
      PONTIS_DATA_DIR: path.join(WORK, 'data'),
      PONTIS_LOG_LEVEL: 'info',
    },
    stdio: DEBUG ? 'inherit' : ['ignore', logFd, logFd],
    detached: true,
  });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${ORIGIN}/api/v1/meta`);
      if (r.ok) return;
    } catch { /* not listening yet */ }
    await sleep(100);
  }
  die('server did not answer /api/v1/meta');
}

function stopServer() {
  if (serverProc) killGroup(serverProc);
  serverProc = undefined;
}

/** Script-side HTTP against the same API the page uses. */
async function api(method, pathname, { body, token, status } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(ORIGIN + pathname, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (status && ![].concat(status).includes(res.status)) {
    throw new Error(`${method} ${pathname} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return { status: res.status, data };
}

// --- page helpers ------------------------------------------------------------

const KILL_ANIMATIONS = `
  if (!document.getElementById('pontis-e2e-no-anim')) {
    const s = document.createElement('style');
    s.id = 'pontis-e2e-no-anim';
    // 1ms, not none: Mantine's Modal/Popover unmount waits for transitionend,
    // and a transition of none never fires it — the closing layer would sit
    // there forever eating the next click.
    s.textContent = '*,*::before,*::after{transition-duration:1ms!important;animation:none!important;scroll-behavior:auto!important}';
    document.head.appendChild(s);
  }
`;

/**
 * Page-side helpers run through Runtime.evaluate. Mantine's class names are
 * generated, so every lookup goes by visible text, label text, role or an
 * aria-label the component itself renders. Visibility uses getClientRects:
 * offsetParent lies for position:fixed elements, which is exactly what Mantine
 * modals, dropdown portals and notifications are.
 */
const HELPERS = `
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const byText = (sel, text, root = document) => [...root.querySelectorAll(sel)]
    .filter(visible).find((el) => (el.textContent || '').trim() === text);
  const byTextIncludes = (sel, text, root = document) => [...root.querySelectorAll(sel)]
    .filter(visible).find((el) => (el.textContent || '').includes(text));
  const labelOf = (el) => (el.querySelector('label')?.textContent || '')
    .replace(/\\s*\\*\\s*$/, '').trim();
  const FIELD_SEL = '.mantine-TextInput-root, .mantine-PasswordInput-root, .mantine-Select-root,'
    + ' .mantine-Textarea-root, .mantine-NumberInput-root, .mantine-TagsInput-root';
  const fieldRoot = (label, root = document) => [...root.querySelectorAll(FIELD_SEL)]
    .filter(visible).find((el) => labelOf(el) === label);
  const inputOf = (root) => root && (root.querySelector('textarea') || root.querySelector('input'));
  const fieldValue = (label, root = document) => inputOf(fieldRoot(label, root))?.value ?? null;
  const rectOf = (el) => {
    if (!el) return null;
    // 'nearest', not 'center': both menu kinds close on scroll, and centering
    // a freshly opened menu item scrolls the page just enough to kill it.
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  };
  const buttonRect = (label, root = document) => rectOf(byText('button', label, root));
  const buttonIncludesRect = (label, root = document) => rectOf(byTextIncludes('button', label, root));
  const buttonReady = (label, root = document) => {
    const b = byText('button', label, root);
    return !!b && !b.disabled;
  };
  // Track the modal CONTENT, not the root shell: a closing modal can leave a
  // laid-out but invisible root behind, which getClientRects alone reports as
  // visible. No content in the DOM means no modal a click can land on.
  const modalRoot = () => {
    const content = [...document.querySelectorAll('.mantine-Modal-content')]
      .filter(visible).pop();
    return content ? content.closest('.mantine-Modal-root') || content : null;
  };
  const modalByTitle = (title) => title
    ? [...document.querySelectorAll('.mantine-Modal-root')].filter(visible)
      .find((m) => (m.querySelector('.mantine-Modal-title')?.textContent || '').trim() === title) || null
    : modalRoot();
  const modalButtonRect = (title, label) => {
    const m = modalByTitle(title);
    return m ? rectOf(byText('button', label, m)) : null;
  };
  const modalButtonReady = (title, label) => {
    const m = modalByTitle(title);
    return !!m && !!byText('button', label, m) && !byText('button', label, m).disabled;
  };
  const typeInto = (label, value, root = document) => {
    const f = fieldRoot(label, root);
    if (!f) return 'no field: ' + label;
    const input = inputOf(f);
    if (!input) return 'no input: ' + label;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'typed';
  };
  const modalFieldValue = (title, label) => {
    const m = modalByTitle(title);
    return m ? fieldValue(label, m) : null;
  };
  const modalType = (title, label, value) => {
    const m = modalByTitle(title);
    return m ? typeInto(label, value, m) : 'no modal: ' + title;
  };
  const selectRect = (label, root = document) => {
    const f = fieldRoot(label, root);
    return f ? rectOf(f.querySelector('input') || inputOf(f)) : null;
  };
  const modalSelectRect = (title, label) => {
    const m = modalByTitle(title);
    return m ? selectRect(label, m) : null;
  };
  // Select dropdown options only — the explorer's own rows are role=option too.
  const optionRect = (text) => rectOf([...document.querySelectorAll('[role="option"]')]
    .filter(visible).filter((o) => o.closest('.mantine-Combobox-option, [class*="option"], [class*="Option"], .mantine-Popover-dropdown'))
    .find((o) => (o.textContent || '').includes(text)));
  const radioRect = (text, root = document) => {
    // Mantine 7 Radio: the root is a DIV holding the radio input and a
    // separate .mantine-Radio-label — the input is not inside any <label>.
    const el = [...root.querySelectorAll('.mantine-Radio-root')].filter(visible)
      .find((r) => (r.querySelector('.mantine-Radio-label')?.textContent || '').trim().startsWith(text));
    return el ? rectOf(el.querySelector('.mantine-Radio-label') || el) : null;
  };
  const segmentRect = (text, root = document) => rectOf([...root.querySelectorAll('[role="radiogroup"] label')]
    .filter(visible).find((el) => (el.textContent || '').includes(text)));
  const checkboxRect = (aria, root = document) => {
    // The aria-label may sit on the native input itself or on its wrapper;
    // the input is visually hidden, so click the wrapper either way.
    const lab = [...root.querySelectorAll('[aria-label]')].filter(visible)
      .find((el) => (el.getAttribute('aria-label') || '') === aria
        && (el.tagName === 'INPUT' || el.querySelector('input[type="checkbox"]')));
    if (!lab) return null;
    const box = lab.tagName === 'INPUT' ? lab : lab.querySelector('input[type="checkbox"]');
    return rectOf(box?.closest('[class*="Checkbox-root"], label') || box?.parentElement || box);
  };
  const tabRect = (text) => rectOf([...document.querySelectorAll('.mantine-Tabs-tab')]
    .filter(visible).find((t) => (t.textContent || '').includes(text)));
  const menuItemRect = (text) => rectOf(
    byText('[role="menuitem"]', text) || byTextIncludes('[role="menuitem"]', text));
  const ariaRect = (aria) => rectOf([...document.querySelectorAll('[aria-label]')]
    .filter(visible).find((el) => (el.getAttribute('aria-label') || '') === aria));
  const tableRowMenuRect = (rowText, aria) => {
    const row = [...document.querySelectorAll('tr, [data-node-id]')]
      .filter(visible).find((r) => (r.textContent || '').includes(rowText)
        && r.querySelector('[aria-label="' + aria + '"]'));
    return row ? rectOf(row.querySelector('[aria-label="' + aria + '"]')) : null;
  };
  const sidebarSpaces = () => [...new Set([...document.querySelectorAll('span')]
    .filter((s) => visible(s) && s.closest('div')?.querySelector('[aria-label="空间操作"]'))
    .map((s) => (s.textContent || '').trim()))].filter((n) => n.length > 0);
  const spanExactRect = (text) => rectOf([...document.querySelectorAll('span')]
    .filter(visible).find((s) => (s.textContent || '').trim() === text));
  // The innermost element carrying exactly this text — sidebar entries are
  // plain divs whose label is a bare text node, not a span or button.
  const exactTextRect = (text) => {
    const hits = [...document.querySelectorAll('div,span,button,a')]
      .filter(visible).filter((el) => (el.textContent || '').trim() === text);
    return rectOf(hits[hits.length - 1]);
  };
  const spanIncludesRect = (text) => rectOf([...document.querySelectorAll('span')]
    .filter(visible).find((s) => (s.textContent || '').includes(text)));
  const spaceMenuRect = (name) => {
    const span = [...document.querySelectorAll('span')].filter(visible)
      .find((s) => (s.textContent || '').trim() === name
        && s.closest('div')?.querySelector('[aria-label="空间操作"]'));
    return span ? rectOf(span.closest('div').querySelector('[aria-label="空间操作"]')) : null;
  };
  const rowByTitle = (title) => {
    const dots = [...document.querySelectorAll('[aria-label]')]
      .find((el) => (el.getAttribute('aria-label') || '') === '更多操作：' + title);
    return dots ? dots.closest('[data-node-id]') : null;
  };
  const rowRect = (title) => rectOf(rowByTitle(title));
  const rowExists = (title) => !!rowByTitle(title);
  const rowInfo = (title) => {
    const row = rowByTitle(title);
    return row ? {
      level: row.getAttribute('aria-level'),
      expanded: row.getAttribute('aria-expanded'),
      selected: row.getAttribute('aria-selected'),
      hasInput: !!row.querySelector('input'),
    } : null;
  };
  const listRowsCount = () => document.querySelectorAll('[data-node-id]').length;
  const rowsInfo = () => [...document.querySelectorAll('[data-node-id]')].map((r) => ({
    level: r.getAttribute('aria-level'), expanded: r.getAttribute('aria-expanded'),
    text: (r.textContent || '').trim().slice(0, 40),
  }));
  const rowChevronRect = (title) => {
    const row = rowByTitle(title);
    return row ? rectOf(row.querySelector('[data-no-select]')) : null;
  };
  const renameInputRect = (title) => {
    const row = rowByTitle(title);
    return row && row.querySelector('input') ? rectOf(row.querySelector('input')) : null;
  };
  const commitRename = (title, value) => {
    const row = rowByTitle(title);
    const input = row && row.querySelector('input');
    if (!input) return 'no rename input: ' + title;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'committed';
  };
  const inspectorText = () => {
    const aside = [...document.querySelectorAll('aside')].filter(visible)
      .find((a) => a.getAttribute('aria-label') === '详情');
    return aside ? aside.innerText : '';
  };
  const toastTexts = () => [...document.querySelectorAll('.mantine-Notification-root')]
    .filter(visible).map((n) => (n.textContent || '').trim());
  const dismissToasts = () => {
    document.querySelectorAll('.mantine-Notification-closeButton').forEach((b) => b.click());
    return 'dismissed';
  };
  const bodyText = () => document.body.innerText;
  const locationHref = () => location.href;
  const selectedRows = () => JSON.stringify(
    [...document.querySelectorAll('[data-node-id][aria-selected="true"]')]
      .map((r) => (r.textContent || '').trim().slice(0, 40)));
  const alertText = () => [...document.querySelectorAll('.mantine-Alert-root')]
    .filter(visible).map((a) => (a.textContent || '').trim()).join(' | ');
  const formSubmitRect = () => rectOf(document.querySelector('form button[type="submit"]'));
  const dropdownOpen = () => !![...document.querySelectorAll('[role="listbox"]')]
    .filter(visible).some((l) => l.closest('.mantine-Popover-dropdown, [class*="dropdown"], [class*="Dropdown"]'));
`;

// Mantine Select/Combobox options live in a portal whose class names differ
// between minor versions; the run only needs "an option list is open now".
const optionsOpen = (text) => `
  [...document.querySelectorAll('[role="option"]')].filter((o) => o.getClientRects().length > 0)
    .some((o) => (o.textContent || '').includes(${JSON.stringify(text)}))
`;

// --- interaction helpers -----------------------------------------------------

async function clickAt(session, boxJson, what) {
  if (!boxJson) throw new Error(`${what}: element not found`);
  const { x, y } = JSON.parse(boxJson);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
  return `clicked (${x},${y})`;
}

async function dblclickAt(session, boxJson, what) {
  if (!boxJson) throw new Error(`${what}: element not found`);
  const { x, y } = JSON.parse(boxJson);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 2 });
  }
  return `double-clicked (${x},${y})`;
}

async function rightClickAt(session, boxJson, what) {
  if (!boxJson) throw new Error(`${what}: element not found`);
  const { x, y } = JSON.parse(boxJson);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', { type, x, y, button: 'right', clickCount: 1 });
  }
  return `right-clicked (${x},${y})`;
}

async function clickButton(session, label, what) {
  await sleep(120);
  return clickAt(session, await session.evaluate(`${HELPERS}return buttonRect(${JSON.stringify(label)});`),
    `${what}: button ${label}`);
}

async function clickButtonIncludes(session, label, what) {
  await sleep(120);
  return clickAt(session, await session.evaluate(`${HELPERS}return buttonIncludesRect(${JSON.stringify(label)});`),
    `${what}: button ~${label}`);
}

async function clickModalButton(session, title, label, what) {
  await sleep(120);
  return clickAt(session,
    await session.evaluate(`${HELPERS}return modalButtonRect(${JSON.stringify(title)}, ${JSON.stringify(label)});`),
    `${what}: modal button ${label}`);
}

async function pressEscape(session) {
  for (const type of ['keyDown', 'keyUp']) {
    await session.send('Input.dispatchKeyEvent', {
      type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
  }
}

async function pressKey(session, key, { code, keyCode, modifiers = 0 } = {}) {
  // Only the keydown: React handlers run on it, and a synthetic keyup that
  // lands while a modal is mounting or unmounting wedges the renderer into a
  // focus ping-pong it never recovers from (probed at VR.capture in debug).
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code: code || key, modifiers,
    windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
  });
}

/**
 * Open a Mantine Select and pick an option by text. Escape first — but only
 * when a dropdown is actually open: inside a modal, Escape with nothing open
 * closes the modal itself, which is not what the step meant.
 */
async function pickOption(session, field, option, what, { modal } = {}) {
  // Never send Escape here: a capture-phase keydown lands in every mounted
  // Modal's global Escape handler (Mantine $4/useModal), and a synthetic
  // Escape during focus hand-back wedged the renderer into an endless loop.
  const rootExpr = modal ? 'modalRoot() || document' : 'document';
  const inputValue = () => session.evaluate(
    `${HELPERS}const root = ${rootExpr}; return fieldValue(${JSON.stringify(field)}, root);`);
  const openDropdown = () => session.evaluate(`${HELPERS}
    const root = ${rootExpr};
    const f = fieldRoot(${JSON.stringify(field)}, root);
    const input = f?.querySelector('input');
    if (!input) return 'no input';
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, keyCode: 40 }));
    return 'opened';`);
  const offered = () => session.evaluate(`${HELPERS}
    return [...document.querySelectorAll('[role="option"]')]
      .filter((o) => o.getClientRects().length > 0
        && o.closest('.mantine-Combobox-option, .mantine-Popover-dropdown'))
      .some((o) => (o.textContent || '').includes(${JSON.stringify(option)}));`);
  const optionBox = () => session.evaluate(`${HELPERS}
    return [...document.querySelectorAll('[role="option"]')]
      .filter((o) => o.getClientRects().length > 0
        && o.closest('.mantine-Combobox-option, .mantine-Popover-dropdown'))
      .filter((o) => (o.textContent || '').includes(${JSON.stringify(option)}))
      .map((o) => rectOf(o))[0] || null;`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const opened = await openDropdown();
    if (opened === 'no input') throw new Error(`${what}: select ${field} not found`);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (await offered()) break;
      await sleep(150);
    }
    const box = await optionBox();
    if (!box) continue;
    await clickAt(session, box, `${what}: option ${option} (attempt ${attempt})`);
    const deadline2 = Date.now() + 4_000;
    while (Date.now() < deadline2) {
      const value = String(await inputValue() || '');
      if (value.includes(option)) return `picked ${option}`;
      await sleep(200);
    }
    // The click did not register the choice; fall through to a retry.
    log(`  step ${what}: option click did not stick (attempt ${attempt}); retrying`);
  }
  // Last resort: type to filter, then Enter — searchable selects select the
  // highlighted option.
  await session.evaluate(`${HELPERS}
    const root = ${rootExpr};
    const f = fieldRoot(${JSON.stringify(field)}, root);
    const input = f?.querySelector('input');
    if (!input) return 'no input';
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
    setter.call(input, ${JSON.stringify(option)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';`);
  await sleep(600);
  await session.evaluate(`${HELPERS}
    const root = ${rootExpr};
    const f = fieldRoot(${JSON.stringify(field)}, root);
    f?.querySelector('input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, keyCode: 13 }));
    return 'enter';`);
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const value = String(await inputValue() || '');
    if (value.includes(option)) return `picked ${option} (typed)`;
    await sleep(200);
  }
  const text = await session.evaluate(`${HELPERS}return bodyText();`).catch((e) => `unreadable (${e.message})`);
  throw new Error(`${what}: select ${field} never accepted ${JSON.stringify(option)} (page: ${String(text).slice(0, 200)})`);
}

function scopedRootExpr(modal, title) {
  return modal && title ? `modalByTitle(${JSON.stringify(title)}) || document` : 'document';
}

async function pickRadio(session, option, what, scope = {}) {
  const box = await session.evaluate(
    `${HELPERS}const _r = ${scopedRootExpr(scope.modal, scope.title)}; return radioRect(${JSON.stringify(option)}, _r);`);
  if (!box) {
    const dump = await session.evaluate(`${HELPERS}
      return JSON.stringify([...document.querySelectorAll('label')]
        .filter((l) => l.getClientRects().length > 0 && l.querySelector('input[type="radio"]'))
        .slice(0, 6).map((l) => ({
          text: (l.textContent || '').trim().slice(0, 40),
          nested: l.querySelector('.mantine-Radio-label')?.textContent?.trim().slice(0, 30) || null,
          cls: String(l.className).slice(0, 50),
        })));`).catch((e) => `dump failed: ${e.message}`);
    const modalDump = await session.evaluate(`${HELPERS}
      return JSON.stringify([...document.querySelectorAll('.mantine-Modal-content')]
        .filter((c) => c.getClientRects().length > 0)
        .map((c) => c.innerText.slice(0, 150)));`).catch((e) => `mdump failed: ${e.message}`);
    log(`  --- ${what}: radio dump --- ${dump} modals=${modalDump}`);
  }
  await clickAt(session, box, `${what}: radio ${option}`);
  await sleep(150);
  return `radio ${option}`;
}

async function pickSegment(session, text, what, scope = {}) {
  const box = await session.evaluate(
    `${HELPERS}const _r = ${scopedRootExpr(scope.modal, scope.title)}; return segmentRect(${JSON.stringify(text)}, _r);`);
  await clickAt(session, box, `${what}: segment ${text}`);
  await sleep(150);
  return `segment ${text}`;
}

async function clickCheckbox(session, aria, what) {
  await sleep(120);
  const box = await session.evaluate(`${HELPERS}return checkboxRect(${JSON.stringify(aria)});`);
  if (!box) {
    const dump = await session.evaluate(`${HELPERS}
      return JSON.stringify({ bodyTail: document.body.innerText.slice(-260) });`)
      .catch((e) => `dump failed: ${e.message}`);
    log(`  --- ${what}: checkbox miss --- ${dump}`);
  }
  return clickAt(session, box, `${what}: checkbox ${aria}`);
}

/**
 * Click a Mantine Menu trigger by aria-label, then one of its items by text.
 * The dropdown is a portal: presence, not position, is what the poll waits for.
 */
// A synthetic click near a just-closed layer can wedge the page into a focus
// ping-pong it never recovers from; a reload resets it and the retry proceeds.
async function reloadForRetry(session, what, marker) {
  await session.send('Page.reload');
  await waitStep(session, `bodyText().includes(${JSON.stringify(marker)})`, 'true',
    `${what}: page reloaded for menu retry`, 20_000);
  await session.evaluate(`${HELPERS}${KILL_ANIMATIONS}`);
}

async function clickMenuItem(session, triggerAria, itemText, what, reloadMarker = '') {
  // A menu that did not open on the first click says nothing about the product
  // — synthetic clicks toggle these open/closed in ways a human finger does
  // not. A click elsewhere dismisses whatever layer is half-open; Escape is
  // never sent here, because a stray keydown in the focus hand-back can wedge
  // the renderer into a loop it never leaves (seen and probed in this suite's
  // own debugging). A reload is the last resort before giving up.
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) {
      await clickAt(session, '{"x":10,"y":10}', `${what}: click away before retry`);
      await sleep(400);
    }
    const triggerBox = await session.evaluate(`${HELPERS}return ariaRect(${JSON.stringify(triggerAria)});`);
    if (!triggerBox) throw new Error(`${what}: menu trigger ${triggerAria} not found`);
    await clickAt(session, triggerBox, `${what}: menu trigger ${triggerAria} (attempt ${attempt})`);
    const deadline = Date.now() + 2_000;
    let box = null;
    while (Date.now() < deadline) {
      box = await session.evaluate(`${HELPERS}return menuItemRect(${JSON.stringify(itemText)});`);
      if (box) break;
      await sleep(150);
    }
    if (box) {
      await clickAt(session, box, `${what}: menu item ${itemText}`);
      await sleep(200);
      return `menu ${triggerAria} → ${itemText}`;
    }
    if (attempt === 2 && reloadMarker) {
      log(`  step ${what}: menu stuck after 2 attempts; reloading the page`);
      await reloadForRetry(session, what, reloadMarker);
    }
  }
  const text = await session.evaluate(`${HELPERS}return bodyText();`).catch((e) => `unreadable (${e.message})`);
  throw new Error(`${what}: menu ${triggerAria} never offered ${JSON.stringify(itemText)} (page: ${String(text).slice(0, 200)})`);
}

/** Open a menu whose trigger is located by an expression, then pick an item. */
async function clickMenuItemAt(session, triggerExpr, itemText, what, reloadMarker = '') {
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) {
      await clickAt(session, '{"x":10,"y":10}', `${what}: click away before retry`);
      await sleep(400);
    }
    const triggerBox = await session.evaluate(`${HELPERS}return ${triggerExpr};`);
    if (!triggerBox) throw new Error(`${what}: menu trigger not found`);
    await clickAt(session, triggerBox, `${what}: menu trigger (attempt ${attempt})`);
    const deadline = Date.now() + 2_000;
    let box = null;
    while (Date.now() < deadline) {
      box = await session.evaluate(`${HELPERS}return menuItemRect(${JSON.stringify(itemText)});`);
      if (box) break;
      await sleep(150);
    }
    if (box) {
      await clickAt(session, box, `${what}: menu item ${itemText}`);
      await sleep(200);
      return `menu → ${itemText}`;
    }
    if (attempt === 2 && reloadMarker) {
      log(`  step ${what}: menu stuck after 2 attempts; reloading the page`);
      await reloadForRetry(session, what, reloadMarker);
    }
  }
  const text = await session.evaluate(`${HELPERS}return bodyText();`).catch((e) => `unreadable (${e.message})`);
  throw new Error(`${what}: menu never offered ${JSON.stringify(itemText)} (page: ${String(text).slice(0, 200)})`);
}

/** Menu whose trigger carries no aria-label, only text (the header 新建). */
async function clickMenuItemByText(session, triggerText, itemText, what) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await sleep(120);
    const triggerBox = await session.evaluate(`${HELPERS}return exactTextRect(${JSON.stringify(triggerText)});`);
    if (!triggerBox) throw new Error(`${what}: menu trigger ${triggerText} not found`);
    await clickAt(session, triggerBox, `${what}: menu trigger ${triggerText} (attempt ${attempt})`);
    const deadline = Date.now() + 2_500;
    let box = null;
    while (Date.now() < deadline) {
      box = await session.evaluate(`${HELPERS}return menuItemRect(${JSON.stringify(itemText)});`);
      if (box) break;
      await sleep(150);
    }
    if (box) {
      await clickAt(session, box, `${what}: menu item ${itemText}`);
      await sleep(200);
      return `menu ${triggerText} → ${itemText}`;
    }
    await clickAt(session, '{"x":10,"y":10}', `${what}: click away before retry`);
  }
  const text = await session.evaluate(`${HELPERS}return bodyText();`);
  throw new Error(`${what}: menu ${triggerText} never offered ${JSON.stringify(itemText)} (page: ${String(text).slice(0, 200)})`);
}

/** The hand-rolled context menu is opened by right-click; only pick the item. */
async function clickMenuItemOpen(session, itemText, what) {
  const deadline = Date.now() + 10_000;
  let box = null;
  while (Date.now() < deadline) {
    box = await session.evaluate(`${HELPERS}return menuItemRect(${JSON.stringify(itemText)});`);
    if (box) break;
    await sleep(150);
  }
  if (!box) {
    const text = await session.evaluate(`${HELPERS}return bodyText();`);
    throw new Error(`${what}: menu never offered ${JSON.stringify(itemText)} (page: ${String(text).slice(0, 200)})`);
  }
  await clickAt(session, box, `${what}: menu item ${itemText}`);
  await sleep(200);
  return `menu item ${itemText}`;
}

/** Row-scoped variant: the trigger sits inside the table row holding rowText. */
async function clickRowMenuItem(session, rowText, triggerAria, itemText, what) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) {
      await clickAt(session, '{"x":10,"y":10}', `${what}: click away before retry`);
      await sleep(400);
    }
    const triggerBox = await session.evaluate(
      `${HELPERS}return tableRowMenuRect(${JSON.stringify(rowText)}, ${JSON.stringify(triggerAria)});`);
    if (!triggerBox) throw new Error(`${what}: row menu trigger ${triggerAria} not found`);
    await clickAt(session, triggerBox, `${what}: row menu ${triggerAria} (attempt ${attempt})`);
    const deadline = Date.now() + 2_000;
    let box = null;
    while (Date.now() < deadline) {
      box = await session.evaluate(`${HELPERS}return menuItemRect(${JSON.stringify(itemText)});`);
      if (box) break;
      await sleep(150);
    }
    if (box) {
      await clickAt(session, box, `${what}: menu item ${itemText}`);
      await sleep(200);
      return `row menu ${itemText}`;
    }
    const dump = await session.evaluate(`${HELPERS}
      return JSON.stringify({
        trigger: !!tableRowMenuRect(${JSON.stringify(rowText)}, ${JSON.stringify(triggerAria)}),
        items: [...document.querySelectorAll('[role="menuitem"]')]
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => (el.textContent || '').trim()),
      });`).catch((e) => `dump failed: ${e.message}`);
    if (attempt === 1) log(`  --- ${what}: row menu miss --- ${dump}`);
  }
  const text = await session.evaluate(`${HELPERS}return bodyText();`).catch((e) => `unreadable (${e.message})`);
  throw new Error(`${what}: row menu never offered ${JSON.stringify(itemText)} (page: ${String(text).slice(0, 200)})`);
}

async function waitStep(session, expr, want, what, timeoutMs = 30_000, failOn = '') {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      last = String(await session.evaluate(`${HELPERS}\nreturn ${expr};`));
    } catch (err) {
      last = `evaluate: ${err.message}`;
      await sleep(500);
      continue;
    }
    if (last.includes(want)) return last;
    if (failOn && last.includes(failOn)) {
      throw new Error(`${what}: page reported failure — ${last.slice(0, 300)}`);
    }
    await sleep(400);
  }
  throw new Error(`${what}: never saw ${JSON.stringify(want)} (last: ${last.slice(0, 300)})`);
}

/**
 * Toasts auto-dismiss, so their window is short: poll hard and fast right
 * after the action, then clear the stack so a later click cannot land on it.
 */
async function waitToast(session, text, what, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = JSON.stringify(await session.evaluate(`${HELPERS}return toastTexts();`));
    if (last.includes(text)) {
      await session.evaluate(`${HELPERS}return dismissToasts();`);
      return last;
    }
    await sleep(120);
  }
  throw new Error(`${what}: toast ${JSON.stringify(text)} never appeared (last: ${last.slice(0, 300)})`);
}

async function runStep(session, expr, label) {
  const out = await session.evaluate(`${HELPERS}\nreturn ${expr};`);
  check(!String(out).startsWith('no ') && out !== 'false' && out !== 'null', label, String(out));
  return out;
}

async function stepShowingPage(what, page, fn) {
  try {
    return await fn();
  } catch (err) {
    const text = String(await page.evaluate(`${HELPERS}return bodyText();`).catch(() => 'unreadable'));
    log(`  --- ${what}: page said --- ${text.split('\n').filter(Boolean).slice(0, 24).join(' / ')}`);
    throw err;
  }
}

/** Drop a file into the page's (FileButton) input — the real parse path. */
async function uploadFile(session, filePath) {
  const { root } = await session.send('DOM.getDocument');
  const { nodeId } = await session.send('DOM.querySelector', {
    nodeId: root.nodeId, selector: 'input[type="file"]',
  });
  if (!nodeId) throw new Error('no file input on the page');
  await session.send('DOM.setFileInputFiles', { files: [filePath], nodeId });
  return 'file set';
}

/** A modal that is still on screen eats the next click at row coordinates. */
async function waitModalGone(session, what, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await session.evaluate(`${HELPERS}return !!modalRoot();`)) return true;
    await sleep(200);
  }
  const dump = await session.evaluate(`${HELPERS}
    const m = modalRoot();
    return JSON.stringify({
      modalTitle: m?.querySelector('.mantine-Modal-title')?.textContent || null,
      modalText: m?.innerText?.slice(0, 300) || null,
    });
  `).catch((e) => 'dump failed: ' + e.message);
  log(`  --- ${what}: stuck modal dump --- ${dump}`);
  throw new Error(`${what}: a modal stayed open`);
}

async function goto(session, pathname, marker, what) {
  await session.send('Page.navigate', { url: `${ORIGIN}${pathname}` });
  await waitStep(session, 'bodyText()', marker, what, 20_000);
}

/** Expand a folder row only when it is not already expanded. */
async function ensureExpanded(session, title, what) {
  // After mutations the tree query may still be settling, so wait for the
  // row itself before measuring its chevron.
  const deadline = Date.now() + 10_000;
  let info = null;
  while (Date.now() < deadline) {
    info = await session.evaluate(`${HELPERS}return rowInfo(${JSON.stringify(title)});`);
    if (info) break;
    await sleep(300);
  }
  if (!info) {
    const rows = await session.evaluate(`${HELPERS}return JSON.stringify(rowsInfo());`)
      .catch((e) => `rows dump failed: ${e.message}`);
    log(`  --- ${what}: rows at miss of ${title} --- ${rows}`);
    throw new Error(`${what}: row ${title} never rendered`);
  }
  if (info.expanded === 'true') return 'already expanded';
  // The chevron carries its own stopPropagation onClick — one plain click is
  // the deterministic toggle, where a synthesized double click is not. After
  // an import the whole subtree re-keys to fresh node ids mid-toggle (the
  // invalidated query swaps the rows), so retry the expand cycle: the newly
  // rendered row starts collapsed and needs its own click.
  for (let attempt = 1; attempt <= 4; attempt++) {
    const box = await session.evaluate(`${HELPERS}return rowChevronRect(${JSON.stringify(title)});`);
    if (!box) throw new Error(`${what}: chevron for ${title} not found`);
    await clickAt(session, box, `${what}: chevron ${title} (attempt ${attempt})`);
    try {
      await waitStep(session, `(rowInfo(${JSON.stringify(title)}) || {}).expanded === 'true'`,
        'true', `${what}: ${title} expanded`, 5_000);
      return 'expanded';
    } catch (err) {
      if (attempt === 4) {
        const diag = await session.evaluate(`${HELPERS}return JSON.stringify({
          rows: rowsInfo(), modalOpen: !!modalRoot(),
          info: rowInfo(${JSON.stringify(title)}),
        });`).catch((e) => 'diag failed: ' + e.message);
        log(`  --- ${what}: expand diag --- ${diag}`);
        throw err;
      }
      await sleep(600);
    }
  }
  return 'expanded';
}

const isAuthPage = () => `['/login', '/setup', '/register', '/reset'].includes(location.pathname)`;

/**
 * Open the command palette (⌘K / ^K — the app accepts either, but which one
 * the synthetic keyboard event counts as differs by platform).
 */
async function openPalette(session, what) {
  for (const modifiers of [2, 4]) {
    await pressKey(session, 'k', { code: 'KeyK', keyCode: 75, modifiers });
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      if (await session.evaluate(`${HELPERS}return bodyText().includes('搜索书签、空间或操作');`)) return true;
      await sleep(200);
    }
  }
  throw new Error(`${what}: command palette never opened`);
}

async function submitForm(session, what) {
  await clickAt(session, await session.evaluate(`${HELPERS}return formSubmitRect();`), `${what}: submit`);
}

async function loginAs(session, username, password, what, marker) {
  await runStep(session, `typeInto('用户名', ${JSON.stringify(username)})`, `${what}: username`);
  await runStep(session, `typeInto('密码', ${JSON.stringify(password)})`, `${what}: password`);
  await submitForm(session, what);
  await waitStep(session, `bodyText().includes(${JSON.stringify(marker)})`, 'true', `${what}: logged in`, 20_000);
}

async function logout(session, what, marker) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await clickAt(session, await session.evaluate(`${HELPERS}return ariaRect('Log out');`), `${what}: log out (attempt ${attempt})`);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await session.evaluate(`${HELPERS}return bodyText().includes('登录到你的书签工作空间');`)) return marker;
      await sleep(250);
    }
  }
  throw new Error(`${what}: logout never reached the login page`);
}

/** Poll the downloads dir the way the export toast names a file. */
async function waitForDownload(ext, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = readdirSync(DOWNLOADS).filter((f) => f.endsWith(ext));
    if (files.length) return path.join(DOWNLOADS, files[files.length - 1]);
    await sleep(300);
  }
  throw new Error(`no *.${ext} download appeared within ${timeoutMs}ms`);
}

// --- the run -----------------------------------------------------------------

async function main() {
  failed = 0;
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  log(`starting the server on ${ORIGIN} (fresh data dir)…`);
  await startServer();

  log('launching Chromium…');
  const browser = new Browser(DEBUG_PORT);
  await browser.start();
  await browser.enableDownloads();
  const page = await browser.open(`${ORIGIN}/`);
  let spaceId = '';
  let workSpaceId = '';
  let adminToken = '';
  let memberSpaceId = '';
  const mainSpace = '主空间';
  let memberSpace = '';
  let defaultSpace = '';

  // ─── 1. 首次初始化与登录 ────────────────────────────────────────────
  log('ch1: setup wizard, login, logout');
  await stepShowingPage('ch1 setup', page, async () => {
    await waitStep(page, isAuthPage() + " && bodyText().includes('初始化 Pontis')", 'true',
      'ch1: uninitialized instance lands on the setup wizard', 20_000);
    // An empty submit shows the form's own validation before anything is sent.
    await submitForm(page, 'ch1: empty submit');
    await waitStep(page, "alertText() + document.body.innerText", '用户名至少 3 个字符',
      'ch1: setup validation blocks an empty form', 10_000);

    await runStep(page, `typeInto('用户名', '${ADMIN.username}')`, 'ch1: username');
    await runStep(page, `typeInto('密码', '${ADMIN.password}')`, 'ch1: password');
    await runStep(page, `typeInto('显示名称', '${ADMIN.display}')`, 'ch1: display name');
    await runStep(page, `typeInto('邮箱 (可选)', '${ADMIN.email}')`, 'ch1: email');
    await submitForm(page, 'ch1: 创建管理员');
    // Setup hands over to the login page — it does not log the new admin in.
    await waitStep(page, "bodyText().includes('登录到你的书签工作空间')", 'true',
      'ch1: setup handed over to the login page', 30_000);
    await loginAs(page, ADMIN.username, ADMIN.password, 'ch1', '个');

    // Setup leaves the instance without any space; the first one is created
    // here and renamed to a stable "main" the later chapters can rely on.
    await waitStep(page, `bodyText().includes('这个空间还是空的') || bodyText().includes('还没有任何空间')`,
      'true', 'ch1: explorer open after login', 20_000);
    defaultSpace = (await page.evaluate(`${HELPERS}return sidebarSpaces();`))[0] || '';
    if (!defaultSpace) {
      await clickAt(page, await page.evaluate(`${HELPERS}return exactTextRect('新建空间');`), 'ch1: 新建空间');
      await waitStep(page, "!!modalByTitle('新建空间')", 'true', 'ch1: create modal open', 10_000);
      await runStep(page, `modalType('新建空间', '空间名称', '${mainSpace}')`, 'ch1: main space name');
      await clickModalButton(page, '新建空间', '创建', 'ch1');
      await waitStep(page, `sidebarSpaces().includes('${mainSpace}')`, 'true', 'ch1: main space created', 15_000);
      defaultSpace = mainSpace;
    }
    const href = await page.evaluate(`${HELPERS}return locationHref();`);
    spaceId = new URL(href).pathname.split('/')[2] || '';
    check(spaceId.length > 0, 'ch1: explorer url carries the space id', href);

    // A Bearer token for the script's own cross-layer checks.
    adminToken = (await api('POST', '/api/v1/auth/login', {
      body: { username: ADMIN.username, password: ADMIN.password }, status: 200,
    })).data.token;

    // Session boundary: anonymous API access is rejected…
    const anon = await api('GET', '/api/v1/spaces', { status: 401 }).catch((e) => ({ status: 0, error: e.message }));
    check(anon.status === 401, 'ch1: anonymous API access stays rejected', JSON.stringify(anon).slice(0, 120));
    // …and the status endpoint honestly reports a closed instance.
    const status = (await api('GET', '/api/v1/system/status', { status: 200 })).data;
    check(status.initialized === true && status.allow_registration === false,
      'ch1: /system/status reports initialized + registration closed', JSON.stringify(status));
    // A second setup is a documented 409, never a second admin.
    const again = await api('POST', '/api/v1/auth/setup', { body: ADMIN, status: 409 }).catch((e) => ({ status: 0, error: e.message }));
    check(again.status === 409, 'ch1: repeating setup is rejected', JSON.stringify(again).slice(0, 120));

    await logout(page, 'ch1');
    await runStep(page, `typeInto('用户名', '${ADMIN.username}')`, 'ch1: username (retry)');
    await runStep(page, `typeInto('密码', 'wrong-password')`, 'ch1: wrong password');
    await submitForm(page, 'ch1: submit wrong credentials');
    await waitStep(page, "alertText()", '用户名或密码错误', 'ch1: wrong password is refused by name', 15_000);
    await loginAs(page, ADMIN.username, ADMIN.password, 'ch1',
      defaultSpace === mainSpace ? '这个空间还是空的' : mainSpace);
    await waitStep(page, `bodyText().includes('这个空间还是空的')`, 'true', 'ch1: explorer open again', 10_000);
  });

  // ─── 2. 空间：新建 / 重命名 / 删除 ─────────────────────────────────
  log('ch2: spaces');
  await stepShowingPage('ch2 spaces', page, async () => {
    if (defaultSpace !== mainSpace) {
      await clickMenuItemAt(page,
        `spaceMenuRect(${JSON.stringify(defaultSpace)})`, '重命名空间', 'ch2', mainSpace);
      await waitStep(page, "!!modalByTitle('重命名空间')", 'true', 'ch2: rename modal open', 10_000);
      await runStep(page, `modalType('重命名空间', '空间名称', '${mainSpace}')`, 'ch2: new name');
      await clickModalButton(page, '重命名空间', '保存', 'ch2');
      await waitStep(page, `sidebarSpaces().includes('${mainSpace}')`, 'true', 'ch2: sidebar shows the rename', 15_000);
    } else {
      check(true, 'ch2: default space already carries the main name', defaultSpace);
    }

    await clickAt(page, await page.evaluate(`${HELPERS}return exactTextRect('新建空间');`), 'ch2: 新建空间');
    await waitStep(page, "!!modalByTitle('新建空间')", 'true', 'ch2: create modal open', 10_000);
    await clickModalButton(page, '新建空间', '创建', 'ch2');
    await waitStep(page, "bodyText().includes('空间名称不能为空')", 'true', 'ch2: empty name is refused', 10_000);
    await runStep(page, `modalType('新建空间', '空间名称', '工作')`, 'ch2: name 工作');
    await clickModalButton(page, '新建空间', '创建', 'ch2');
    await waitStep(page, `sidebarSpaces().includes('工作')`, 'true', 'ch2: 工作 appears in the sidebar', 15_000);

    await clickAt(page, await page.evaluate(`${HELPERS}return exactTextRect('新建空间');`), 'ch2: 新建空间 again');
    await waitStep(page, "!!modalByTitle('新建空间')", 'true', 'ch2: create modal open again', 10_000);
    await runStep(page, `modalType('新建空间', '空间名称', '一次性空间')`, 'ch2: name 一次性空间');
    await clickModalButton(page, '新建空间', '创建', 'ch2');
    await waitStep(page, `sidebarSpaces().includes('一次性空间')`, 'true', 'ch2: disposable space created', 15_000);
    await clickMenuItemAt(page, `spaceMenuRect('一次性空间')`, '删除空间', 'ch2', mainSpace);
    await waitStep(page, "!!modalByTitle('删除空间')", 'true', 'ch2: delete confirm open', 10_000);
    await clickModalButton(page, '删除空间', '确认删除', 'ch2');
    await waitStep(page, `!sidebarSpaces().includes('一次性空间')`, 'true', 'ch2: empty space deleted cleanly', 15_000);
  });

  // ─── 3. 书签树：新建 / 重命名 / 移动 / 详情 / 键盘 / 删除 ─────────
  log('ch3: explorer tree');
  await stepShowingPage('ch3 explorer', page, async () => {
    await clickMenuItemByText(page, '新建', '新建文件夹', 'ch3', mainSpace);
    await waitStep(page, "!!modalByTitle('新建文件夹')", 'true', 'ch3: folder modal open', 10_000);
    await runStep(page, `modalType('新建文件夹', '名称', '工具')`, 'ch3: folder name');
    await clickModalButton(page, '新建文件夹', '创建', 'ch3');
    await waitStep(page, `rowExists('工具')`, 'true', 'ch3: folder row exists', 15_000);

    // The row's ⋯ button opens the same hand-rolled context menu a right-click
    // would — via a plain left click, which does not flake the way synthesized
    // contextmenu events do.
    await clickMenuItem(page, '更多操作：工具', '新建书签', 'ch3');
    await waitStep(page, "!!modalByTitle('新建书签')", 'true', 'ch3: bookmark modal open', 10_000);
    await waitStep(page, "modalByTitle('新建书签').innerText.includes('工具')", 'true',
      'ch3: modal names the parent folder', 10_000);
    await runStep(page, `modalType('新建书签', '名称', 'Go 官网')`, 'ch3: bookmark title');
    await runStep(page, `modalType('新建书签', '链接', 'https://go.dev')`, 'ch3: bookmark url');
    await clickModalButton(page, '新建书签', '创建', 'ch3');
    await waitModalGone(page, 'ch3: bookmark modal closed');
    // The child row only renders once its folder is expanded.
    await ensureExpanded(page, '工具', 'ch3');
    await waitStep(page, `rowExists('Go 官网')`, 'true', 'ch3: bookmark row exists under 工具', 15_000);

    // Root-level bookmarks, including the fixtures later chapters rely on.
    const makeBookmark = async (title, url) => {
      try {
        await clickMenuItemByText(page, '新建', '新建书签', `ch3: 新建 menu (${title})`, mainSpace);
      } catch (menuErr) {
        // The header menu is a popover and popovers are the one surface where
        // synthetic clicks sometimes toggle nothing. The palette offers the
        // same action through a modal, which has never flaked.
        log(`  step ch3: header menu failed (${menuErr.message.split(' (page')[0]}); using the palette`);
        await openPalette(page, `ch3: palette for ${title}`);
        await clickButton(page, '新建书签', `ch3: palette item (${title})`);
      }
      await waitStep(page, "!!modalByTitle('新建书签')", 'true', `ch3: bookmark modal (${title})`, 10_000);
      await runStep(page, `modalType('新建书签', '名称', ${JSON.stringify(title)})`, `ch3: title ${title}`);
      await runStep(page, `modalType('新建书签', '链接', ${JSON.stringify(url)})`, `ch3: url ${url}`);
      await clickModalButton(page, '新建书签', '创建', 'ch3');
      await waitStep(page, `rowExists(${JSON.stringify(title)})`, 'true', `ch3: ${title} exists`, 15_000);
    };
    await makeBookmark('Pontis 文档', 'https://example.com/pontis');
    await makeBookmark('稳定站点', OK_URL);
    await makeBookmark('失效站点', DEAD_URL);
    await makeBookmark('重复书签', 'https://example.com/dup');
    await makeBookmark('重复书签', 'https://example.com/dup');
    // 新建 lands inside the folder the UI currently has selected, so the whole
    // fixture set now lives under 工具 — the suite asserts what the app
    // actually does, not where the script assumed the rows would land.
    await ensureExpanded(page, '工具', 'ch3');

    // Rename through the context menu and the inline input.
    await clickMenuItem(page, '更多操作：Pontis 文档', '重命名', 'ch3', mainSpace);
    await waitStep(page, `rowInfo('Pontis 文档') && rowInfo('Pontis 文档').hasInput`, 'true',
      'ch3: inline rename input appeared', 10_000);
    await runStep(page, `commitRename('Pontis 文档', 'Pontis 手册')`, 'ch3: rename committed');
    await waitStep(page, `rowExists('Pontis 手册') && !rowExists('Pontis 文档')`, 'true',
      'ch3: rename applied', 15_000);

    // Move out of the folder to the root slot — the reverse direction of how
    // the row got in there, exercising both ends of the move modal.
    await clickMenuItem(page, '更多操作：Pontis 手册', '移动到文件夹…', 'ch3', mainSpace);
    await waitStep(page, "!!modalByTitle('移动 1 项')", 'true', 'ch3: move modal open', 10_000);
    await pickOption(page, '目标文件夹', '根目录', 'ch3', { modal: true });
    await clickModalButton(page, '移动 1 项', '移动到此处', 'ch3');
    await waitStep(page, `!rowExists('Pontis 手册') || (rowInfo('Pontis 手册') || {}).level === '1'`,
      'true', 'ch3: bookmark moved to the root slot', 15_000);

    // Inspector via double-click on a bookmark.
    await dblclickAt(page, await page.evaluate(`${HELPERS}return rowRect('稳定站点');`), 'ch3: inspector');
    await waitStep(page, `inspectorText().includes('稳定站点') && inspectorText().includes('example.com')`, 'true',
      'ch3: inspector shows name and host', 10_000);
    await clickAt(page, await page.evaluate(`${HELPERS}return ariaRect('关闭详情');`), 'ch3: close inspector');

    // Keyboard: the list is one tab stop; arrows move the selection.
    await clickAt(page, await page.evaluate(`${HELPERS}return rowRect('稳定站点');`), 'ch3: select a row');
    const firstSel = await page.evaluate(`${HELPERS}return selectedRows();`);
    check(firstSel.includes('稳定站点'), 'ch3: click selects the row', firstSel);
    await pressKey(page, 'ArrowDown', { code: 'ArrowDown', keyCode: 40 });
    await sleep(300);
    const secondSel = await page.evaluate(`${HELPERS}return selectedRows();`);
    check(secondSel !== firstSel, 'ch3: arrow key moved the selection', `${firstSel} → ${secondSel}`);

    // Delete via the keyboard path, then undo it from the activity page.
    const beforeCount = await page.evaluate(`${HELPERS}return listRowsCount();`);
    await clickAt(page, await page.evaluate(`${HELPERS}return rowRect('重复书签');`), 'ch3: select the victim');
    // Focus the list programmatically: clicking the container clears the
    // selection (a press outside rows), and the Delete handler refuses to run
    // with an empty selection.
    await runStep(page, `document.querySelector('[aria-label="书签列表"]').focus(); 'focused'`,
      'ch3: focus the list');
    await pressKey(page, 'Delete', { code: 'Delete', keyCode: 46 });
    await waitStep(page, "!!modalByTitle('删除确认')", 'true', 'ch3: keyboard delete opens the confirm dialog', 10_000);
    await waitStep(page, "modalByTitle('删除确认').innerText.includes('30 天内可以在活动页撤销')", 'true',
      'ch3: dialog explains the undo window', 10_000);
    await clickModalButton(page, '删除确认', '删除', 'ch3');
    await waitStep(page, `listRowsCount() === ${beforeCount - 1}`, 'true', 'ch3: row removed from the tree', 15_000);
    // One of the two identical bookmarks was deleted; the other survives.
    // Both live under the expanded folder, so both titles must still resolve.
    await ensureExpanded(page, '工具', 'ch3');
    const dupLeft = await page.evaluate(`${HELPERS}
      return [...document.querySelectorAll('[data-node-id]')]
        .filter((r) => (r.textContent || '').includes('重复书签')).length;`);
    check(dupLeft === 1, 'ch3: exactly one of the duplicate pair remains', `left=${dupLeft}`);

    await goto(page, `/spaces/${spaceId}/activity`, '最近活动', 'ch3: open activity');
    await waitStep(page, "bodyText().includes('删除')", 'true', 'ch3: activity lists the deletion', 15_000);
    // The delete is the newest entry; its 撤销 sits beside the 删除 label.
    await clickAt(page, await page.evaluate(`${HELPERS}
      const btns = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null
        && (b.textContent || '').trim() === '撤销');
      const match = btns.find((b) => (b.closest('div')?.parentElement?.textContent || '').includes('删除'))
        || btns[0];
      return rectOf(match);`), 'ch3: 撤销 the deletion');
    await waitToast(page, '已撤销', 'ch3: undo acknowledged');
    await waitStep(page, "bodyText().includes('已撤销')", 'true', 'ch3: entry marked undone', 10_000);
    await goto(page, `/spaces/${spaceId}`, mainSpace, 'ch3: back to the space');
    // The reload reset in-memory expansion; the restored child only renders
    // once its folder is open again.
    await ensureExpanded(page, '工具', 'ch3');
    await waitStep(page, `listRowsCount() === ${beforeCount}`, 'true', 'ch3: undo restored the node', 20_000);
  });

  // ─── 4. 导入 / 导出 ────────────────────────────────────────────────
  log('ch4: import/export');
  await stepShowingPage('ch4 transfer', page, async () => {
    // Export as Netscape HTML and read the file off disk.
    await clickAt(page, await page.evaluate(`${HELPERS}return ariaRect('导出书签');`), 'ch4: export button');
    await waitStep(page, "bodyText().includes('导出 —')", 'true', 'ch4: export modal open', 10_000);
    await clickModalButton(page, null, '导出', 'ch4');
    const exported = await waitForDownload('.html');
    const html = readFileSync(exported, 'utf8');
    check(html.includes('<!DOCTYPE NETSCAPE-Bookmark-file-1>'), 'ch4: export is real Netscape HTML', '');
    check(html.includes('https://go.dev') && html.includes('Go 官网'),
      'ch4: export holds the tree, folders included', html.slice(0, 160).replace(/\n/g, ' '));

    // Import it back as a merge — the parse → preview → apply pipeline. The
    // exported tree is the one already on the server, so the plan counts
    // 保留, not 新建; the preview stage itself is what this step proves.
    await clickAt(page, await page.evaluate(`${HELPERS}return ariaRect('导入书签');`), 'ch4: import button');
    await waitStep(page, "bodyText().includes('导入书签 —')", 'true', 'ch4: import modal open', 10_000);
    await uploadFile(page, exported);
    await waitStep(page, "bodyText().includes('导入预览')", 'true', 'ch4: preview counted the plan', 15_000);
    // Regression: the location default snaps to the space's first root slot
    // (it used to stay on a bare 'root:' placeholder the server refused with
    // 500 root slot not found). Confirm with that default — no picking.
    const locDefault = await page.evaluate(`${HELPERS}
      return fieldValue('目标位置', modalRoot());`);
    check(String(locDefault).includes('根目录'),
      'ch4: location default snapped to a real root slot', String(locDefault));
    await clickModalButton(page, null, '确认导入', 'ch4');
    const mergeToast = await waitToast(page, '已导入到', 'ch4: merge import acknowledged');
    log(`  step ch4: merge toast ${mergeToast}`);
    const mainNodes = await api('GET', `/api/v1/spaces/${spaceId}/nodes`, { token: adminToken, status: 200 });
    const mainTitles = (mainNodes.data.nodes || []).map((n) => n.title);
    check(mainTitles.length >= 5, 'ch4: merge import preserved the main tree', mainTitles.join(','));

    // Native JSON round-trip with replace into the second space. The toolbar
    // click can lose the race against a settling toast stack, so retry.
    let exportJsonOpen = false;
    for (let attempt = 1; attempt <= 3 && !exportJsonOpen; attempt++) {
      await clickAt(page, await page.evaluate(`${HELPERS}return ariaRect('导出书签');`), `ch4: export json (attempt ${attempt})`);
      try {
        await waitStep(page, "bodyText().includes('导出 —')", 'true', 'ch4: export modal open again', 5_000);
        exportJsonOpen = true;
      } catch { /* retry */ }
    }
    if (!exportJsonOpen) throw new Error('ch4: export modal never reopened');
    await pickRadio(page, 'Native JSON', 'ch4');
    await clickModalButton(page, null, '导出', 'ch4');
    const exportedJson = await waitForDownload('.json');
    const json = readFileSync(exportedJson, 'utf8');
    check(json.includes('pontis-portable-bookmarks'), 'ch4: native export is the portable format', json.slice(0, 120));

    // Switch to 工作 and replace its empty root with the whole main tree.
    await clickAt(page, await page.evaluate(`${HELPERS}return spanExactRect('工作');`), 'ch4: switch to 工作');
    await waitStep(page, `bodyText().includes('这个空间还是空的')`, 'true', 'ch4: 工作 is empty', 10_000);
    workSpaceId = new URL(await page.evaluate(`${HELPERS}return locationHref();`)).pathname.split('/')[2] || '';
    check(workSpaceId.length > 0 && workSpaceId !== spaceId, 'ch4: second space has its own id', workSpaceId);
    await clickAt(page, await page.evaluate(`${HELPERS}return ariaRect('导入书签');`), 'ch4: import into 工作');
    await waitStep(page, "bodyText().includes('导入书签 —')", 'true', 'ch4: import modal open in 工作', 10_000);
    await pickSegment(page, 'Native JSON', 'ch4');
    await uploadFile(page, exportedJson);
    await waitStep(page, "bodyText().includes('导入预览')", 'true', 'ch4: json preview counted the plan', 15_000);
    await pickRadio(page, '替换(清空后写入)', 'ch4');
    await waitStep(page, "modalRoot() && modalRoot().innerText.includes('安全备份')", 'true',
      'ch4: replace warns about the safety backup', 10_000);
    await clickModalButton(page, null, '确认替换导入', 'ch4');
    await waitToast(page, '已导入到', 'ch4: replace import acknowledged');
    // The server's own tree is the truth about what replace wrote.
    const workNodes = await api('GET', `/api/v1/spaces/${workSpaceId}/nodes`, { token: adminToken, status: 200 });
    const workTitles = (workNodes.data.nodes || []).map((n) => n.title);
    check(workTitles.includes('工具') && workTitles.includes('Pontis 手册'),
      'ch4: server tree of 工作 mirrors the replace import', workTitles.join(','));
    // Regression: the apply must invalidate the tree query — the rows appear
    // in the open explorer without any reload (they used to stay hidden until
    // a manual refresh while the server already held them).
    await ensureExpanded(page, '工具', 'ch4');
    await waitStep(page, `rowExists('Go 官网') && rowExists('稳定站点')`, 'true',
      'ch4: 工作 mirrors the main tree without a reload', 20_000);
    check(true, 'ch4: imported rows appeared in place (no reload)', '');
    await goto(page, `/spaces/${spaceId}`, mainSpace, 'ch4: back to main space');
  });

  // ─── 5. 整理：失效链接与重复书签 ───────────────────────────────────
  log('ch5: organizer');
  await stepShowingPage('ch5 organizer', page, async () => {
    await goto(page, `/spaces/${spaceId}/organizer`, '检查空间内所有书签的可达性', 'ch5: organizer');
    const runCheck = async (label) => {
      if (await page.evaluate(`${HELPERS}return !!ariaRect('重新检查');`)) {
        await clickAt(page, await page.evaluate(`${HELPERS}return ariaRect('重新检查');`), `ch5: recheck (${label})`);
      } else {
        await clickButton(page, '开始检查', 'ch5');
      }
      await waitStep(page, "bodyText().includes('个问题链接') || bodyText().includes('所有链接都可以正常访问')",
        'true', `ch5: check finished (${label})`, 120_000);
      return page.evaluate(`${HELPERS}return bodyText();`);
    };
    let result = await runCheck('first');
    // A check enqueued while the import apply was still committing can read
    // an empty tree; a real user would hit 重新检查, and so does this.
    if (/本次检查 0 个书签/.test(result.replace(/\n/g, ' '))) {
      await sleep(3_000);
      result = await runCheck('recheck after empty scan');
    }
    // The panel can stay on 检查中 while a job retries server-side. A reload
    // drops the page's query cache and re-reads the finished truth.
    if (!/本次检查 [5-9]\d* 个书签/.test(result.replace(/\n/g, ' '))) {
      log('  step ch5: panel unsettled; reloading the organizer');
      await goto(page, `/spaces/${spaceId}/organizer`, '检查空间内所有书签的可达性',
        'ch5: organizer reload');
      for (let i = 0; i < 90; i++) {
        result = await page.evaluate(`${HELPERS}return bodyText();`);
        if (/本次检查 [5-9]\d* 个书签/.test(result.replace(/\n/g, ' '))
          && result.includes('e2e-unreachable.invalid')) break;
        await sleep(1_000);
      }
    }
    // The tab lists ONLY problem rows (healthy ones are filtered out of the
    // UI by design), so the assertions are about the problem list itself.
    check(/本次检查 [5-9]\d* 个书签/.test(result), 'ch5: the summary counts the scanned bookmarks', '');
    check(result.includes('e2e-unreachable.invalid')
      && (result.includes('网络错误') || result.includes('超时')),
      'ch5: the unresolvable host got a failure badge', '');
    check(result.includes('个问题链接'), 'ch5: the summary names the problem count', '');

    // Remove the broken one through the selection checkbox. The problem rows
    // render only in the finished state, and a job retry can flip the view
    // back to 检查中 for a while — poll until the row is actually there.
    let checkboxClicked = false;
    for (let attempt = 0; attempt < 30 && !checkboxClicked; attempt++) {
      try {
        await clickCheckbox(page, '选择 失效站点', 'ch5');
        checkboxClicked = true;
      } catch (err) {
        if (!String(err.message).includes('element not found')) throw err;
        await sleep(1_000);
      }
    }
    check(checkboxClicked, 'ch5: the broken row is selectable', '');
    await sleep(300);
    await clickButtonIncludes(page, '删除所选', 'ch5');
    await waitStep(page, "bodyText().includes('30 天内撤销')", 'true', 'ch5: delete dialog explains undo', 10_000);
    await clickModalButton(page, null, '删除', 'ch5');
    await waitToast(page, '已删除', 'ch5: broken bookmark removed');
    await waitStep(page, `!bodyText().includes('失效站点')`, 'true', 'ch5: broken row gone from the list', 15_000);

    // Duplicates: the surviving pair shows as one group; keep first, drop rest.
    // The segment click can be swallowed right after the modal closed; verify
    // the tab really switched and click again if it did not.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await pickSegment(page, '重复书签', 'ch5');
      const seg = await page.evaluate(`${HELPERS}
        return JSON.stringify({
          dup: (bodyText().includes('组重复') || bodyText().includes('没有发现重复书签')),
          stillLinks: bodyText().includes('个问题链接'),
        });`);
      if (JSON.parse(seg).dup) break;
      log(`  step ch5: duplicates tab not active (attempt ${attempt}) ${seg}`);
      await sleep(500);
    }
    // The expression returns the page tail on timeout, so a red run says what
    // the tab actually showed.
    await waitStep(page,
      "(bodyText().includes('组重复') || bodyText().includes('没有发现重复书签'))"
      + " ? 'yes' : bodyText().slice(-200)",
      'yes', 'ch5: duplicates tab scanned', 20_000);
    const dupText = await page.evaluate(`${HELPERS}return bodyText();`);
    if (dupText.includes('组重复')) {
      await clickButtonIncludes(page, '保留第一项', 'ch5');
      await waitStep(page, "bodyText().includes('这个操作可以在 30 天内撤销')", 'true',
        'ch5: duplicate confirm explains undo', 10_000);
      await clickModalButton(page, null, '删除', 'ch5');
      await waitToast(page, '已删除', 'ch5: duplicates cleaned');
    } else {
      check(true, 'ch5: no duplicate group left to clean', '');
    }
    await goto(page, `/spaces/${spaceId}`, mainSpace, 'ch5: back to main space');
  });

  // ─── 6. 备份：创建 / 恢复 / 安全备份 ───────────────────────────────
  log('ch6: backups');
  await stepShowingPage('ch6 backups', page, async () => {
    await goto(page, `/spaces/${spaceId}/backups`, '创建备份', 'ch6: backups page');
    await clickButton(page, '创建备份', 'ch6');
    await waitToast(page, '已创建备份', 'ch6: manual backup acknowledged');
    await waitStep(page, "bodyText().includes('手动')", 'true', 'ch6: manual backup listed', 15_000);

    await clickRowMenuItem(page, '手动', '备份操作', '恢复到此备份', 'ch6');
    await waitStep(page, "bodyText().includes('将被整体替换为备份里的')", 'true',
      'ch6: restore confirm explains scope', 10_000);
    await clickModalButton(page, null, '开始恢复', 'ch6');
    await waitStep(page, "bodyText().includes('恢复完成')", 'true', 'ch6: restore finished dialog', 30_000);
    const restoreDialog = await page.evaluate(`${HELPERS}return bodyText();`);
    check(/Epoch\s*\d+/.test(restoreDialog), 'ch6: epoch bump announced', '');
    await clickModalButton(page, null, '知道了', 'ch6');

    // The ch4 replace-import must have left an automatic safety backup in 工作.
    await goto(page, `/spaces/${workSpaceId}/backups`, '备份', 'ch6: 工作 backups');
    await waitStep(page, "bodyText().includes('安全')", 'true', 'ch6: replace import left a safety backup', 15_000);
  });

  // ─── 7. 任务：计划 + 立即运行 ─────────────────────────────────────
  log('ch7: tasks');
  await stepShowingPage('ch7 tasks', page, async () => {
    await goto(page, '/tasks', '新建任务', 'ch7: tasks page');
    await clickButton(page, '新建任务', 'ch7');
    await waitStep(page, "!!modalByTitle('新建任务')", 'true', 'ch7: schedule modal open', 10_000);
    await pickOption(page, '任务', '自动备份', 'ch7', { modal: true });
    await pickOption(page, '目标空间', mainSpace, 'ch7', { modal: true });
    await pickSegment(page, '每天', 'ch7', { modal: true });
    await runStep(page, `modalType('新建任务', '时间(HH:MM,本地时间)', '03:00')`, 'ch7: time');
    await clickModalButton(page, '新建任务', '创建', 'ch7');
    await waitToast(page, '任务计划已创建', 'ch7: schedule created');
    await waitStep(page, "bodyText().includes('自动备份')", 'true', 'ch7: schedule row listed', 15_000);

    await clickRowMenuItem(page, '自动备份', '计划任务操作', '立即运行', 'ch7');
    await waitToast(page, '已发起一次立即执行', 'ch7: run now acknowledged');
    await waitStep(page, "bodyText().includes('成功')", 'true', 'ch7: execution succeeded', 60_000, '失败');

    await goto(page, `/spaces/${spaceId}/backups`, '备份', 'ch7: check backups');
    await waitStep(page, "bodyText().includes('定时')", 'true', 'ch7: scheduled run produced a 定时 backup', 20_000);
  });

  // ─── 8. 广场：发布 → 注册成员 → 导入 → 更新 → 再导入 → 取消发布 ──
  log('ch8: plaza');
  await stepShowingPage('ch8 plaza', page, async () => {
    // Publish the 工具 folder from the main space.
    await goto(page, '/plaza', '广场', 'ch8: open plaza');
    await clickAt(page, await page.evaluate(`${HELPERS}
      const b = [...document.querySelectorAll('button')].filter((x) => x.offsetParent !== null)
        .find((x) => (x.textContent || '').trim() === '发布');
      return rectOf(b);`), 'ch8: 发布 button');
    await waitStep(page, "!!modalByTitle('发布到广场')", 'true', 'ch8: publish modal open', 10_000);
    await pickOption(page, '来源空间', mainSpace, 'ch8', { modal: true });
    await pickOption(page, '发布范围', '空间里的一个文件夹', 'ch8', { modal: true });
    await pickOption(page, '发布内容', '工具', 'ch8', { modal: true });
    await runStep(page, `modalType('发布到广场', '标题', 'Go 资源合集')`, 'ch8: title');
    await runStep(page, `modalType('发布到广场', '描述', 'e2e 发布的文件夹')`, 'ch8: description');
    await clickModalButton(page, '发布到广场', '发布', 'ch8');
    await waitToast(page, '已发布', 'ch8: publish acknowledged');
    await waitStep(page, `!!ariaRect('查看发布 Go 资源合集')`, 'true', 'ch8: card visible in the plaza', 15_000);

    // Open registration for the member.
    await goto(page, '/admin/system', '注册模式', 'ch8: admin system settings');
    await pickSegment(page, '开放', 'ch8');
    const status = (await api('GET', '/api/v1/system/status', { status: 200 })).data;
    check(status.allow_registration === true, 'ch8: registration is now open for real', JSON.stringify(status));

    // Member registers and sees none of the admin's spaces.
    await logout(page, 'ch8');
    await waitStep(page, "bodyText().includes('创建账号')", 'true', 'ch8: register link appears once open', 10_000);
    await clickAt(page, await page.evaluate(`${HELPERS}return exactTextRect('创建账号');`), 'ch8: register link');
    await waitStep(page, "!!document.querySelector('form') && bodyText().includes('确认密码')", 'true',
      'ch8: register form mounted', 10_000);
    await runStep(page, `typeInto('用户名', '${MEMBER.username}')`, 'ch8: member username');
    await runStep(page, `typeInto('密码', '${MEMBER.password}')`, 'ch8: member password');
    await runStep(page, `typeInto('确认密码', '${MEMBER.password}')`, 'ch8: member password again');
    await runStep(page, `typeInto('显示名称 (可选)', '${MEMBER.display}')`, 'ch8: member display name');
    await submitForm(page, 'ch8: register submit');
    await waitStep(page, "alertText().includes('账号已创建')", 'true', 'ch8: registration succeeded', 15_000);
    // The member lands on their own fresh explorer, not on any named page.
    await loginAs(page, MEMBER.username, MEMBER.password, 'ch8', '这个空间还是空的');
    await waitStep(page, "bodyText().includes('这个空间还是空的') || bodyText().includes('还没有任何空间')",
      'true', 'ch8: member landed in a fresh space', 20_000);
    const memberSpaces = await page.evaluate(`${HELPERS}return sidebarSpaces();`);
    memberSpace = memberSpaces[0] || '';
    memberSpaceId = new URL(await page.evaluate(`${HELPERS}return locationHref();`)).pathname.split('/')[2] || '';
    check(!memberSpaces.includes(mainSpace), 'ch8: member cannot see the admin space in the sidebar', memberSpaces.join(','));
    check(!memberSpaces.includes('工作'), 'ch8: member cannot see the second space either', memberSpaces.join(','));

    // Server-side boundary: the space API refuses another owner's space.
    const memberProbe = await page.evaluate(`${HELPERS}
      const res = await fetch('/api/v1/spaces/${spaceId}/nodes');
      const res2 = await fetch('/api/v1/admin/users');
      return JSON.stringify({ space: res.status, admin: res2.status });`);
    const probe = JSON.parse(memberProbe);
    check(probe.space === 403, 'ch8: member API read of the admin space is 403', JSON.stringify(probe));
    check(probe.admin === 403, 'ch8: member API read of the admin console is 403', JSON.stringify(probe));
    check(await page.evaluate(`${HELPERS}return spanExactRect('管理') === null;`),
      'ch8: member has no 管理 entry', '');

    // Member imports the publication into their own space.
    await goto(page, '/plaza', '广场', 'ch8: member opens plaza');
    await waitStep(page, `!!ariaRect('查看发布 Go 资源合集')`, 'true', 'ch8: member sees the publication', 15_000);
    await clickAt(page, await page.evaluate(`${HELPERS}return ariaRect('查看发布 Go 资源合集');`), 'ch8: open detail');
    await waitStep(page, "bodyText().includes('导入到空间')", 'true', 'ch8: detail page mounted', 15_000);
    await clickButton(page, '导入到空间', 'ch8');
    await waitStep(page, "bodyText().includes('导入「Go 资源合集」')", 'true', 'ch8: plaza import modal open', 10_000);
    await pickOption(page, '目标空间', memberSpace, 'ch8', { modal: true });
    await pickOption(page, '目标位置', '根目录', 'ch8', { modal: true });
    await pickRadio(page, '合并', 'ch8');
    await clickModalButton(page, null, '预览影响', 'ch8');
    await waitStep(page, "bodyText().includes('预计新建')", 'true', 'ch8: plaza preview produced counts', 15_000);
    await clickModalButton(page, null, '合并导入', 'ch8');
    await waitToast(page, '已导入', 'ch8: member import acknowledged');
    // Walk to the member's explorer to see the imported tree (the plaza hook
    // already invalidates it; the navigation is ordinary, not a workaround).
    await goto(page, `/spaces/${memberSpaceId}`, memberSpace || '空间', 'ch8: member explorer');
    // The plaza import mounts the publication under a folder named after it.
    await ensureExpanded(page, 'Go 资源合集', 'ch8');
    await waitStep(page, `rowExists('Go 官网')`, 'true', 'ch8: publication content in the member tree', 20_000);
    await waitStep(page, "!bodyText().includes('此发布已更新到')", 'true', 'ch8: detail consistent with v1', 15_000);

    // Admin snapshots a change into the publication.
    await logout(page, 'ch8');
    await loginAs(page, ADMIN.username, ADMIN.password, 'ch8', mainSpace);
    await goto(page, `/spaces/${spaceId}`, mainSpace, 'ch8: main space');
    await ensureExpanded(page, '工具', 'ch8');
    await clickMenuItem(page, '更多操作：工具', '新建书签', 'ch8');
    await waitStep(page, "!!modalByTitle('新建书签')", 'true', 'ch8: bookmark modal open', 10_000);
    await runStep(page, `modalType('新建书签', '名称', 'Go 博客')`, 'ch8: new content title');
    await runStep(page, `modalType('新建书签', '链接', 'https://go.dev/blog')`, 'ch8: new content url');
    await clickModalButton(page, '新建书签', '创建', 'ch8');
    await waitStep(page, `rowExists('Go 博客')`, 'true', 'ch8: new content in the folder', 15_000);

    await goto(page, '/plaza', '广场', 'ch8: plaza again');
    await waitStep(page, `!!ariaRect('查看发布 Go 资源合集')`, 'true',
      'ch8: publication card listed for owner', 15_000);
    await clickAt(page, await page.evaluate(`${HELPERS}return ariaRect('查看发布 Go 资源合集');`), 'ch8: detail');
    await waitStep(page, "bodyText().includes('导入到空间')", 'true', 'ch8: detail mounted for owner', 15_000);
    await clickMenuItem(page, '发布操作', '从空间更新快照', 'ch8');
    await waitStep(page, "bodyText().includes('v2')", 'true', 'ch8: snapshot bumped to v2', 20_000);

    // Member sees the update banner and re-imports.
    await logout(page, 'ch8');
    await loginAs(page, MEMBER.username, MEMBER.password, 'ch8', '广场');
    await goto(page, '/plaza', '广场', 'ch8: member plaza');
    await clickAt(page, await page.evaluate(`${HELPERS}return ariaRect('查看发布 Go 资源合集');`), 'ch8: detail again');
    await waitStep(page, "bodyText().includes('此发布已更新到')", 'true', 'ch8: update banner shows', 15_000);
    // 更新到 v2 is a one-click update import (handleUpdateImport) — no modal,
    // the apply runs straight from the button.
    await clickButton(page, '更新到 v2', 'ch8');
    await waitToast(page, '已更新到 v', 'ch8: reimport acknowledged');
    await goto(page, `/spaces/${memberSpaceId}`, memberSpace || '空间', 'ch8: member explorer after v2');
    await ensureExpanded(page, 'Go 资源合集', 'ch8');
    await waitStep(page, `rowExists('Go 博客')`, 'true', 'ch8: v2 content landed in the member tree', 20_000);

    // Owner unpublishes; imported copies stay.
    await logout(page, 'ch8');
    await loginAs(page, ADMIN.username, ADMIN.password, 'ch8', mainSpace);
    await goto(page, '/plaza', '广场', 'ch8: owner plaza');
    await waitStep(page, `!!ariaRect('查看发布 Go 资源合集')`, 'true',
      'ch8: publication card listed for unpublish', 15_000);
    await clickAt(page, await page.evaluate(`${HELPERS}return ariaRect('查看发布 Go 资源合集');`), 'ch8: owner detail');
    await waitStep(page, "bodyText().includes('导入到空间')", 'true', 'ch8: owner detail mounted', 15_000);
    await clickMenuItem(page, '发布操作', '取消发布', 'ch8');
    await waitStep(page, "bodyText().includes('取消发布「Go 资源合集」')", 'true', 'ch8: unpublish confirm', 10_000);
    await clickModalButton(page, null, '取消发布', 'ch8');
    await waitToast(page, '已取消发布', 'ch8: unpublished');
    await waitStep(page, `!ariaRect('查看发布 Go 资源合集')`, 'true', 'ch8: card gone from the plaza', 15_000);
  });

  // ─── 9. 管理：用户生命周期 ─────────────────────────────────────────
  log('ch9: admin users');
  await stepShowingPage('ch9 admin', page, async () => {
    await goto(page, '/admin/users', '新增用户', 'ch9: users tab');
    await clickButton(page, '新增用户', 'ch9');
    await waitStep(page, "!!modalByTitle('新增用户')", 'true', 'ch9: create user modal open', 10_000);
    await runStep(page, `modalType('新增用户', '用户名', '${BOB.username}')`, 'ch9: bob username');
    await runStep(page, `modalType('新增用户', '初始密码', '${BOB.password}')`, 'ch9: bob password');
    await runStep(page, `modalType('新增用户', '确认初始密码', '${BOB.password}')`, 'ch9: bob password again');
    await runStep(page, `modalType('新增用户', '显示名称 (可选)', '${BOB.display}')`, 'ch9: bob display');
    await clickModalButton(page, '新增用户', '创建', 'ch9');
    await waitToast(page, `已创建 ${BOB.username}`, 'ch9: bob created');
    await waitStep(page, `bodyText().includes('${BOB.username}')`, 'true', 'ch9: bob row listed', 15_000);

    // Row menu → confirm modal; the menu item click can be swallowed, so
    // verify the modal and retry the whole sequence when it is not there.
    let disabled = false;
    for (let attempt = 1; attempt <= 3 && !disabled; attempt++) {
      await clickRowMenuItem(page, BOB.username, '用户操作', '禁用', `ch9 (attempt ${attempt})`);
      try {
        // The confirm dialog titles use the DISPLAY name, not the username.
        await waitStep(page, `bodyText().includes('禁用「${BOB.display}」')`, 'true',
          'ch9: disable confirm', 3_000);
        disabled = true;
      } catch { /* retry */ }
    }
    if (!disabled) throw new Error('ch9: disable confirm never opened');
    await clickModalButton(page, null, '确认', 'ch9');
    await waitToast(page, '已禁用', 'ch9: bob disabled');

    await logout(page, 'ch9');
    await runStep(page, `typeInto('用户名', '${BOB.username}')`, 'ch9: bob username');
    await runStep(page, `typeInto('密码', '${BOB.password}')`, 'ch9: bob password');
    await submitForm(page, 'ch9: bob tries to login');
    await waitStep(page, "alertText().includes('已被停用')", 'true', 'ch9: disabled login refused by name', 15_000);

    await loginAs(page, ADMIN.username, ADMIN.password, 'ch9', mainSpace);
    await goto(page, '/admin/users', '新增用户', 'ch9: users tab again');

    await clickRowMenuItem(page, BOB.username, '用户操作', '生成重置密码链接', 'ch9');
    await waitStep(page, `bodyText().includes('「${BOB.display}」的重置链接')`, 'true', 'ch9: reset link modal', 10_000);
    const linkText = await page.evaluate(`${HELPERS}
      const m = modalByTitle('「${BOB.display}」的重置链接') || modalRoot();
      return (m?.innerText || '').split('\\n').find((l) => l.includes('/reset?token=')) || '';`);
    check(linkText.includes('/reset?token='), 'ch9: reset link carries a token', linkText.slice(0, 80));
    await clickModalButton(page, null, '关闭', 'ch9');

    let enabled = false;
    for (let attempt = 1; attempt <= 3 && !enabled; attempt++) {
      await clickRowMenuItem(page, BOB.username, '用户操作', '启用', `ch9 enable (attempt ${attempt})`);
      try {
        await waitStep(page, `bodyText().includes('启用「${BOB.display}」')`, 'true',
          'ch9: enable confirm', 3_000);
        enabled = true;
      } catch { /* retry */ }
    }
    if (!enabled) throw new Error('ch9: enable confirm never opened');
    await clickModalButton(page, null, '确认', 'ch9');
    await waitToast(page, '已启用', 'ch9: bob enabled');

    // Leave the instance as closed as it started.
    await goto(page, '/admin/system', '注册模式', 'ch9: system settings');
    await pickSegment(page, '关闭', 'ch9');
    const closed = (await api('GET', '/api/v1/system/status', { status: 200 })).data;
    check(closed.allow_registration === false, 'ch9: registration closed again', JSON.stringify(closed));
  });

  // ─── 10. 设备：注册 / 撤销 / 删除记录 ──────────────────────────────
  log('ch10: devices');
  await stepShowingPage('ch10 devices', page, async () => {
    await goto(page, '/devices', '添加设备', 'ch10: devices page');
    await clickAt(page, await page.evaluate(`${HELPERS}
      const b = [...document.querySelectorAll('button')].filter((x) => x.offsetParent !== null)
        .find((x) => (x.textContent || '').trim() === '添加设备');
      return rectOf(b);`), 'ch10: 添加设备');
    await waitStep(page, "!!modalByTitle('添加设备')", 'true', 'ch10: add modal open', 10_000);
    await runStep(page, `modalType('添加设备', '设备名称', 'Edge on E2E')`, 'ch10: device name');
    await clickModalButton(page, '添加设备', '注册', 'ch10');
    await waitStep(page, "!!modalByTitle('设备密钥')", 'true', 'ch10: secret step open', 15_000);
    const secret = await page.evaluate(`${HELPERS}
      const m = modalByTitle('设备密钥');
      const lines = (m?.innerText || '').split('\\n').map((l) => l.trim());
      return lines.find((l) => /^[A-Za-z0-9+/=_-]{16,}$/.test(l)) || '';`);
    if (secret.length < 16) {
      const mdump = await page.evaluate(`${HELPERS}
        return modalByTitle('设备密钥')?.innerText?.slice(0, 300) || 'NO MODAL';`)
        .catch((e) => `dump failed: ${e.message}`);
      log(`  --- ch10: secret modal text --- ${JSON.stringify(mdump)}`);
    }
    check(secret.length >= 16, 'ch10: one-time secret is shown once', `${secret.length} chars`);
    await clickModalButton(page, '设备密钥', '我已保存密钥', 'ch10');
    await waitStep(page, `bodyText().includes('Edge on E2E')`, 'true', 'ch10: device row listed', 15_000);

    await clickRowMenuItem(page, 'Edge on E2E', '设备操作', '撤销此设备', 'ch10');
    await waitStep(page, "bodyText().includes('撤销「Edge on E2E」')", 'true', 'ch10: revoke confirm', 10_000);
    await clickModalButton(page, null, '撤销设备', 'ch10');
    await waitToast(page, '已撤销', 'ch10: revoke acknowledged');
    await waitStep(page, "bodyText().includes('已撤销')", 'true', 'ch10: device shows revoked', 15_000);

    await clickRowMenuItem(page, 'Edge on E2E', '设备操作', '删除设备记录', 'ch10');
    await waitStep(page, "bodyText().includes('删除「Edge on E2E」的记录')", 'true', 'ch10: delete confirm', 10_000);
    await clickModalButton(page, null, '删除记录', 'ch10');
    await waitToast(page, '已删除', 'ch10: record deleted');
    await waitStep(page, `!bodyText().includes('Edge on E2E')`, 'true', 'ch10: row gone', 15_000);
  });

  // ─── 11. 设置：资料 / Token / 密码 ─────────────────────────────────
  log('ch11: settings');
  await stepShowingPage('ch11 settings', page, async () => {
    await goto(page, '/settings/account', '个人资料', 'ch11: account tab');
    await runStep(page, `typeInto('显示名称', '站长二号')`, 'ch11: new display name');
    await clickButton(page, '保存', 'ch11');
    await waitToast(page, '资料已更新', 'ch11: profile saved');
    await waitStep(page, `bodyText().includes('站长二号')`, 'true', 'ch11: new name shown', 15_000);

    // API token: create with read+write scopes, prove it works, then revoke.
    await goto(page, '/settings/api-tokens', '创建 Token', 'ch11: token tab');
    await clickButton(page, '创建 Token', 'ch11');
    await waitStep(page, "!!modalByTitle('创建 API Token')", 'true', 'ch11: token modal open', 10_000);
    await runStep(page, `modalType('创建 API Token', '名称', 'e2e-cli')`, 'ch11: token name');
    for (const scope of ['读取书签', '写入书签']) {
      await clickAt(page, await page.evaluate(`${HELPERS}
        const m = modalByTitle('创建 API Token');
        const el = [...m.querySelectorAll('label, button, span')].filter((x) => x.offsetParent !== null)
          .find((x) => (x.textContent || '').trim() === ${JSON.stringify(scope)});
        return rectOf(el);`), `ch11: scope ${scope}`);
    }
    await clickModalButton(page, '创建 API Token', '创建', 'ch11');
    await waitStep(page, "!!modalByTitle('Token 密钥')", 'true', 'ch11: secret step open', 15_000);
    const token = await page.evaluate(`${HELPERS}
      const m = modalByTitle('Token 密钥');
      const input = m?.querySelector('input');
      return input?.value || (m?.innerText || '').split('\\n').find((l) => l.length > 20 && !l.includes('只显示')) || '';`);
    check(token.length >= 20, 'ch11: token secret is shown once', `${token.length} chars`);
    await clickModalButton(page, 'Token 密钥', '我已保存密钥', 'ch11');
    await waitStep(page, "bodyText().includes('e2e-cli')", 'true', 'ch11: token row listed', 15_000);

    const read = await api('GET', `/api/v1/spaces/${spaceId}/nodes`, { token, status: 200 })
      .catch((e) => ({ error: e.message }));
    check(JSON.stringify(read).includes('nodes'), 'ch11: token reads the space it is scoped to',
      JSON.stringify(read).slice(0, 120));
    const write = await api('POST', `/api/v1/spaces/${spaceId}/nodes`, {
      token, status: 201,
      body: { type: 'bookmark', title: 'Token 写入', url: 'https://example.com/token-write', parent: { type: 'root', key: 'main' } },
    }).catch((e) => ({ error: e.message }));
    check(JSON.stringify(write).includes('Token 写入'), 'ch11: token writes with the write scope',
      JSON.stringify(write).slice(0, 120));
    const forbidden = await api('GET', '/api/v1/devices/overview', { token, status: 0 })
      .catch((e) => ({ error: e.message }));
    check(/40[13]/.test(JSON.stringify(forbidden)), 'ch11: token cannot touch session-only routes',
      JSON.stringify(forbidden).slice(0, 120));

    await clickRowMenuItem(page, 'e2e-cli', 'Token 操作', '撤销', 'ch11');
    await waitStep(page, "bodyText().includes('撤销「e2e-cli」')", 'true', 'ch11: revoke confirm', 10_000);
    await clickModalButton(page, null, '撤销', 'ch11');
    await waitToast(page, '已撤销', 'ch11: token revoked');
    const revoked = await api('GET', `/api/v1/spaces/${spaceId}/nodes`, { token, status: 401 })
      .catch((e) => ({ status: 0, error: e.message }));
    check(revoked.status === 401 || JSON.stringify(revoked).includes('401'),
      'ch11: revoked token is dead immediately', JSON.stringify(revoked).slice(0, 120));

    // Password change: sessions die, devices and tokens do not.
    await goto(page, '/settings/account', '修改密码', 'ch11: password form');
    await runStep(page, `typeInto('当前密码', '${ADMIN.password}')`, 'ch11: current password');
    await runStep(page, `typeInto('新密码', 'pontis-e2e-admin2')`, 'ch11: new password');
    await runStep(page, `typeInto('确认新密码', 'pontis-e2e-admin2')`, 'ch11: confirm new password');
    await clickButton(page, '修改密码', 'ch11');
    await waitToast(page, '密码已修改', 'ch11: password changed');

    await logout(page, 'ch11');
    await runStep(page, `typeInto('用户名', '${ADMIN.username}')`, 'ch11: username');
    await runStep(page, `typeInto('密码', '${ADMIN.password}')`, 'ch11: OLD password');
    await submitForm(page, 'ch11: old password submit');
    await waitStep(page, "alertText().includes('用户名或密码错误')", 'true', 'ch11: old password refused', 15_000);
    await loginAs(page, ADMIN.username, 'pontis-e2e-admin2', 'ch11', mainSpace);

    // Put the original password back so the instance ends as it started.
    await goto(page, '/settings/account', '修改密码', 'ch11: account again');
    await runStep(page, `typeInto('当前密码', 'pontis-e2e-admin2')`, 'ch11: current (new) password');
    await runStep(page, `typeInto('新密码', '${ADMIN.password}')`, 'ch11: restore original');
    await runStep(page, `typeInto('确认新密码', '${ADMIN.password}')`, 'ch11: confirm restore');
    await clickButton(page, '修改密码', 'ch11');
    await waitToast(page, '密码已修改', 'ch11: password restored');
  });

  // ─── 12. 搜索与命令面板 ───────────────────────────────────────────
  log('ch12: search');
  await stepShowingPage('ch12 search', page, async () => {
    await goto(page, '/search?q=Go%20%E5%AE%98%E7%BD%91', '个结果', 'ch12: search page');
    await waitStep(page, `bodyText().includes('Go 官网')`, 'true', 'ch12: hit lists the bookmark', 10_000);
    await waitStep(page, `bodyText().includes('${mainSpace}')`, 'true', 'ch12: hit names its space', 10_000);
    await clickAt(page, await page.evaluate(`${HELPERS}
      const hit = [...document.querySelectorAll('[role="button"]')].filter((x) => x.offsetParent !== null)
        .find((x) => (x.textContent || '').includes('Go 官网'));
      return rectOf(hit);`), 'ch12: click the hit');
    await waitStep(page, `locationHref().includes('/spaces/')`, 'true', 'ch12: hit jumps to the space', 15_000);
    await waitStep(page, `(rowInfo('Go 官网') || {}).selected === 'true'`, 'true',
      'ch12: hit focused in the tree', 15_000);

    // Command palette: the header's readOnly opener input opens it on focus —
    // the same affordance a keyboard user gets, without synthetic hotkeys.
    // The AppShell listens for a window keydown (mod+K) and for the palette's
    // own CustomEvent; drive the keyboard path exactly as the browser would.
    const paletteOut = await page.evaluate(`${HELPERS}
      const poll = async () => {
        for (let i = 0; i < 12; i++) {
          if ([...document.querySelectorAll('input')]
            .some((inp) => (inp.placeholder || '').includes('搜索书签、空间或操作'))) return 'opened';
          await new Promise((r) => setTimeout(r, 200));
        }
        return 'not-open';
      };
      window.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'k', code: 'KeyK', ctrlKey: true, metaKey: true, bubbles: true }));
      const viaKey = await poll();
      if (viaKey === 'opened') return 'opened via keydown';
      window.dispatchEvent(new CustomEvent('pontis:open-palette'));
      return await poll();
    `);
    log(`  step ch12: palette attempt ${paletteOut}`);
    if (!String(paletteOut).includes('opened')) {
      check(false, 'ch12: command palette opens', String(paletteOut));
    } else {
      check(true, 'ch12: command palette opens', String(paletteOut));
    }
    // The palette's search field carries the hint as a placeholder attribute,
    // which bodyText never shows — look for the input itself.
    const paletteProbe = "[...document.querySelectorAll('input')]"
      + ".some((i) => (i.placeholder || '').includes('搜索书签、空间或操作')) ? 'yes' : 'no'";
    await waitStep(page, paletteProbe, 'yes', 'ch12: palette visible', 6_000);
    check(true, 'ch12: command palette opens', '');
    await clickAt(page, '{"x":10,"y":10}', 'ch12: click away from palette');
    await waitStep(page, paletteProbe, 'no', 'ch12: palette closed', 10_000);
  });

  if (failed) {
    const text = String(await page.evaluate(`${HELPERS}return bodyText();`).catch(() => 'unreadable'));
    log(`  --- final page tail --- ${text.split('\n').filter(Boolean).slice(-14).join(' / ')}`);
  }

  log('closing the browser and server…');
  browser.stop();
  stopServer();
  if (KEEP) log(`--keep: data and downloads under ${WORK}`);

  if (failed) {
    console.error(`\nweb e2e: ${failed} check(s) failed`);
    process.exit(1);
  }
  log(`\nweb e2e: the whole console walked clean on ${ORIGIN}`);
}

/** When the renderer stops answering, the frozen JS stack is the answer.
 * A second direct WS to the page target is refused, so attach through the
 * browser endpoint with Target.attachToTarget (flatten mode). */
async function probeBusyStack() {
  let ws;
  try {
    const info = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`,
      { signal: AbortSignal.timeout(5_000) })).json();
    ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('probe ws connect timeout')), 10_000);
      ws.addEventListener('open', () => { clearTimeout(t); res(); });
      ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('probe ws error')); });
    });
  } catch (err) {
    log(`busy-stack probe: browser ws unreachable (${err?.message || err})`);
    return;
  }
  try {
    let msgId = 0;
    const waiters = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const hit = waiters.get(msg.id);
      if (hit) { waiters.delete(msg.id); hit(msg); }
      if (msg.method === 'Debugger.paused' && probeBusyStack.paused) {
        probeBusyStack.paused(msg.params.callFrames, msg.params);
      }
    });
    const rpc = (method, params, sessionId) => new Promise((resolve) => {
      const id = ++msgId;
      waiters.set(id, resolve);
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); resolve(null); } }, 6_000);
    });
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`,
      { signal: AbortSignal.timeout(5_000) })).json();
    const pageTarget = targets.find((t) => t.type === 'page' && t.url.startsWith('http'));
    if (!pageTarget) { log('busy-stack probe: no page target'); return; }
    const attached = await rpc('Target.attachToTarget', { targetId: pageTarget.id, flatten: true });
    const sessionId = attached?.result?.sessionId;
    if (!sessionId) { log('busy-stack probe: attach failed'); return; }
    const stack = await new Promise((resolve) => {
      probeBusyStack.paused = (frames) => {
        const top = frames[0];
        probeBusyStack.paused = null;
        rpc('Debugger.resume', {}, sessionId);
        resolve(`${top.functionName || '(anon)'} url=${top.url} line=${top.location.lineNumber}:${top.location.columnNumber}`);
      };
      rpc('Debugger.enable', {}, sessionId);
      setTimeout(() => { if (probeBusyStack.paused) { probeBusyStack.paused = null; resolve('(no pause — busy outside JS or idle)'); } }, 8_000);
      setTimeout(() => rpc('Debugger.pause', {}, sessionId), 400);
    });
    log(`BUSY STACK: ${stack}`);
  } catch (err) {
    log(`busy-stack probe failed: ${err?.message || err}`);
  } finally {
    try { ws.close(); } catch { /* done */ }
  }
}

Session.onHang = () => probeBusyStack();

main().catch(async (err) => {
  console.error(`web e2e: attempt failed: ${err.stack || err.message}`);
  await probeBusyStack();
  annotate(`web e2e attempt failed: ${err.message}`);
  // Headless Chromium occasionally wedges a renderer outright (CDP stops
  // answering even for idle pages — probed: no JS frame, no crash). The run
  // starts from a wiped directory and a fresh server, so one clean re-run
  // costs nothing in correctness and rescues the transient wedge.
  shutdownAll();
  if (process.env.PONTIS_E2E_RETRIED !== '1') {
    log('\nweb e2e: re-running once from a clean state…');
    process.env.PONTIS_E2E_RETRIED = '1';
    try {
      await main();
      return;
    } catch (err2) {
      console.error(`web e2e: re-run failed too: ${err2.stack || err2.message}`);
      annotate(`web e2e threw: ${err2.message}`);
      shutdownAll();
      process.exit(1);
    }
  }
  shutdownAll();
  process.exit(1);
});
