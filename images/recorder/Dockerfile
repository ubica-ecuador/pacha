# syntax=docker/dockerfile:1
#
# The recorder: keeps what a live feed said, as Parquet, for Grafana to read
# back through the gateway. See recorder.py.
#
# Its DuckDB is the grafana datasource's engine (DUCKDB_ENGINE_VERSION in
# images/grafana/Dockerfile): the files it writes are the files Grafana reads.
# The feeds come from the repo's recorder/feeds/, the build context `feeds`
# (compose.yaml and docker-bake.hcl pass it).

ARG PYTHON_VERSION=3.12
ARG DUCKDB_VERSION=1.5.4
ARG PYTZ_VERSION=2025.2
ARG PYTEST_VERSION=8.4.2

FROM python:${PYTHON_VERSION}-slim AS base
ARG DUCKDB_VERSION
ARG PYTZ_VERSION
# pytz: the duckdb package needs it to hand a TIMESTAMPTZ to Python.
RUN pip install --no-cache-dir --root-user-action=ignore "duckdb==${DUCKDB_VERSION}" "pytz==${PYTZ_VERSION}"
# Extensions at build, outside any home, readable by the user it runs as: never
# downloaded at run time.
ENV RECORDER_EXTENSIONS=/opt/recorder/extensions \
    PYTHONUNBUFFERED=1
RUN python -c "import duckdb; c = duckdb.connect(config={'extension_directory': '/opt/recorder/extensions'}); c.execute('INSTALL h3 FROM community; INSTALL json')" \
 && chmod -R a+rX /opt/recorder
WORKDIR /app
COPY recorder.py .

FROM base AS test
ARG PYTEST_VERSION
RUN pip install --no-cache-dir --root-user-action=ignore "pytest==${PYTEST_VERSION}"
COPY --from=feeds flights.sql /repo/recorder/feeds/
COPY tests tests
RUN python -m pytest -q -p no:cacheprovider tests

FROM base
COPY --from=feeds *.sql /etc/recorder/feeds/
RUN mkdir -p /var/lib/recorder
# Healthy while polls succeed: the last one under three minutes old.
HEALTHCHECK --interval=15s --timeout=3s --start-period=90s --retries=3 \
  CMD find /tmp/recorder-ok -mmin -3 | grep -q .
# Starts as root only to hand the recordings volume to nobody: the gateway
# mounts it first, so a fresh volume belongs to root. Then it runs as nobody.
ENTRYPOINT ["sh", "-c", "chown nobody:nogroup /var/lib/recorder && exec setpriv --reuid=nobody --regid=nogroup --clear-groups python /app/recorder.py"]
