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

// The number a stat panel's text shows, understanding thousands separators
// and Grafana's `short`-unit suffixes. Throws if there is no number.
export function parseStatNumber(text) {
  const match = text.match(/(-?\d[\d,]*(?:\.\d+)?)\s*(Mil|Bil|Tri|K|M|B|T)?/i);
  if (!match) throw new Error(`no number in: ${text}`);
  const value = Number(match[1].replace(/,/g, ''));
  const suffix = match[2]?.toUpperCase();
  return suffix ? value * SUFFIXES[suffix] : value;
}

export async function openDashboard(pathAndQuery, { anonymous = true, timeoutMs = 45_000, datasets = [] } = {}) {
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
  await page.goto(pathAndQuery);
  // Finished: panels are on the page, none is loading, and Chaski has loaded
  // its datasets — every one of `datasets` by name, when given, not just any.
  await page.waitForFunction(
    ([loading, names]) =>
      document.querySelectorAll('[data-viz-panel-key]').length > 0 &&
      document.querySelectorAll(loading).length === 0 &&
      (names.length > 0
        ? names.every((name) => window.__duckdbwasm?.stats?.loads?.some((l) => l.name === name && l.ok))
        : (window.__duckdbwasm?.stats?.loads?.length ?? 0) > 0),
    [LOADING, datasets],
    { timeout: timeoutMs, polling: 250 },
  );
  await page.waitForTimeout(500); // one more frame for panels that render after their query
  const loadMs = Date.now() - started;

  return {
    browser,
    page,
    loadMs,
    consoleErrors,
    panelErrors: () => page.locator(ERROR).count(),
    // The number a stat panel shows, read from its container.
    statNumber: async (title) => {
      const panel = page.locator(HEADER(title)).locator('xpath=ancestor::*[@data-viz-panel-key][1]');
      const text = await panel.innerText();
      return parseStatNumber(text.replace(title, ''));
    },
    // A query on Chaski's engine in the page, as a panel would run it.
    chaski: (sql) =>
      page.evaluate(async (statement) => {
        const table = await window.__duckdbwasm.runner.query(statement);
        return table.toArray().map((row) => row.toJSON());
      }, sql),
  };
}
