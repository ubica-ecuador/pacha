import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { ADMIN } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';

let browser;
let page;

before(async () => {
  browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: STACK_URL });
  const login = await context.request.post('/login', { data: { user: ADMIN.user, password: ADMIN.password } });
  assert.ok(login.ok(), `login failed: ${login.status()}`);
  page = await context.newPage();
});

after(async () => browser?.close());

test('testing the datasource starts DuckDB in the browser', async () => {
  await page.goto('/connections/datasources/edit/duckdbwasm');
  // A provisioned, read-only datasource offers "Test" instead of "Save & test".
  await page.getByRole('button', { name: /^(Save & test|Test)$/ }).click();
  await page.getByText(/DuckDB v1\.4\.3 is running in the browser\./).waitFor({ timeout: 60_000 });
});

test('spatial works in the browser engine', async () => {
  const point = await page.evaluate(async () => {
    const table = await window.__duckdbwasm.runner.query('SELECT ST_AsText(ST_Point(1, 2)) AS p');
    return table.toArray()[0].toJSON().p;
  });
  assert.equal(point, 'POINT (1 2)');
});

test('other plugins find the engine through window.__chaski, API version 1', async () => {
  const found = await page.evaluate(async () => {
    const api = await window.__chaski?.engine();
    return { apiVersion: window.__chaski?.apiVersion, duckdbVersion: api?.duckdbVersion };
  });
  assert.deepEqual(found, { apiVersion: 1, duckdbVersion: 'v1.4.3' });
});
