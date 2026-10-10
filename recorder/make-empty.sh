#!/bin/sh
# Writes gateway/recordings/flights-empty.parquet: flights.sql's columns, no
# rows. The gateway serves it when nothing has been recorded, so a history
# panel returns nothing instead of failing. Run it whenever flights.sql's
# columns change; tests/stack/flight-recorder.test.mjs checks they match.
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
PY
"
