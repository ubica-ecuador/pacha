// The tropical-cyclones dashboard: provisioned in Plus, its two storm lists, its
// Chaski datasets and the maps' server queries, as the file holds them,
// answering through Grafana, and each tab opening with no panel or Mosaic chart
// in error. It needs Kepler Plus (compose.plus.yaml): without it, the tests are
// skipped.
//
// The data is live (the NHC and JTWC advisories on Esri's Living Atlas, GDACS's,
// NOAA GFS on ERDDAP, IBTrACS, NASA GIBS), so the checks are about shape and
// sanity, on the storm each tab opens on: the first of its list. With no storm
// active, the first tab's checks are skipped; with none ended in two months, the
// second's.
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
const mapOf = (id) => findAll(dashboard, (n) => n.id === id && n.vizConfig)[0];
const [nowMap, pastMap] = [mapOf(11), mapOf(31)];
const sqlOf = (map, refId) => map.data.spec.queries.find((q) => q.spec.refId === refId).spec.query.spec.rawSql;
const layersOf = (map) => {
  const config = map.vizConfig.spec.options.mapConfig;
  return (typeof config === 'string' ? JSON.parse(config) : config).config.visState.layers;
};
const afterRender = (id) => findAll(dashboard, (n) => n.id === id && n.vizConfig)[0].vizConfig.spec.options.afterRender;

const active = noPlus ? [] : await duckdb(STACK_URL, variable('storm').__legacyStringValue);
const ended = noPlus ? [] : await duckdb(STACK_URL, variable('past').__legacyStringValue);
const [storm, past] = [active[0]?.__value, ended[0]?.__value];
const skipNow = noPlus || (!storm && 'no storm active');
const skipPast = noPlus || (!past && 'no storm ended in the last two months');
// The DuckDB datasource quotes a variable's value; so does this.
const forStorms = (sql, switches = 'on') =>
  ['rain', 'isobars', 'satellite', 'windchance'].reduce(
    (out, name) => out.replaceAll(`$${name}`, `'${switches}'`),
    sql.replaceAll('${storm:sqlstring}', `'${storm}'`).replaceAll('$past', `'${past}'`)
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

const categories = new Set(['Tropical depression', 'Tropical storm', 'Category 1', 'Category 2', 'Category 3', 'Category 4', 'Category 5']);
const checkTrack = (rows) => {
  assert.ok(rows.length >= 6, `${rows.length} hours`);
  rows.forEach((row, i) => {
    assert.ok(Math.abs(row.latitude) <= 60 && row.wind_kt > 0 && row.wind_kt < 200, JSON.stringify(row));
    assert.ok(categories.has(row.category), row.category);
    assert.ok(['Observed', 'Forecast'].includes(row.phase), row.phase);
    if (i > 0) assert.equal(row.time - rows[i - 1].time, 3_600_000, `hour ${i}`);
  });
};

test('is provisioned in Plus, with its tags, description and three tabs', { skip: noPlus }, () => {
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.json.meta.folderUid, 'plus');
  assert.equal(dashboard.metadata.name, UID);
  assert.ok(dashboard.spec.description.length > 50);
  for (const tag of ['plus', 'chaski', 'duckdb', 'mosaic']) assert.ok(dashboard.spec.tags.includes(tag), tag);
  const tabs = dashboard.spec.layout.spec.tabs.map((tab) => tab.spec.title);
  assert.deepEqual(tabs, ['1 · Storms now', '2 · Storms that ended', '3 · Among three seasons of storms']);
});

test('GDACS, ERDDAP and IBTrACS are read through the gateway, never directly', () => {
  const sql = findAll(dashboard, (n) => typeof n.rawSql === 'string').map((n) => n.rawSql.replace(/^\s*--.*$/gm, '')).join('\n');
  for (const route of ['http://feeds/gdacs/', 'http://feeds/erddap/', 'http://feeds/ibtracs/']) assert.ok(sql.includes(route), route);
  assert.ok(!/https?:\/\/(www\.)?(gdacs\.org|ncei\.noaa\.gov)|pacioos/.test(sql));
});

test('the first tab follows the advisories on Esri, not GDACS', () => {
  const sql = [variable('storm').__legacyStringValue, datasetSql('track'), ...nowMap.data.spec.queries.map((q) => q.spec.query.spec.rawSql)]
    .join('\n')
    .replace(/^\s*--.*$/gm, '');
  assert.ok(sql.includes('Active_Hurricanes_v1/FeatureServer'));
  assert.ok(!sql.includes('feeds/gdacs/'), 'the storm, its track and its map never wait on GDACS');
});

