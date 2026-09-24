// A dashboard opened the way a visitor opens it, waited on until every panel
// has finished, with what the tests assert on.
import { chromium } from 'playwright';
import { ADMIN } from './grafana.mjs';
import { STACK_URL } from './stack.mjs';

const LOADING = '[aria-label="Panel loading bar"]';
const ERROR = '[data-testid="data-testid Panel status error"]';
const HEADER = (title) => `[data-testid="data-testid Panel header ${title}"]`;

export async function openDashboard(pathAndQuery, { anonymous = true, timeoutMs = 45_000 } = {}) {
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
  // Finished: panels are on the page, none is loading, and Chaski has loaded its datasets.
  await page.waitForFunction(
    ([loading]) =>
      document.querySelectorAll('[data-viz-panel-key]').length > 0 &&
      document.querySelectorAll(loading).length === 0 &&
      (window.__duckdbwasm?.stats?.loads?.length ?? 0) > 0,
    [LOADING],
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
      const match = text.replace(title, '').replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
      if (!match) throw new Error(`no number in panel ${title}: ${text}`);
      return Number(match[0]);
    },
    // A query on Chaski's engine in the page, as a panel would run it.
    chaski: (sql) =>
      page.evaluate(async (statement) => {
        const table = await window.__duckdbwasm.runner.query(statement);
        return table.toArray().map((row) => row.toJSON());
      }, sql),
  };
}
