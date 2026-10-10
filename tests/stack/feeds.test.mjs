import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/docker.mjs';
import { duckdb, rawGet } from '../lib/grafana.mjs';
import { STACK_URL } from '../lib/stack.mjs';

const VEHICLES = '/mbta/realtime/VehiclePositions_enhanced.json';

test('DuckDB reads an MBTA feed through feeds', async () => {
  const [row] = await duckdb(STACK_URL, `LOAD httpfs; SELECT length(content) AS n FROM read_text('http://feeds${VEHICLES}')`);
  assert.ok(Number(row.n) > 1000, `feed is only ${row.n} bytes`);
});

test('a second read within 15 s is served from the cache', () => {
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${VEHICLES}`]);
  headers();
  assert.match(headers(), /X-Cache-Status: HIT/i);
});

test('no stale copies, ever', () => {
  assert.doesNotMatch(compose(['exec', '-T', 'gateway', 'nginx', '-T']), /proxy_cache_use_stale/);
});

test('feeds refuses a request relayed by a public proxy', async () => {
  const { port } = new URL(STACK_URL);
  const res = await rawGet(`http://127.0.0.1:${port}${VEHICLES}`, { host: 'feeds', 'x-forwarded-for': '203.0.113.9' });
  assert.equal(res.status, 403);
});

// The European grid behind germany-power-borders. Energy-Charts answers 503 to
// the Host header DuckDB sends on its own; through feeds it answers.
const BORDERS = '/energy-charts/v2/cbpf?country=de';

test('DuckDB reads Energy-Charts through feeds', async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT (http_get('http://feeds${BORDERS}')->>'body')::JSON->>'$.endpoint' AS endpoint`,
  );
  assert.equal(row.endpoint, 'cbpf');
});

test('Energy-Charts is asked once per cache period, whatever the audience', () => {
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${BORDERS}`]);
  headers();
  assert.match(headers(), /X-Cache-Status: HIT/i);
});

test('the query string is part of an Energy-Charts cache key', () => {
  const status = (path) =>
    compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${path}`]).match(/X-Cache-Status: (\w+)/i)?.[1];
  status('/energy-charts/v2/signal?country=fr');
  // A country never asked for in this run is not served France's copy.
  assert.notEqual(status(`/energy-charts/v2/signal?country=de&_=${Date.now()}`), 'HIT');
});

test('DuckDB reads the PyPSA-Eur grid through feeds', async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT count(*)::INTEGER AS n FROM read_csv('http://feeds/zenodo/records/18619025/files/buses.csv', quote = '''')`,
  );
  assert.ok(row.n > 1000, `only ${row.n} buses`);
});

// CMU's package-delivery drone flights behind drone-delivery-flights. Figshare
// answers with a redirect to an S3 link signed for 10 s; the gateway follows it
// and keeps the file under its own address.
const FLIGHT_PARAMETERS = '/figshare/files/26385034';

test('DuckDB reads the drone flights through feeds', async () => {
  const [row] = await duckdb(STACK_URL, `SELECT count(*)::INTEGER AS n FROM read_csv('http://feeds${FLIGHT_PARAMETERS}')`);
  assert.equal(row.n, 209);
});

test('a figshare file is fetched once and then served from the cache', () => {
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${FLIGHT_PARAMETERS}`]);
  headers();
  assert.match(headers(), /X-Cache-Status: HIT/i);
});

// TriMet behind trimet-live-fleet. Every call needs an AppID, which the
// gateway adds from TRIMET_APP_ID; without one in .env TriMet refuses, and
// these tests are skipped.
const TRIMET = '/trimet/ws/v2/vehicles';
const trimetKey = compose(['exec', '-T', 'gateway', 'printenv', 'TRIMET_APP_ID']).trim();
const noTrimetKey = !trimetKey && 'TRIMET_APP_ID is not set';

test('DuckDB reads TriMet through feeds, the AppID added on the way', { skip: noTrimetKey }, async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT json_array_length(content::JSON, '$.resultSet.vehicle')::INTEGER AS n FROM read_text('http://feeds${TRIMET}')`,
  );
  assert.ok(row.n > 10, `only ${row.n} vehicles`);
});

test('TriMet is kept gzipped and handed over plain, once per cache period', { skip: noTrimetKey }, () => {
  const headers = (...extra) => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', ...extra, `http://feeds${TRIMET}`]);
  headers();
  const plain = headers();
  assert.match(plain, /X-Cache-Status: HIT/i);
  assert.doesNotMatch(plain, /Content-Encoding/i);
  assert.match(headers('-H', 'Accept-Encoding: gzip'), /Content-Encoding: gzip/i);
});