test('the active storms: Esri ids, the strongest first', { skip: noPlus }, () => {
  for (const row of active) assert.match(row.__value, /^[a-z]{2}[0-9]{6}$/, JSON.stringify(row));
});

test('the ended storms: GDACS ids, the latest to end first', { skip: noPlus }, () => {
  for (const row of ended) assert.match(row.__value, /^[0-9]+$/, JSON.stringify(row));
});

test('the active storm hour by hour: one row an hour, sane winds, Saffir-Simpson categories', { skip: skipNow, timeout: 10 * 60_000 }, async () => {
  checkTrack(await patiently(forStorms(datasetSql('track'))));
});

test('the ended storm hour by hour, all observed', { skip: skipPast, timeout: 10 * 60_000 }, async () => {
  const rows = await patiently(forStorms(datasetSql('past_track')));
  checkTrack(rows);
  assert.ok(rows.every((row) => row.phase === 'Observed'), 'an ended storm has no forecast');
});

test('the last three seasons: thousands of fixes in several basins', { skip: noPlus, timeout: 10 * 60_000 }, async () => {
  const rows = await patiently(datasetSql('season'));
  assert.ok(rows.length > 3000, `${rows.length} fixes`);
  assert.ok(new Set(rows.map((row) => row.basin)).size >= 4);
  for (const row of rows.slice(0, 500)) assert.ok(row.peak_kt >= row.wind_kt && row.days > 0, JSON.stringify(row));
});

