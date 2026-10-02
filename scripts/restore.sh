#!/usr/bin/env bash
# Restore a backup created by scripts/backup.sh. DESTRUCTIVE: replaces the database and all assets.
# With STORAGE_DRIVER=s3 only the database and configuration are restored; bucket objects are restored with the
# bucket's own tools (see docs/STORAGE.md).
# Usage: scripts/restore.sh <backup-dir> [--yes]
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:?usage: scripts/restore.sh <backup-dir> [--yes]}"
[ -f "$SRC/postgres.dump" ] && [ -f "$SRC/SHA256SUMS" ] || { echo "Not a backup directory: $SRC" >&2; exit 1; }
if [ "${2:-}" != "--yes" ]; then
  read -r -p "This replaces ALL current data with $SRC. Type 'restore' to continue: " answer
  [ "$answer" = "restore" ] || { echo "Aborted"; exit 1; }
fi

( cd "$SRC" && sha256sum -c SHA256SUMS )

PROJECT="$(docker compose config --format json 2>/dev/null | sed -n 's/^ *"name": "\(.*\)",$/\1/p' | head -1)"
PROJECT="${PROJECT:-openmanga}"
set -a
# shellcheck disable=SC1091
[ -f .env ] && . ./.env
set +a
PGUSER="${POSTGRES_USER:-openmanga}"
PGDB="${POSTGRES_DB:-openmanga}"

echo "==> Stopping application services"
docker compose stop nginx api worker mock-ai 2>/dev/null || true
docker compose up -d postgres redis
until docker compose exec -T postgres pg_isready -U "$PGUSER" -d "$PGDB" >/dev/null 2>&1; do sleep 1; done

echo "==> Restoring PostgreSQL"
docker compose exec -T postgres psql -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 \
  -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$PGDB' and pid <> pg_backend_pid();" \
  -c "drop database if exists \"$PGDB\";" -c "create database \"$PGDB\" owner \"$PGUSER\";"
docker compose exec -T postgres pg_restore -U "$PGUSER" -d "$PGDB" --no-owner --exit-on-error < "$SRC/postgres.dump"

if [ ! -f "$SRC/assets.tar.gz" ]; then
  echo "==> No asset archive in this backup (taken with STORAGE_DRIVER=s3): restore the bucket's objects separately"
elif [ "${STORAGE_DRIVER:-local}" = "s3" ]; then
  echo "==> Not restoring assets.tar.gz: this install keeps assets in a bucket. To move them there, extract the"
  echo "    archive and sync it to the bucket as in docs/STORAGE.md (Moving to S3)."
else
  echo "==> Restoring assets"
  docker run --rm -v "${PROJECT}_assets-data:/data" -v "$(realpath "$SRC"):/backup:ro" alpine:3.20 \
    sh -c 'find /data -mindepth 1 -delete && tar xzf /backup/assets.tar.gz -C /data && chown -R 1000:1000 /data'
fi

echo "==> Clearing queues (the worker re-publishes still-queued jobs from the database within a minute of starting)"
docker compose exec -T redis redis-cli FLUSHALL >/dev/null

echo "==> Starting services"
docker compose up -d
echo "Restore complete from $SRC"
