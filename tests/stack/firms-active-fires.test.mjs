// firms-active-fires: FIRMS detections in Chaski, plus CAMS smoke (omaod550)
// as an hourly Zarr catalogue on the map (each hour reuses the latest daily
// analysis), sharing t0/t1 with the time brush.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, rowsOf } from '../lib/grafana.mjs';
import { loadDashboard, panelTitled } from '../lib/dashboards.mjs';
import { STACK_URL } from '../lib/stack.mjs';

const UID = 'firms-active-fires';
const dashboard = loadDashboard(`plus/dashboards/${UID}.json`);
const map = panelTitled(dashboard, 'Where: fire in the window');
const smokeSql = map.data.spec.queries.find((q) => q.spec.refId === 'B').spec.query.spec.rawSql;
const opts = map.vizConfig.spec.options;
const { from, to } = dashboard.spec.timeSettings;

const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const skip = provisioned.status === 404 && 'Kepler Plus is not mounted';

async function duckdb(rawSql) {
  const res = await api(STACK_URL, '/api/ds/query', {
    method: 'POST',
    body: {
      from,
      to,
      queries: [
        {
          refId: 'A',
          datasource: { uid: 'duckdb', type: 'motherduck-duckdb-datasource' },
          rawSql,
          rawQuery: true,
          format: 1,
        },
      ],
    },
  });
  assert.equal(res.status, 200, res.text.slice(0, 500));
  return rowsOf(res.json);
}

test('follows the dashboards conventions', { skip }, () => {
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description);
  assert.ok(dashboard.spec.tags.includes('plus') && dashboard.spec.tags.includes('chaski'));
  assert.equal(opts.rasterServerUrl, '/titiler');
  assert.equal(opts.zarrRescale, '0,1');
  assert.equal(opts.timeSync, 'variables');
  assert.deepEqual(opts.timeVariables, { from: 't0', to: 't1' });
  // The fire cells are already aggregated for t0/t1 in SQL. A kepler time
  // filter on that dataset stays on the previous window (sync only moves the
  // first filter) and hides the new cells, so the map misses the brush.
  const timeFilters = opts.mapConfig.config.visState.filters.filter((f) => f.type === 'timeRange');
  assert.equal(timeFilters.length, 1);
  assert.deepEqual(timeFilters[0].dataId, ['grafana-B-zarr-times']);
  assert.ok(!JSON.stringify(timeFilters).includes('grafana-A'));
  assert.ok(!JSON.stringify(timeFilters).includes('last_seen'));
  const fireSql = map.data.spec.queries.find((q) => q.spec.refId === 'A').spec.query.spec.rawSql;
  assert.match(fireSql, /seen %d %b at %H:%M UTC/);
  assert.doesNotMatch(fireSql, /%Y-%m-%d/);
  const rollup = dashboard.spec.variables.find((v) => v.spec.name === 'fires_by_day');
  assert.match(rollup.spec.query.spec.source.sql, /date_trunc\('day', time\)/);
  assert.match(rollup.spec.query.spec.source.sql, /FROM \$fires\b/);
  assert.doesNotMatch(JSON.stringify(dashboard), /titiler\.ubica|pacha-titiler/);
});

test('is provisioned in Plus', { skip }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
});

