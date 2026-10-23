# syntax=docker/dockerfile:1
#
# Grafana for Pacha, with every plugin baked in.
#
# Plugins live in /opt/pacha/plugins, not /var/lib/grafana/plugins. The
# latter is inside the data volume, and Docker only copies image content into a
# volume that is empty: an existing install (grafana.ubica.ec) would keep the
# plugins its volume already holds and never see these. DuckDB's extensions sit
# outside the volume for the same reason, under a HOME of their own.
#
# Every version is an ARG here and a label on the image. Plugins taken from a
# GitHub release are checked against a sha256: a new version fails the build
# until its hash moves with it.
# The one exception is Kepler's edge channel (KEPLER_PANEL_CHANNEL=edge), which
# follows main of its repo on purpose.

ARG GRAFANA_EDITION=grafana-enterprise
ARG GRAFANA_VERSION=13.2.1
ARG KEPLER_PANEL_VERSION=1.4.0
ARG KEPLER_PANEL_SHA256=ea376c3f93d095635dabf29a625f193417f989b4b7d585500e60bbb1299aeb73
# release: the version above. edge: main of the Kepler repo, as its CI last
# published it; not pinned, see the kepler-edge stage.
ARG KEPLER_PANEL_CHANNEL=release
ARG CHASKI_VERSION=2.1.0
ARG CHASKI_SHA256=40e93955532ecf28ca2f14e64a597883b8e22274ace458eeca96d1b4a07b92e0
ARG DUCKDB_DS_VERSION=0.4.5
ARG DUCKDB_DS_SHA256=156c6ab8caad03d6a8956dfae1f685697101d14a1f0921528d8c6258f03a3c40
# The engine the DuckDB datasource is linked against. Extensions are built per
# engine version, so the CLI that installs them must be this same release.
ARG DUCKDB_ENGINE_VERSION=1.5.4
ARG DUCKDB_CLI_SHA256_amd64=1f2fa724fb054b3dbe1a9cbd13de5b76997d850e7087ec762ba88db04e0180cf
ARG DUCKDB_CLI_SHA256_arm64=377f03fb9f17ab5a78f28f829cbfcb5333da8ab3c2d0788f27694f81df77ed29
ARG INFINITY_VERSION=4.0.0
ARG BUSINESS_CHARTS_VERSION=7.2.5
ARG BUSINESS_TABLE_VERSION=3.6.8
ARG BUSINESS_TEXT_VERSION=6.3.0
ARG BUSINESS_VARIABLE_VERSION=5.2.0

# --- The Kepler panel, from the channel KEPLER_PANEL_CHANNEL names. ---
FROM alpine:3.20 AS kepler-release
ARG KEPLER_PANEL_VERSION
ARG KEPLER_PANEL_SHA256
RUN apk add --no-cache curl unzip
WORKDIR /fetch
RUN curl -fsSLo kepler.zip "https://github.com/ubica-ecuador/keplergl-grafana-panel/releases/download/v${KEPLER_PANEL_VERSION}/ubica-keplergl-panel-${KEPLER_PANEL_VERSION}.zip" \
 && echo "${KEPLER_PANEL_SHA256}  kepler.zip" | sha256sum -c - \
 && mkdir /plugins \
 && unzip -q kepler.zip -d /plugins

# The Kepler repo's CI publishes every push to main as the pre-release `edge`,
# with a .sha256 beside the zip. Not pinned, on purpose. ADD fetches the .sha256
# at every build and keys the cache on its content, so the download below
# reruns exactly when edge has moved.
FROM alpine:3.20 AS kepler-edge
RUN apk add --no-cache curl unzip
WORKDIR /fetch
ADD https://github.com/ubica-ecuador/keplergl-grafana-panel/releases/download/edge/ubica-keplergl-panel-edge.zip.sha256 .
RUN curl -fsSLO "https://github.com/ubica-ecuador/keplergl-grafana-panel/releases/download/edge/ubica-keplergl-panel-edge.zip" \
 && sha256sum -c ubica-keplergl-panel-edge.zip.sha256 \
 && mkdir /plugins \
 && unzip -q ubica-keplergl-panel-edge.zip -d /plugins

