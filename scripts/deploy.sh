#!/usr/bin/env bash
# Pull latest code and restart PM2 backend.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_NAME="${PM2_APP_NAME:-chootistoys-backend}"

echo "[deploy] Working directory: $ROOT"

if [ -d .git ]; then
  echo "[deploy] git pull..."
  git pull --ff-only
fi

echo "[deploy] npm install..."
npm install --omit=dev

if command -v pm2 >/dev/null 2>&1; then
  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    echo "[deploy] pm2 restart $APP_NAME..."
    pm2 restart "$APP_NAME"
  else
    echo "[deploy] pm2 start $APP_NAME..."
    pm2 start src/server.js --name "$APP_NAME"
  fi
  pm2 save
  pm2 status "$APP_NAME"
else
  echo "[deploy] pm2 not found — start manually: node src/server.js"
  exit 1
fi

echo "[deploy] Done."