test('CAMS smoke is stamped hourly and a short daytime brush still hits a scene', { skip }, async () => {
  const rows = await duckdb(smokeSql);
  assert.ok(rows.length >= 24 * 5, `got ${rows.length} hours`);
  assert.ok(rows.every((r) => r.zarr_variable === 'omaod550' && r.zarr_sel === 'time_step=0'));
  assert.ok(rows.every((r) => String(r.zarr_url).includes('cams_global_atmospheric_composition')));

  const t0 = Date.parse('2026-10-13T02:00:00.000Z');
  const t1 = Date.parse('2026-10-13T08:00:00.000Z');
  const inWin = rows.filter((r) => r.time >= t0 && r.time <= t1);
  assert.ok(inWin.length >= 3, `brush window hours: ${inWin.length}`);
  assert.equal(inWin.at(-1).zarr_time_label.slice(0, 10), '2026-10-13');

  // Today has no analysis yet and yesterday may not either: the last days
  // repeat the newest day the tiler can draw, never a day it would answer 500.
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const dayBefore = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  const todayRows = rows.filter((r) => new Date(r.time).toISOString().slice(0, 10) === today);
  assert.ok(todayRows.length > 0);
  const newest = todayRows[0].zarr_time_label;
  assert.ok([yesterday, dayBefore].includes(newest.slice(0, 10)), newest);
  assert.ok(todayRows.every((r) => r.zarr_time_label === newest));
  const last = rows.at(-1);
  const info = await api(STACK_URL, `/titiler/zarr/info?${new URLSearchParams([
    ['url', last.zarr_url], ['variable', last.zarr_variable], ['sel', last.zarr_sel], ['sel', `time=${newest}`],
  ])}`);
  assert.equal(info.status, 200, `the tiler cannot draw ${newest}: ${info.text.slice(0, 200)}`);
});

// A click on a fire cell writes flat/flng/fday0/fday1; the Sentinel-2 panels
// below read them. The click itself needs a real pointer (kepler ignores
// Playwright's synthetic one), so the tests set the variables it would set.
const sentinel = panelTitled(dashboard, 'Sentinel-2 over the clicked fire: before | after');
const elementSql = (name) => dashboard.spec.elements[name].spec.data.spec.queries[0].spec.query.spec.rawSql;
const withVars = (sql, vars) => sql.replace(/\$(\w+)/g, (m, k) => (k in vars ? `'${vars[k]}'` : m));

test('a click on a fire hands its cell and days to the Sentinel-2 panels', { skip }, () => {
  const clicks = opts.variableMappings.filter((m) => m.source === 'click');
  assert.deepEqual(
    clicks.map((m) => [m.field, m.variable]),
    [['latitude', 'flat'], ['longitude', 'flng'], ['first_day', 'fday0'], ['last_day', 'fday1']],
  );
  const fireSql = map.data.spec.queries.find((q) => q.spec.refId === 'A').spec.query.spec.rawSql;
  for (const column of ['latitude', 'longitude', 'first_day', 'last_day']) assert.match(fireSql, new RegExp(`AS ${column}\\b`));
  const s2 = sentinel.vizConfig.spec.options;
  assert.equal(s2.rasterServerUrl, '/titiler');
  assert.equal(s2.mapConfig.config.mapState.mapSplitMode, 'SWIPE_COMPARE');
  // Before on the left, after on the right. kepler saves only the layers whose
  // dataset is loaded, so a save with no fire clicked drops these two and both
  // scenes land on both sides: put them back if this fails.
  const vs = s2.mapConfig.config.visState;
  const layer = (id) => vs.layers.find((l) => l.id === id);
  assert.equal(layer('s2scene-before')?.config.dataId, 'grafana-D-raster');
  assert.equal(layer('s2scene')?.config.dataId, 'grafana-B-raster');
  assert.deepEqual(vs.splitMaps.map((m) => [m.layers['s2scene-before'], m.layers.s2scene]), [[true, false], [false, true]]);
  assert.ok(s2.variableMappings.some((m) => m.source === 'center' && m.variable === 'flat' && m.variableTo === 'flng'));
});

