#!/bin/sh
# The headers Claude Code sends to the mcp service (.mcp.json headersHelper):
# the bearer token from PACHA_MCP_TOKEN in .env, the same value compose gives
# the service, so nothing has to be exported in the shell. Falls back to the
# environment, then to compose's default.
set -eu
cd "$(dirname "$0")/.."
token=$(sed -n 's/^PACHA_MCP_TOKEN=//p' .env 2>/dev/null | tail -n 1 | tr -d '\r')
token=${token:-${PACHA_MCP_TOKEN:-pacha-local}}
# Quotes around the value in .env are compose syntax, not part of the token.
token=$(printf '%s' "$token" | sed -e "s/^[\"']//" -e "s/[\"']$//")
printf '{"Authorization": "Bearer %s"}\n' "$token"
