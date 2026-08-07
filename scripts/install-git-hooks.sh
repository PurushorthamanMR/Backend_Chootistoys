#!/usr/bin/env bash
# One-time setup on the server: enable post-merge auto-restart after git pull.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_SRC="$ROOT/scripts/git-hooks/post-merge"
HOOK_DST="$ROOT/.git/hooks/post-merge"

if [ ! -d "$ROOT/.git" ]; then
  echo "Not a git repo: $ROOT"
  exit 1
fi

if [ ! -f "$HOOK_SRC" ]; then
  echo "Missing hook source: $HOOK_SRC"
  exit 1
fi

cp "$HOOK_SRC" "$HOOK_DST"
chmod +x "$HOOK_DST" "$HOOK_SRC" "$ROOT/scripts/deploy.sh" "$ROOT/scripts/install-git-hooks.sh"

echo "Installed: $HOOK_DST"
echo "Now every successful 'git pull' will npm install + pm2 restart chootistoys-backend"