test('the strongest fire of the window finds Sentinel-2 scenes before it', { skip }, async () => {
  const [cell] = await duckdb(`
    SELECT avg(ST_Y(geometry)) AS lat, avg(ST_X(geometry)) AS lng,
           (min(acq_datetime)::DATE - DATE '1970-01-01')::INTEGER AS d0,
           (max(acq_datetime)::DATE - DATE '1970-01-01')::INTEGER AS d1
    FROM read_parquet('https://data.source.coop/portolan-mirrors/firms-catalog/detections/year=' || year(current_date)::VARCHAR || '/live.parquet')
    GROUP BY floor(ST_Y(geometry) * 10), floor(ST_X(geometry) * 10)
    ORDER BY sum(frp) DESC LIMIT 1`);
  const vars = {
    flat: String(cell.lat), flng: String(cell.lng), fday0: String(cell.d0), fday1: String(cell.d1),
    days: '10', lookback: '90', sceneBefore: '', sceneAfter: '', s2cloud: '40', s2cover: '50', bands: 'forestBurn',
  };
  const [figures] = await duckdb(withVars(elementSql('panel-sentinel-catalogue'), vars));
  assert.equal(figures.HTTP, '200');
  assert.ok(figures.Matched > 0, 'the catalogue found no scene of the cell');
  assert.notEqual(figures.Before, 'none in range');
  // No cloud cut after the fire, and the newest before scene when none exists
  // yet: the right side of the curtain is never blank while the catalogue has
  // anything for the cell.
  assert.notEqual(figures.After, 'none in range');

  const scenes = await duckdb(withVars(elementSql('panel-sentinel-scenes'), vars));
  const before = scenes.filter((r) => r.Side === 'Before');
  assert.ok(before.length > 0 && before.length <= 6, `${before.length} before rows`);
  assert.equal(scenes.filter((r) => r.Map === '◀').length, 1, 'one scene marked as drawn on the left');
  assert.ok(scenes.every((r) => String(r.View).startsWith('/titiler/stac/bbox/')));
});

test('the Sentinel-2 row opens under the fire map only once a fire is clicked', { skip }, () => {
  const rows = dashboard.spec.layout.spec.rows;
  const names = (r) => r.spec.layout.spec.items.map((i) => i.spec.element.name);
  const shownWhen = (r) => r.spec.conditionalRendering?.spec.items.map((i) => [i.spec.variable, i.spec.operator, i.spec.value]);
  assert.deepEqual(rows.map((r) => r.spec.title), ['Fire', 'Hint', 'Sentinel-2', 'More']);
  assert.ok(names(rows[0]).includes('panel-map'));
  assert.deepEqual(names(rows[2]).sort(), ['panel-sentinel', 'panel-sentinel-catalogue', 'panel-sentinel-scenes']);
  assert.deepEqual(shownWhen(rows[2]), [['flat', 'notEquals', '']]);
  assert.deepEqual(shownWhen(rows[1]), [['flat', 'equals', '']]);
});

test('the daily rollup answers whole days only; a brush that cuts a day reads the points', { skip }, () => {
  const users = Object.entries(dashboard.spec.elements)
    .flatMap(([name, el]) => el.spec.data.spec.queries.map((q) => [name, q.spec.query.spec.rawSql ?? '']))
    .filter(([, sql]) => sql.includes('$fires_by_day'));
  assert.ok(users.length >= 8, `${users.length} queries read the rollup`);
  for (const [name, sql] of users) {
    // A day stamped 00:00 fails `time >= t0` for t0 = 02:00, and the panel went
    // to zero: the rollup is cut by d0/d1 (whole days), never by t0/t1.
    const rollup = sql.slice(sql.indexOf('FROM $fires_by_day'), sql.indexOf('UNION ALL'));
    assert.match(rollup, /time >= sel\.d0/, name);
    assert.doesNotMatch(rollup, /time >= sel\.t0/, name);
    assert.match(sql, /FROM \$fires, sel/, `${name} reads the cut days from the points`);
  }
});

test('the brush opens on yesterday, and a link keeps its own window', { skip }, async () => {
  const day = (name) => dashboard.spec.variables.find((v) => v.spec.name === name).spec;
  const [t0] = await duckdb(day('t0').query.spec.__legacyStringValue);
  const [t1] = await duckdb(day('t1').query.spec.__legacyStringValue);
  const from = Object.values(t0)[0];
  const to = Object.values(t1)[0];
  assert.match(from, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  assert.equal(Date.parse(to) - Date.parse(from), 864e5);
  assert.equal(to.slice(0, 10), new Date().toISOString().slice(0, 10));
  for (const name of ['t0', 't1']) assert.equal(day(name).allowCustomValue, true, `${name} must take the brush's values`);
});
