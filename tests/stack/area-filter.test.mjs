// The drawn-area predicate is plain SQL, so the server DuckDB runs it exactly
// as Chaski does in the browser; these cases check it against known shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { areaFilter } from '../lib/templates.mjs';

async function inside(wkt, points) {
  const { cte, predicate } = areaFilter(`'${wkt}'`);
  const values = points.map(([x, y], i) => `(${i}, ${x}::DOUBLE, ${y}::DOUBLE)`).join(', ');
  const rows = await duckdb(
    STACK_URL,
    `WITH ${cte}, pts(i, longitude, latitude) AS (VALUES ${values}) SELECT i, ${predicate} AS inside FROM pts, area ORDER BY i`,
  );
  return rows.map((r) => r.inside);
}

test('no area drawn lets every point through', async () => {
  assert.deepEqual(await inside('', [[0, 0], [179, -89]]), [true, true]);
});

test('a rectangle keeps what is inside it', async () => {
  const square = 'POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))';
  assert.deepEqual(await inside(square, [[5, 5], [15, 5], [-1, -1]]), [true, false, false]);
});

test('a concave polygon excludes its notch', async () => {
  const ell = 'POLYGON((0 0, 10 0, 10 4, 4 4, 4 10, 0 10, 0 0))';
  assert.deepEqual(await inside(ell, [[2, 8], [8, 8], [8, 2]]), [true, false, true]);
});

test('negative and decimal coordinates, as kepler writes them', async () => {
  const cuenca = 'POLYGON((-80.5 -3.5, -78.5 -3.5, -78.5 -1.5, -80.5 -1.5, -80.5 -3.5))';
  assert.deepEqual(await inside(cuenca, [[-79.0, -2.9], [-78.5, -0.2]]), [true, false]);
});
