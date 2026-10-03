#!/usr/bin/env bash
# Run a bun command inside a disposable container (keeps the host clean).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# No network unless asked: joining the compose network by default put every lint and typecheck on a running
# production stack's internal network. Set OM_NETWORK=openmanga_internal for commands that need its postgres/redis.
NET_ARGS=()
if [ -n "${OM_NETWORK:-}" ]; then NET_ARGS=(--network "$OM_NETWORK"); fi
exec docker run --rm -i -u "$(id -u):$(id -g)" -e HOME=/tmp -e BUN_INSTALL_CACHE_DIR=/cache \
  -v openmanga-bun-cache:/cache -v "$ROOT":/repo -w /repo "${NET_ARGS[@]}" \
  ${OM_ENV_FILE:+--env-file "$OM_ENV_FILE"} ${OM_DOCKER_ARGS:-} oven/bun:1.4-debian "$@"
