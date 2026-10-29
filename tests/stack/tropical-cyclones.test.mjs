// The tropical-cyclones dashboard: provisioned in Plus, its storm list, its two
// Chaski datasets and the map's server queries, as the file holds them,
// answering through Grafana, and the page opening with no panel or Mosaic chart
// in error. It needs Kepler Plus (compose.plus.yaml): without it, the tests are
// skipped.
//
// The data is live (GDACS's advisories, NOAA GFS on ERDDAP, IBTrACS, NASA GIBS,
// the NHC and JTWC wind chances on Esri's Living Atlas), so the checks are about
// shape and sanity, on the storm the dashboard opens on: the first of its list.
// A quiet fortnight with no storm at all skips them.
//
// GDACS can take up to 30 s to build an answer, and ERDDAP a GFS box longer
// than Grafana waits for on a miss. The gateway keeps fetching, so a query is
// asked again, as a next visitor would, until it is cached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, duckdb } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';
import { loadDashboard, findAll } from '../lib/dashboards.mjs';
import { openDashboard } from '../lib/browser.mjs';

const UID = 'tropical-cyclones';
const dashboard = loadDashboard(`plus/dashboards/${UID}.json`);
const provisioned = await api(STACK_URL, `/api/dashboards/uid/${UID}`);
const noPlus = provisioned.status === 404 && 'Kepler Plus is not mounted';

const variable = (name) => dashboard.spec.variables.find((v) => v.spec.name === name).spec.query.spec;
const datasetSql = (name) => variable(name).source.query.rawSql;
const map = findAll(dashboard, (n) => n.id === 11 && n.vizConfig)[0];
const mapSql = (refId) => map.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;

const storms = noPlus ? [] : await duckdb(STACK_URL, variable('storm').__legacyStringValue);
const storm = storms[0]?.__value;
const skip = noPlus || (!storm && 'GDACS has no storm in the last two weeks');
// The DuckDB datasource quotes a variable's value; so does this.
const forStorm = (sql, switches = 'on') =>
  ['rain', 'isobars', 'satellite', 'windchance'].reduce(
    (out, name) => out.replaceAll(`$${name}`, `'${switches}'`),
    sql.replaceAll('$storm', `'${storm}'`)
  );

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

test('is provisioned in Plus, with its tags and description', { skip: noPlus }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description.length > 50);
  for (const tag of ['plus', 'chaski', 'duckdb', 'mosaic']) assert.ok(dashboard.spec.tags.includes(tag), tag);
});

test('GDACS, ERDDAP and IBTrACS are read through the gateway, never directly', () => {
  const sql = findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql.replace(/^\s*--.*$/gm, '')).join('\n');
  for (const route of ['http://feeds/gdacs/', 'http://feeds/erddap/', 'http://feeds/ibtracs/']) assert.ok(sql.includes(route), route);
  assert.ok(!/https?:\/\/(www\.)?(gdacs\.org|ncei\.noaa\.gov)|pacioos/.test(sql));
});

test('the storm list has ids, the active storms first', { skip }, () => {
  for (const row of storms) assert.match(row.__value, /^[0-9]+$/, JSON.stringify(row));
  const ended = storms.map((row) => row.__text.includes(' · ended '));
  assert.deepEqual(ended, [...ended].sort((a, b) => a - b), 'an ended storm before an active one');
});

test('the storm hour by hour: one row an hour, sane winds, Saffir-Simpson categories', { skip, timeout: 10 * 60_000 }, async () => {
  const rows = await patiently(forStorm(datasetSql('track')));
  assert.ok(rows.length >= 6, `${rows.length} hours`);
  const categories = new Set(['Tropical depression', 'Tropical storm', 'Category 1', 'Category 2', 'Category 3', 'Category 4', 'Category 5']);
  rows.forEach((row, i) => {
    assert.ok(Math.abs(row.latitude) <= 60 && row.wind_kt > 0 && row.wind_kt < 200, JSON.stringify(row));
    assert.ok(categories.has(row.category), row.category);
    assert.ok(['Observed', 'Forecast'].includes(row.phase), row.phase);
    if (i > 0) assert.equal(row.time - rows[i - 1].time, 3_600_000, `hour ${i}`);
  });
});

test('the last three seasons: thousands of fixes in several basins', { skip: noPlus, timeout: 10 * 60_000 }, async () => {
  const rows = await patiently(datasetSql('season'));
  assert.ok(rows.length > 3000, `${rows.length} fixes`);
  assert.ok(new Set(rows.map((row) => row.basin)).size >= 4);
  for (const row of rows.slice(0, 500)) assert.ok(row.peak_kt >= row.wind_kt && row.days > 0, JSON.stringify(row));
});

test('GFS around the storm: whole degrees, every six hours of its past and three of the next two days', { skip, timeout: 10 * 60_000 }, async () => {
  const rows = await patiently(forStorm(mapSql('G')));
  const steps = [...new Set(rows.map((row) => row.time))].sort((a, b) => a - b);
  // Nine days at most: 36 six-hour steps, or fewer with the forecast's three-hour ones.
  assert.ok(steps.length >= 1 && steps.length <= 9 * 8 + 1, `${steps.length} steps`);
  for (let i = 1; i < steps.length; i++) {
    const gap = steps[i] - steps[i - 1];
    assert.ok(gap === 3 * 3_600_000 || gap === 6 * 3_600_000, `${new Date(steps[i]).toISOString()}: ${gap / 3_600_000} h`);
  }
  assert.ok(rows.length / steps.length < 3000, `${Math.round(rows.length / steps.length)} cells a step`);
  for (const row of rows.slice(0, 500)) {
    assert.equal(row.latitude % 1, 0, JSON.stringify(row));
    assert.equal(row.longitude % 1, 0, JSON.stringify(row));
  }
});

