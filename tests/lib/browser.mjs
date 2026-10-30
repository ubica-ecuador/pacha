// A dashboard opened the way a visitor opens it, waited on until every panel
// has finished, with what the tests assert on.
import { chromium } from 'playwright';
import { ADMIN } from './grafana.mjs';
import { STACK_URL } from './stack.mjs';

const LOADING = '[aria-label="Panel loading bar"]';
const ERROR = '[data-testid="data-testid Panel status error"]';
const HEADER = (title) => `[data-testid="data-testid Panel header ${title}"]`;

// Grafana's `short` unit abbreviates with these suffixes (with or without a
// space before them); each maps to its multiplier. `Mil`/`M`, `Bil`/`B` and
// `Tri`/`T` are the same magnitude under two spellings, so match order
// between a pair never changes the result.
const SUFFIXES = { K: 1e3, M: 1e6, MIL: 1e6, B: 1e9, BIL: 1e9, T: 1e12, TRI: 1e12 };

// Chaski's public API answers in Arrow IPC; the page reads it with the Arrow
// version Chaski is built with, imported once.
const ARROW = 'https://cdn.jsdelivr.net/npm/apache-arrow@17.0.0/+esm';

// The rows a statement returns in the page's Chaski engine, through
// window.__chaski: releases publish no other way in (no window.__duckdbwasm
// since Chaski 2.3.2).
export function chaskiRows(page, sql) {
  return page.evaluate(
    async ([statement, arrow]) => {
      const engine = await window.__chaski.engine();
      window.__pachaArrow ??= import(arrow);
      const { tableFromIPC } = await window.__pachaArrow;
      return tableFromIPC(await engine.queryIPC(statement)).toArray().map((row) => row.toJSON());
    },
    [sql, ARROW],
  );
}

// The number a stat panel's text shows, understanding thousands separators
// and Grafana's `short`-unit suffixes. Throws if there is no number.
export function parseStatNumber(text) {
  const match = text.match(/(-?\d[\d,]*(?:\.\d+)?)\s*(Mil|Bil|Tri|K|M|B|T)?/i);
  if (!match) throw new Error(`no number in: ${text}`);
  const value = Number(match[1].replace(/,/g, ''));
  const suffix = match[2]?.toUpperCase();
  return suffix ? value * SUFFIXES[suffix] : value;
}

export async function openDashboard(pathAndQuery, { anonymous = true, timeoutMs = 45_000, datasets = [], chaski = true } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: STACK_URL, viewport: { width: 1600, height: 1400 } });
  if (!anonymous) {
    const login = await context.request.post('/login', { data: { user: ADMIN.user, password: ADMIN.password } });
    if (!login.ok()) throw new Error(`login failed: ${login.status()}`);
  }
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));
  const started = Date.now();
  // A page that never finishes closes its browser before the error leaves:
  // the caller never gets a handle to close it, and a live browser keeps the
  // test process from ever exiting.
  try {
    await page.goto(pathAndQuery);
    // Finished: panels are on the page, none is loading, and Chaski has loaded
    // its datasets — every one of `datasets` by name, when given, not just any.
    // A dashboard with no Chaski dataset (`chaski: false`) waits for its panels only.
    await page.waitForFunction(
      ([loading, names, chaski]) =>
        document.querySelectorAll('[data-viz-panel-key]').length > 0 &&
        document.querySelectorAll(loading).length === 0 &&
        (!chaski ||
          (() => {
            // window.__chaski hands out the engine as a promise: kept on the page once it resolves.
            const pending = window.__chaski?.engine();
            if (pending && !window.__pachaEngine) pending.then((engine) => (window.__pachaEngine = engine), () => {});
            const loaded = window.__pachaEngine?.datasets().map((d) => d.name) ?? [];
            return names.length > 0 ? names.every((name) => loaded.includes(name)) : loaded.length > 0;
          })()),
      [LOADING, datasets, chaski],
      { timeout: timeoutMs, polling: 250 },
    );
  } catch (error) {
    await browser.close();
    throw error;
  }
  await page.waitForTimeout(500); // one more frame for panels that render after their query
  const loadMs = Date.now() - started;

  // A panel's container, scrolled into view and settled first. Grafana runs a
  // panel's query only once the panel is on screen, so one below the fold of
  // this viewport is empty until it is scrolled to — which is what a visitor
  // does, and what lets the layout be sized for them, not for the viewport.
  const panel = async (title) => {
    const container = page.locator(HEADER(title)).locator('xpath=ancestor::*[@data-viz-panel-key][1]');
    await container.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500); // the lazy-load observer fires, the query starts
    await page.waitForFunction((loading) => document.querySelectorAll(loading).length === 0, LOADING, {
      timeout: timeoutMs,
      polling: 250,
    });
    await page.waitForTimeout(300); // one more frame to render what came back
    return container;
  };

  return {
    browser,
    page,
    loadMs,
    consoleErrors,
    panelErrors: () => page.locator(ERROR).count(),
    panel,
    // The number a stat panel shows, read from its container.
    statNumber: async (title) => {
      const text = await (await panel(title)).innerText();
      return parseStatNumber(text.replace(title, ''));
    },
    // A query on Chaski's engine in the page, as a panel would run it.
    chaski: (sql) => chaskiRows(page, sql),
  };
}
