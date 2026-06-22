#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
BOT_LOG="$LOG_DIR/cloudways-bot.log"

mkdir -p "$LOG_DIR"

# Cloudways shells can start with a minimal PATH. Load the common profile files
# if they exist so Node / npm / pm2 become available in cron and SSH sessions.
for profile in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.bash_aliases"; do
  if [[ -f "$profile" ]]; then
    # shellcheck disable=SC1090
    source "$profile"
  fi
done

cd "$ROOT_DIR"

if pgrep -f "node src/bot.js" >/dev/null 2>&1; then
  echo "inventory-bot is already running"
  exit 0
fi

if command -v pm2 >/dev/null 2>&1; then
  pm2 start ecosystem.config.cjs --only inventory-bot >/dev/null
  pm2 save >/dev/null 2>&1 || true
  echo "Started inventory-bot with pm2"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is not available on PATH. Install Node.js first or source your Cloudways shell profile." >&2
  exit 1
fi

nohup node src/bot.js >>"$BOT_LOG" 2>&1 &
echo "Started inventory-bot with nohup"