test('the brush opens on the storm: from its first advisory to the present hour, and the map flies to it', { skip }, async () => {
  const value = async (name) => Object.values((await duckdb(STACK_URL, forStorm(variable(name).__legacyStringValue)))[0])[0];
  const [t0, t1] = [Date.parse(await value('t0')), Date.parse(await value('t1'))];
  assert.ok(t0 < t1 && t1 <= Date.now() && t1 % 3_600_000 === 0, `${t0} ${t1}`);
  if (!storms[0].__text.includes(' · ended ')) assert.ok(Date.now() - t1 < 3_600_000, 'an active storm ends at the present hour');
  const [lat, lon] = [Number(await value('storm_lat')), Number(await value('storm_lon'))];
  assert.ok(Math.abs(lat) <= 60 && Math.abs(lon) <= 180, `${lat} ${lon}`);
});

test('whichever storm is picked, its card stays open and the camera follows it from afar', () => {
  const config = map.vizConfig.spec.options.mapConfig;
  const layers = (typeof config === 'string' ? JSON.parse(config) : config).config.visState.layers;
  const vc = layers.find((l) => l.id === 'storm').config.visConfig;
  // Kepler Plus's Keep every card open and Follow the first asset: no saved storm name to go stale.
  assert.equal(vc.fleetPinAll, true);
  assert.equal(vc.fleetFollowFirst, true);
  assert.equal(vc.fleetFollow, '');
  // Custom keeps the map's zoom; the other modes zoom in to street level.
  assert.equal(vc.fleetFollowMode, 'custom');
});

test('the rain and isobar switches: rows when on, one with no place when off', { skip, timeout: 10 * 60_000 }, async () => {
  for (const refId of ['H', 'I']) {
    const rows = await patiently(forStorm(mapSql(refId), 'off'));
    assert.equal(rows.length, 1, `${refId} off`);
    assert.equal(rows[0].latitude, null, `${refId} off`);
  }
  assert.ok((await patiently(forStorm(mapSql('I'), 'on'))).length > 1000, 'isobars on');
});

test('the satellite: one picture an hour from GIBS, from the one satellite that sees the storm, none over the forecast', { skip }, async () => {
  const parked = Date.parse('2000-01-01T00:00:00Z');
  const now = Date.now();
  const answers = {};
  for (const refId of ['J', 'M', 'N', 'K']) {
    const rows = await patiently(forStorm(mapSql(refId)));
    // Every query keeps its WMS layer on the map with one moment long before any storm.
    assert.equal(rows[0].time, parked, `${refId} parked`);
    for (const row of rows) assert.equal(row.wms_url, 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi');
    answers[refId] = rows.slice(1);
    const off = await patiently(forStorm(mapSql(refId), 'off'));
    assert.deepEqual(off.map((row) => row.time), [parked], `${refId} off`);
  }
  const seeing = ['J', 'M', 'N'].filter((refId) => answers[refId].length > 0);
  assert.ok(seeing.length <= 1, `seen by ${seeing}`);
  for (const refId of [...seeing, 'K']) {
    const times = answers[refId].map((row) => row.time);
    assert.ok(times.length > 24, `${refId}: ${times.length} hours`);
    // A real picture is at least an hour old; the forecast's hours point at themselves.
    const past = times.filter((t) => t <= now - 3_600_000);
    assert.ok(past.length > 0 && times.every((t) => t <= now - 3_600_000 || t % 3_600_000 === 0), refId);
    assert.ok(times.at(-1) > now + 40 * 3_600_000, `${refId} reaches the forecast`);
  }
});

test('the wind chance: bands of ten percent near the storm, none when switched off', { skip }, async () => {
  const rows = await patiently(forStorm(mapSql('L')));
  // An ended storm has no chance left; an active one usually has its bands.
  for (const row of rows) {
    assert.ok(row.chance_pct >= 10 && row.chance_pct <= 100 && row.chance_pct % 10 === 0, JSON.stringify(row).slice(0, 200));
    assert.ok(['Polygon', 'MultiPolygon'].includes(JSON.parse(row.geojson).type));
  }
  assert.equal((await patiently(forStorm(mapSql('L'), 'off'))).length, 0);
});

test('the advisory and the GFS low come in pairs, a few hundred kilometres apart at most', { skip, timeout: 10 * 60_000 }, async () => {
  const rows = await patiently(forStorm(mapSql('E')));
  // An ended storm has no advisory position inside GFS's two days: no rows.
  assert.equal(rows.filter((row) => row.centre === 'Advisory').length, rows.filter((row) => row.centre === 'GFS low').length);
  for (const row of rows) assert.ok(row.apart_km < 500, JSON.stringify(row));
});

test('opens with no panel or Mosaic chart in error', { skip, timeout: 5 * 60_000 }, async () => {
  const view = await openDashboard(`/d/${UID}`, { datasets: ['track', 'season'], timeoutMs: 180_000 });
  try {
    await view.page.waitForTimeout(10_000);
    assert.equal(await view.panelErrors(), 0);
    assert.equal(await view.page.getByTestId('mosaic-error').count(), 0);
  } finally {
    await view.browser.close();
  }
});