# BuildKit builds only the stage this names.
FROM kepler-${KEPLER_PANEL_CHANNEL} AS kepler

# --- The other two plugins that come from GitHub releases, unsigned. ---
FROM alpine:3.20 AS fetch
ARG TARGETARCH
ARG CHASKI_VERSION
ARG CHASKI_SHA256
ARG DUCKDB_DS_VERSION
ARG DUCKDB_DS_SHA256
RUN apk add --no-cache curl unzip
WORKDIR /fetch
RUN curl -fsSLo chaski.zip "https://github.com/ubica-ecuador/chaski/releases/download/v${CHASKI_VERSION}/ubica-chaski-app-${CHASKI_VERSION}.zip" \
 && curl -fsSLo duckdb.zip "https://github.com/motherduckdb/grafana-duckdb-datasource/releases/download/v${DUCKDB_DS_VERSION}/motherduck-duckdb-datasource-${DUCKDB_DS_VERSION}.zip" \
 && printf '%s  chaski.zip\n%s  duckdb.zip\n' "${CHASKI_SHA256}" "${DUCKDB_DS_SHA256}" | sha256sum -c - \
 && mkdir /plugins \
 && for zip in chaski duckdb; do unzip -q "${zip}.zip" -d /plugins; done
# The DuckDB zip carries an 80 MB engine for each of five platforms; keep ours.
RUN find /plugins/motherduck-duckdb-datasource -name 'gpx_*' \
      ! -name "gpx_duckdb_datasource_linux_${TARGETARCH}" -delete \
 && chmod +x "/plugins/motherduck-duckdb-datasource/gpx_duckdb_datasource_linux_${TARGETARCH}"

# --- DuckDB extensions, installed by a CLI of the datasource's engine. ---
# Otherwise the datasource downloads them on first use: the internet at query
# time, again on every fresh container.
FROM ubuntu:24.04 AS duckdb-extensions
ARG TARGETARCH
ARG DUCKDB_ENGINE_VERSION
ARG DUCKDB_CLI_SHA256_amd64
ARG DUCKDB_CLI_SHA256_arm64
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
ENV HOME=/opt/pacha/duckdb-home
RUN curl -fsSLo /tmp/duckdb-cli.zip "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_ENGINE_VERSION}/duckdb_cli-linux-${TARGETARCH}.zip" \
 && eval "expected=\${DUCKDB_CLI_SHA256_${TARGETARCH}}" \
 && echo "${expected}  /tmp/duckdb-cli.zip" | sha256sum -c - \
 && unzip -q /tmp/duckdb-cli.zip -d /usr/local/bin \
 && mkdir -p "${HOME}" \
 && duckdb -c "INSTALL spatial; INSTALL httpfs; INSTALL json; INSTALL excel; INSTALL avro; INSTALL iceberg; \
      INSTALL http_client FROM community; INSTALL raster FROM community; INSTALL h3 FROM community; \
      INSTALL a5 FROM community; INSTALL lindel FROM community;" \
 && test "$(ls "${HOME}/.duckdb/extensions/v${DUCKDB_ENGINE_VERSION}/linux_${TARGETARCH}/"*.duckdb_extension | wc -l)" -eq 11

# --- Grafana. ---
FROM grafana/${GRAFANA_EDITION}:${GRAFANA_VERSION}-ubuntu
ARG GRAFANA_EDITION
ARG GRAFANA_VERSION
ARG KEPLER_PANEL_VERSION
ARG KEPLER_PANEL_CHANNEL
ARG CHASKI_VERSION
ARG DUCKDB_DS_VERSION
ARG DUCKDB_ENGINE_VERSION
ARG INFINITY_VERSION
ARG BUSINESS_CHARTS_VERSION
ARG BUSINESS_TABLE_VERSION
ARG BUSINESS_TEXT_VERSION
ARG BUSINESS_VARIABLE_VERSION

