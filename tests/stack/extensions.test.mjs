// The DuckDB extensions dashboards build on, used the way a dashboard uses
// them: through the provisioned datasource, with the local filesystem off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';

test('the discrete global grids answer', async () => {
  // Cell ids are cast to text: as JSON numbers they would lose precision.
  const [row] = await duckdb(
    STACK_URL,
    'SELECT h3_latlng_to_cell(-2.9, -79.0, 7)::VARCHAR AS h3, a5_lonlat_to_cell(-79.0, -2.9, 10)::VARCHAR AS a5',
  );
  assert.deepEqual({ ...row }, { h3: '610509782519906303', a5: '2955903420613001216' });
});

test('raster reads a public COG over HTTPS', async () => {
  // A current Sentinel-2 red band over Cuenca, found through the STAC API
  // rather than hard-coded, so the test does not rot with the archive.
  const [item] = await duckdb(
    STACK_URL,
    'SELECT features[1].assets.red.href AS href ' +
      "FROM read_json('https://earth-search.aws.element84.com/v1/search?collections=sentinel-2-l2a&bbox=-79.1,-2.95,-78.9,-2.85&limit=1')",
  );
  assert.match(item.href, /^https:\/\/.+\.tif$/);
  // raster reads remote files with GDAL's own HTTP client, hence /vsicurl/.
  const [tile] = await duckdb(STACK_URL, `SELECT cols, rows FROM RT_Read('/vsicurl/${item.href}') LIMIT 1`);
  assert.ok(Number(tile.cols) > 0 && Number(tile.rows) > 0, JSON.stringify(tile));
});
