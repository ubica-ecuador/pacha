// The exposure dataset's SQL, taken from the dashboard file and run on the
// server DuckDB with fixed quakes and places in place of the datasets, so
// the distances and sums are known.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { datasetSql, loadDashboard } from '../lib/dashboards.mjs';

const QUAKES = `quakes_fixture AS (SELECT * FROM (VALUES
  ('equator', 0.0, 0.0, 5.0),
  ('small', 0.0, 0.0, 4.0),
  ('antimeridian', -17.9, 179.95, 5.5),
  ('lonely', -50.0, -120.0, 6.0),
  ('arctic', 70.0, 20.0, 5.0)
) AS t(id, latitude, longitude, mag))`;
const PLACES = `places_fixture AS (SELECT * FROM (VALUES
  ('Near', 0.85, 0.0, 1000, 5000),
  ('Nearer', 0.2, 0.0, 300, 900000),
  ('Far', 0.95, 0.0, 7000, 7000),
  ('Across', -17.9, -179.95, 2000, 2500),
  ('Polar', 70.0, 21.5, 400, 400)
) AS t(name, latitude, longitude, pop_min, pop_max))`;

async function exposure() {
  const sql = datasetSql(loadDashboard('dashboards/gallery/earthquakes.json'), 'exposure')
    .replaceAll('$quakes', 'quakes_fixture')
    .replaceAll('$places', 'places_fixture');
  // The dataset's SQL starts with its own WITH; the fixtures go in front of it.
  const merged = sql.replace(/^\s*WITH\s+/i, `WITH ${QUAKES}, ${PLACES}, `);
  const rows = await duckdb(STACK_URL, merged);
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

test('sums pop_min of the places within 100 km and names the largest', async () => {
  const { equator } = await exposure();
  // Near is 94.5 km away, Nearer 22.2 km, Far 105.6 km.
  assert.equal(Number(equator.people_100km), 1300);
  assert.equal(Number(equator.places_100km), 2);
  assert.equal(equator.largest_place, 'Nearer');
  assert.equal(Number(equator.largest_pop), 900000);
});

test('quakes below magnitude 4.5 are left out', async () => {
  assert.equal((await exposure()).small, undefined);
});

test('a place across the antimeridian counts', async () => {
  assert.equal(Number((await exposure()).antimeridian.people_100km), 2000);
});

test('at high latitude a place 1.5 degrees of longitude away still counts', async () => {
  // 1.5° of longitude at 70°N is about 57 km.
  assert.equal(Number((await exposure()).arctic.people_100km), 400);
});

test('a quake with nobody near gets zero, not a missing row', async () => {
  const { lonely } = await exposure();
  assert.equal(Number(lonely.people_100km), 0);
  assert.equal(Number(lonely.places_100km), 0);
  assert.equal(lonely.largest_place, null);
});