test('GFS around the storm: whole degrees, every six hours of its past and three of the next two days', { skip: skipNow, timeout: 10 * 60_000 }, async () => {
  const rows = await patiently(forStorms(sqlOf(nowMap, 'G')));
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

test('the brush opens on the active storm: from its first fix to the present hour, and the map flies to it', { skip: skipNow }, async () => {
  const value = async (name) => Object.values((await duckdb(STACK_URL, forStorms(variable(name).__legacyStringValue)))[0])[0];
  const [t0, t1] = [Date.parse(await value('t0')), Date.parse(await value('t1'))];
  assert.ok(t0 < t1 && t1 <= Date.now() && Date.now() - t1 < 3_600_000, `${t0} ${t1}`);
  const [lat, lon] = [Number(await value('storm_lat')), Number(await value('storm_lon'))];
  assert.ok(Math.abs(lat) <= 60 && Math.abs(lon) <= 180, `${lat} ${lon}`);
});

test('the brush opens on the ended storm: its whole life, to its last advisory', { skip: skipPast, timeout: 5 * 60_000 }, async () => {
  const value = async (name) => Object.values((await patiently(forStorms(variable(name).__legacyStringValue)))[0])[0];
  const [p0, p1] = [Date.parse(await value('p0')), Date.parse(await value('p1'))];
  assert.ok(p0 < p1 && p1 < Date.now() - 86_400_000, `${p0} ${p1}`);
});

test('GFS rain: the rate at each step where it rains, a zero where it stopped, nothing when off', { skip: skipNow, timeout: 10 * 60_000 }, async () => {
  for (const refId of ['H', 'I']) {
    const rows = await patiently(forStorms(sqlOf(nowMap, refId), 'off'));
    assert.equal(rows.length, 1, `${refId} off`);
    assert.equal(rows[0].latitude, null, `${refId} off`);
  }
  assert.ok((await patiently(forStorms(sqlOf(nowMap, 'I'), 'on'))).length > 1000, 'isobars on');
  const rain = (await patiently(forStorms(sqlOf(nowMap, 'H')))).filter((row) => row.latitude !== null);
  for (const row of rain) {
    assert.ok(row.rain_mm_h === 0 ? row.reach_m === 0 : row.rain_mm_h >= 0.3 && row.reach_m > 0 && row.reach_m <= 55_000, JSON.stringify(row));
  }
  // One row a cell and step.
  assert.equal(new Set(rain.map((row) => `${row.time} ${row.latitude} ${row.longitude}`)).size, rain.length);
});

test('the rain shows the step at the end of the window, and turns the satellite off', () => {
  for (const map of [nowMap, pastMap]) {
    const layer = layersOf(map).find((l) => l.id === 'rain');
    assert.equal(layer.type, 'coverage');
    assert.equal(layer.config.visConfig.rowsPerPlace, 'last');
    assert.equal(layer.visualChannels.reachField.name, 'reach_m');
  }
  for (const id of [19, 39]) {
    const js = afterRender(id);
    assert.match(js, /variable: 'satellite'[^\n]*excludes: 'rain'/);
    assert.match(js, /variable: 'rain'[^\n]*excludes: 'satellite'/);
  }
  const on = (name) => dashboard.spec.variables.find((v) => v.spec.name === name).spec.current.value;
  assert.notDeepEqual([on('satellite'), on('rain')], ['on', 'on']);
});

test('whichever storm is picked, its card stays open and the camera follows it from afar', () => {
  for (const map of [nowMap, pastMap]) {
    const vc = layersOf(map).find((l) => l.id === 'storm').config.visConfig;
    // Kepler Plus's Keep every card open and Follow the first asset: no saved storm name to go stale.
    assert.equal(vc.fleetPinAll, true);
    assert.equal(vc.fleetFollowFirst, true);
    assert.equal(vc.fleetFollow, '');
    // Custom keeps the map's zoom; the other modes zoom in to street level.
    assert.equal(vc.fleetFollowMode, 'custom');
  }
});

test('the advisory and the GFS low come in pairs, a few hundred kilometres apart at most', { skip: skipNow, timeout: 10 * 60_000 }, async () => {
  const rows = await patiently(forStorms(sqlOf(nowMap, 'E')));
  assert.equal(rows.filter((row) => row.centre === 'Advisory').length, rows.filter((row) => row.centre === 'GFS low').length);
  for (const row of rows) assert.ok(row.apart_km < 500, JSON.stringify(row));
});

test('the satellite: one picture an hour from GIBS, from the one satellite that sees the storm, none over the forecast', { skip: skipNow }, async () => {
  const parked = Date.parse('2000-01-01T00:00:00Z');
  const now = Date.now();
  const answers = {};
  for (const refId of ['J', 'M', 'N', 'K']) {
    const rows = await patiently(forStorms(sqlOf(nowMap, refId)));
    // Every query keeps its WMS layer on the map with one moment long before any storm.
    assert.equal(rows[0].time, parked, `${refId} parked`);
    for (const row of rows) assert.equal(row.wms_url, 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi');
    answers[refId] = rows.slice(1);
    const off = await patiently(forStorms(sqlOf(nowMap, refId), 'off'));
    assert.deepEqual(off.map((row) => row.time), [parked], `${refId} off`);
  }
  const seeing = ['J', 'M', 'N'].filter((refId) => answers[refId].length > 0);
  assert.ok(seeing.length <= 1, `seen by ${seeing}`);
  for (const refId of [...seeing, 'K']) {
    const times = answers[refId].map((row) => row.time);
    assert.ok(times.length > 24, `${refId}: ${times.length} hours`);
    // A real picture is at least an hour old; the forecast's hours point at themselves.
    const pastTimes = times.filter((t) => t <= now - 3_600_000);
    assert.ok(pastTimes.length > 0 && times.every((t) => t <= now - 3_600_000 || t % 3_600_000 === 0), refId);
    assert.ok(times.at(-1) > now + 40 * 3_600_000, `${refId} reaches the forecast`);
  }
});

test('the wind chance: bands of ten percent near the storm, none when switched off', { skip: skipNow }, async () => {
  const rows = await patiently(forStorms(sqlOf(nowMap, 'L')));
  for (const row of rows) {
    assert.ok(row.chance_pct >= 10 && row.chance_pct <= 100 && row.chance_pct % 10 === 0, JSON.stringify(row).slice(0, 200));
    assert.ok(['Polygon', 'MultiPolygon'].includes(JSON.parse(row.geojson).type));
  }
  assert.equal((await patiently(forStorms(sqlOf(nowMap, 'L'), 'off'))).length, 0);
});

for (const [tab, datasets, skip] of [
  ['', ['track', 'season'], skipNow],
  ['?dtab=2-·-Storms-that-ended', ['past_track', 'season'], skipPast],
]) {
  test(`opens ${tab ? 'on the second tab' : 'on the first tab'} with no panel or Mosaic chart in error`, { skip, timeout: 5 * 60_000 }, async () => {
    const view = await openDashboard(`/d/${UID}${tab}`, { datasets, timeoutMs: 180_000 });
    try {
      await view.page.waitForTimeout(10_000);
      assert.equal(await view.panelErrors(), 0);
      assert.equal(await view.page.getByTestId('mosaic-error').count(), 0);
    } finally {
      await view.browser.close();
    }
  });
}