test('the AppID never leaves the gateway', { skip: noTrimetKey }, () => {
  const answer = compose(['exec', '-T', 'grafana', 'curl', '-s', '-D', '-', `http://feeds${TRIMET}`]);
  assert.ok(!answer.includes(trimetKey));
});

// NOAA's GFS on PacIOOS ERDDAP, behind gfs-wind-synoptic. One grid cell at the
// latest step: small enough to be quick even on a miss. ERDDAP wants its
// brackets percent-encoded, and the gateway passes them on as they came.
const ERDDAP = '/erddap/griddap/ncep_global.csv0?ugrd10m%5B(last)%5D%5B(-2.0):1:(-2.0)%5D%5B(281.0):1:(281.0)%5D';

test('DuckDB reads ERDDAP through feeds', async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT count(*)::INTEGER AS n FROM read_csv('http://feeds${ERDDAP}', header = false, nullstr = 'NaN')`,
  );
  assert.equal(row.n, 1);
});

test('an ERDDAP answer is built once and then served from the cache', () => {
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${ERDDAP}`]);
  headers();
  assert.match(headers(), /X-Cache-Status: HIT/i);
});


// NYC's buildings and subway on GeoLens, behind nyc-skyline-plus. The export
// is generated per request, with a new ETag each time; from the cache every
// read sees the same file. The stations are the smallest.
const STATIONS = '/geolens/datasets/c646ff35-82eb-442f-a524-efcbb1645023.parquet';

test('DuckDB reads a GeoLens parquet through feeds', async () => {
  const [row] = await duckdb(STACK_URL, `SELECT count(*)::INTEGER AS n FROM read_parquet('http://feeds${STATIONS}')`);
  assert.equal(row.n, 496);
});

test('a GeoLens export is fetched once and then served from the cache, one ETag', () => {
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${STATIONS}`]);
  const etag = (answer) => answer.match(/^etag: (.+)$/im)?.[1];
  const first = headers();
  const second = headers();
  assert.match(second, /X-Cache-Status: HIT/i);
  assert.equal(etag(second), etag(first));
});

// PortWatch and FRED behind shipping-chokepoints-freight. PortWatch's weekly
// CSV, from the address the ArcGIS Hub link redirects to; FRED through its
// API, with the key the gateway adds from FRED_API_KEY. Without one in .env,
// FRED refuses and its tests are skipped.
const CHOKEPOINTS = '/portwatch/items/3da2b9ca97684916b75c4013f95d18ab.csv';

test('DuckDB reads PortWatch through feeds', async () => {
  const [row] = await duckdb(STACK_URL, `SELECT count(DISTINCT portid)::INTEGER AS n FROM read_csv('http://feeds${CHOKEPOINTS}')`);
  assert.equal(row.n, 28);
});

test('the PortWatch CSV is fetched once a day and then served from the cache', () => {
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${CHOKEPOINTS}`]);
  headers();
  assert.match(headers(), /X-Cache-Status: HIT/i);
});

const FRED = '/fred/series/PCU483111483111';
const fredKey = compose(['exec', '-T', 'gateway', 'printenv', 'FRED_API_KEY']).trim();
const noFredKey = !fredKey && 'FRED_API_KEY is not set';

test('DuckDB reads FRED through feeds, the key added on the way', { skip: noFredKey }, async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT len(observations)::INTEGER AS n FROM read_json('http://feeds${FRED}')`,
  );
  assert.ok(row.n > 400, `only ${row.n} months`);
});

test('the FRED key never leaves the gateway', { skip: noFredKey }, () => {
  const answer = compose(['exec', '-T', 'grafana', 'curl', '-s', '-D', '-', `http://feeds${FRED}`]);
  assert.ok(!answer.includes(fredKey));
});

// adsb.lol's whole world, behind air-traffic-world and the recorder.
const WORLD = '/adsblol/world';

test('DuckDB reads every aircraft in the world through feeds', async () => {
  const [row] = await duckdb(
    STACK_URL,
    `SELECT len(ac)::INTEGER AS n FROM read_json('http://feeds${WORLD}', columns = {ac: 'JSON[]'})`,
  );
  assert.ok(row.n > 1000, `only ${row.n} aircraft`);
});

test('adsb.lol is asked once a minute at most', () => {
  const headers = () => compose(['exec', '-T', 'grafana', 'curl', '-s', '-o', '/dev/null', '-D', '-', `http://feeds${WORLD}`]);
  headers();
  assert.match(headers(), /X-Cache-Status: HIT/i);
});
