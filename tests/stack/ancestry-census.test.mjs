// The ancestry-census dashboard: provisioned in Gallery, the files that
// datasets/ancestry/build.sh builds on each instance, and every panel query,
// as the file holds it, answering through Grafana over the Chicago viewport the
// dashboard opens on. Then a visitor opens it and no panel is in error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { findAll, loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/browser.mjs';

const dashboard = loadDashboard('dashboards/gallery/ancestry-census.json');
const FILES = 'http://feeds/datasets/ancestry/';
const panels = findAll(dashboard, (n) => n.kind === 'Panel' && n.spec.data?.spec.queries.length);
const VIEW = { west: '-88.4', south: '41.55', east: '-87.2', north: '42.15', grupo: 'Polish' };
const fill = (sql) => sql.replace(/\$\{(\w+):raw\}/g, (_, name) => VIEW[name]);
const sqlOf = (title) => fill(panelTitled(dashboard, title).data.spec.queries[0].spec.query.spec.rawSql);

test('follows the dashboards conventions', () => {
  assert.equal(dashboard.metadata.name, 'ancestry-census');
  assert.ok(dashboard.spec.description);
  assert.deepEqual(dashboard.spec.tags, ['duckdb', 'kepler', 'business-charts', 'demographics']);
  const text = JSON.stringify(dashboard);
  assert.doesNotMatch(text, /\/testdata|sources-data|host\.docker\.internal/);
  // Every read is of a file built on this instance, served by the gateway.
  for (const url of text.match(/read_parquet\('[^']+'\)/g)) assert.ok(url.includes(FILES), url);
});

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, '/api/dashboards/uid/ancestry-census');
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the built files hold the country: 85,044 tracts, 158 groups, 1.35 million dots', async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT (SELECT count(*) FROM read_parquet('${FILES}tracts.parquet')) AS tracts,
            (SELECT count(*) FROM read_parquet('${FILES}tracts-geom.parquet')) AS polygons,
            (SELECT count(*) FROM read_parquet('${FILES}ancestries.parquet')) AS groups,
            (SELECT count(*) FROM read_parquet('${FILES}dots.parquet')) AS dots,
            (SELECT sum(total_pop) FROM read_parquet('${FILES}tracts.parquet')) AS people`,
  );
  assert.equal(row.tracts, 85044);
  assert.equal(row.polygons, 85044);
  assert.equal(row.groups, 158);
  // One dot per 250 people, give or take each tract's rounding.
  assert.ok(Math.abs(row.dots - row.people / 250) / row.dots < 0.01, JSON.stringify(row));
});

test('every panel answers over Chicago, with Chicago in it', async () => {
  for (const panel of panels) {
    const rows = await duckdb(STACK_URL, fill(panel.spec.data.spec.queries[0].spec.query.spec.rawSql));
    assert.ok(rows.length > 0, panel.spec.title);
  }
  const dots = await duckdb(STACK_URL, sqlOf('The mosaic · one dot = 250 people'));
  assert.ok(dots.length > 10_000, `${dots.length} dots`);
  assert.ok(dots.every((d) => d.state === 'IL' || d.state === 'IN'), 'a dot outside Illinois and Indiana');
  const [summary] = await duckdb(STACK_URL, sqlOf('Viewport summary'));
  const people = Object.values(summary)[0];
  assert.ok(people > 5e6 && people < 1e7, `${people} people in the Chicago viewport`);
});

test('opens with no panel in error', { timeout: 300_000 }, async () => {
  const view = await openDashboard('/d/ancestry-census', { chaski: false, timeoutMs: 120_000 });
  try {
    assert.equal(await view.panelErrors(), 0);
  } finally {
    await view.browser.close();
  }
});