USER root
COPY --from=fetch --chown=472:0 /plugins /opt/pacha/plugins
COPY --from=duckdb-extensions --chown=472:0 /opt/pacha/duckdb-home /opt/pacha/duckdb-home
# Signed plugins from the catalogue, at fixed versions.
RUN for plugin in \
      "yesoreyeram-infinity-datasource ${INFINITY_VERSION}" \
      "volkovlabs-echarts-panel ${BUSINESS_CHARTS_VERSION}" \
      "volkovlabs-table-panel ${BUSINESS_TABLE_VERSION}" \
      "marcusolsson-dynamictext-panel ${BUSINESS_TEXT_VERSION}" \
      "volkovlabs-variable-panel ${BUSINESS_VARIABLE_VERSION}"; do \
      grafana cli --pluginsDir /opt/pacha/plugins plugins install ${plugin} || exit 1; \
    done \
 && chown -R 472:0 /opt/pacha/plugins
# Kepler last among the plugin steps: it's the one that moves on every edge
# build, so a new edge rebuilds only this layer, not the ones above it.
COPY --from=kepler --chown=472:0 /plugins/ubica-keplergl-panel /opt/pacha/plugins/ubica-keplergl-panel
USER 472

# - Anonymous visitors see dashboards and change nothing.
# - Unsigned: our plugins until the catalogue signs them (Chaski is an app that
#   brings its datasource and the Mosaic panel, each listed by its own id), and
#   DuckDB, which is not in the catalogue at all. Nothing else.
# - Grafana 13 hands a backend plugin only the host variables named in
#   GF_PLUGINS_FORWARD_HOST_ENV_VARS, and never HOME: it always pins a plugin
#   subprocess's HOME to GF_PATHS_HOME (/usr/share/grafana), no matter what
#   HOME is set to here (verified against the running DuckDB datasource
#   process). DuckDB's baked extensions live under
#   /opt/pacha/duckdb-home/.duckdb/extensions instead, and the datasource's
#   own initSql points DuckDB at them with `SET extension_directory=...` (see
#   provisioning/datasources/datasources.yaml).
# - Infinity silently stops a paginated query at 5 pages unless told otherwise.
#   The Aqueduct dashboard needs 9 pages of 750 to cover South America.
# - The raster extension reads remote files with GDAL's own HTTP client, built
#   to look for CA certificates at a Red Hat path this Ubuntu image lacks; this
#   points it at Ubuntu's bundle. Forwarded to DuckDB like any variable but HOME.
# - No plugin preinstall: it downloads apps from grafana.com at every start,
#   which is the network at runtime this image exists to avoid.
ENV GF_PATHS_PLUGINS=/opt/pacha/plugins \
    HOME=/opt/pacha/duckdb-home \
    GF_AUTH_ANONYMOUS_ENABLED=true \
    GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer \
    GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ubica-keplergl-panel,ubica-chaski-app,ubica-chaski-datasource,ubica-chaski-mosaic-panel,motherduck-duckdb-datasource \
    GF_PLUGINS_FORWARD_HOST_ENV_VARS=motherduck-duckdb-datasource,yesoreyeram-infinity-datasource \
    GF_PLUGIN_PAGINATION_MAX_PAGES=12 \
    GF_PLUGINS_PREINSTALL_DISABLED=true \
    CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

LABEL org.opencontainers.image.title="pacha-grafana" \
      org.opencontainers.image.description="Grafana with Pacha's plugins baked in. Not affiliated with Grafana Labs." \
      org.opencontainers.image.source="https://github.com/ubica-ecuador/pacha" \
      io.pacha.grafana.version="${GRAFANA_EDITION}:${GRAFANA_VERSION}" \
      io.pacha.kepler-panel.version="${KEPLER_PANEL_VERSION}" \
      io.pacha.kepler-panel.channel="${KEPLER_PANEL_CHANNEL}" \
      io.pacha.chaski.version="${CHASKI_VERSION}" \
      io.pacha.duckdb-datasource.version="${DUCKDB_DS_VERSION}" \
      io.pacha.duckdb-engine.version="${DUCKDB_ENGINE_VERSION}" \
      io.pacha.infinity.version="${INFINITY_VERSION}" \
      io.pacha.business-charts.version="${BUSINESS_CHARTS_VERSION}" \
      io.pacha.business-table.version="${BUSINESS_TABLE_VERSION}" \
      io.pacha.business-text.version="${BUSINESS_TEXT_VERSION}" \
      io.pacha.business-variable.version="${BUSINESS_VARIABLE_VERSION}"
