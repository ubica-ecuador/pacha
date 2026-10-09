// The gfs-wind-synoptic dashboard: provisioned in Gallery, and its two DuckDB
// queries, as the file holds them, answering through Grafana.
//
// Not opened in a browser: the map draws 79,730 rows as streamlines, and under
// the tests' software WebGL that keeps the page too busy to read.
//
// The map's query asks ERDDAP for two days of forecast, which ERDDAP builds on
// the spot: on a miss in the gateway's cache that can take longer than
// Grafana's query timeout. The gateway keeps fetching, so the test asks again,
// as a next visitor would, until the answer is cached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { loadDashboard, panelTitled } from '../lib/dashboards.mjs';

const dashboard = loadDashboard('dashboards/gallery/gfs-wind-synoptic.json');
const sqlOf = (title) => panelTitled(dashboard, title).data.spec.queries[0].spec.query.spec.rawSql;

const patiently = async (sql) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await duckdb(STACK_URL, sql);
    } catch (error) {
      if (attempt === 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
};

test('is provisioned in Gallery', async () => {
  const { status, json } = await api(STACK_URL, '/api/dashboards/uid/gfs-wind-synoptic');
  assert.equal(status, 200);
  assert.equal(json.meta.folderUid, 'gallery');
});

test('the map gets 17 forecast steps on a one-degree lattice, with countries', { timeout: 10 * 60_000 }, async () => {
  const rows = await patiently(sqlOf('Pressure and wind: the synoptic chart'));
  assert.equal(rows.length, 17 * 70 * 67);
  const countries = new Set(rows.map((row) => row.country).filter(Boolean));
  assert.ok(countries.has('Brazil') && countries.has('Ecuador'), [...countries].join(', '));
});

test('the airport table sets METARs against the forecast', { timeout: 10 * 60_000 }, async () => {
  const rows = await patiently(sqlOf('Airports: forecast against observation'));
  assert.ok(rows.length > 100, `only ${rows.length} airports`);
  // Each airport found its GFS cell: the forecast side is never empty.
  assert.ok(rows.every((row) => Number.isFinite(row['GFS kn'])), JSON.stringify(rows.find((row) => !Number.isFinite(row['GFS kn']))));
});
