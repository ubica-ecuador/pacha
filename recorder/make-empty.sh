#!/bin/sh
# Writes gateway/recordings/flights-empty.parquet: flights.sql's columns, no
# rows; and gateway/recordings/ais-denmark-empty/<table>.parquet, each of
# ais-denmark.sql's tables with no rows. The gateway serves them when nothing
# has been recorded, so a history panel returns nothing instead of failing.
# Run it whenever a feed's columns change; tests/stack/flight-recorder.test.mjs
# and denmark-ais-trajectories.test.mjs check they match.
#
# DuckDB is the datasource's engine, the version images/grafana/Dockerfile pins.
set -eu
cd "$(dirname "$0")/.."
version=$(sed -n 's/^ARG DUCKDB_ENGINE_VERSION=//p' images/grafana/Dockerfile)
docker run --rm -i -v "$PWD:/repo" -w /repo python:3.12-slim sh -eu -c "
  pip install -q --root-user-action=ignore 'duckdb==$version'
  python - <<'PY'
import duckdb, os
c = duckdb.connect()
c.sql('INSTALL h3 FROM community; LOAD h3')
open('/tmp/empty.json', 'w').write('{\"now\": 0, \"ac\": []}')
c.sql(\"SET VARIABLE source = '/tmp/empty.json'\")
sql = open('recorder/feeds/flights.sql').read()
out = 'gateway/recordings/flights-empty.parquet'
c.sql(f\"COPY ({sql}) TO '{out}' (FORMAT parquet, COMPRESSION zstd)\")
os.chown(out, $(id -u), $(id -g))
print(out, os.path.getsize(out), 'bytes')

# A day with no rows: the CSV's header alone.
import re
sql = open('recorder/feeds/ais-denmark.sql').read()
tables = re.search(r'^--\\s*tables:\\s*(.+)$', sql, re.M).group(1).split()
open('/tmp/empty.csv', 'w').write(
  '# Timestamp,Type of mobile,MMSI,Latitude,Longitude,Navigational status,ROT,SOG,COG,Heading,IMO,'
  'Callsign,Name,Ship type,Cargo type,Width,Length,Type of position fixing device,Draught,'
  'Destination,ETA,Data source type,A,B,C,D\\n')
c.sql(\"SET VARIABLE source = '/tmp/empty.csv'\")
c.sql(\"SET VARIABLE day = DATE '1970-01-01'\")
c.execute(sql)
os.makedirs('gateway/recordings/ais-denmark-empty', exist_ok=True)
for table in tables:
    out = f'gateway/recordings/ais-denmark-empty/{table}.parquet'
    c.sql(f\"COPY {table} TO '{out}' (FORMAT parquet, COMPRESSION zstd)\")
    os.chown(out, $(id -u), $(id -g))
    print(out, os.path.getsize(out), 'bytes')
os.chown('gateway/recordings/ais-denmark-empty', $(id -u), $(id -g))
PY
"
