#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set. Put it in .env or export it before running." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
outfile="$BACKUP_DIR/inventory_bot-$timestamp.dump"

pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges --file="$outfile"
gzip -f "$outfile"

find "$BACKUP_DIR" -name 'inventory_bot-*.dump.gz' -type f -mtime +"$RETENTION_DAYS" -delete

echo "Backup written to $outfile.gz"
