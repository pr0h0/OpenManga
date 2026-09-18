#!/usr/bin/env bash
# Run a bun command inside a disposable container (keeps the host clean).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NET_ARGS=()
if docker network inspect openmanga_internal >/dev/null 2>&1; then NET_ARGS=(--network openmanga_internal); fi
exec docker run --rm -i -u "$(id -u):$(id -g)" -e HOME=/tmp -e BUN_INSTALL_CACHE_DIR=/cache \
  -v openmanga-bun-cache:/cache -v "$ROOT":/repo -w /repo "${NET_ARGS[@]}" \
  ${OM_ENV_FILE:+--env-file "$OM_ENV_FILE"} ${OM_DOCKER_ARGS:-} oven/bun:1.4-debian "$@"
