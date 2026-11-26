#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/pg-common.sh
source "$SCRIPT_DIR/pg-common.sh"

echo "== Lock bench doctor =="
node --version

if [[ -d "$ROOT_DIR/node_modules/pg" ]]; then
  echo "[ok] node_modules/pg installed"
else
  echo "[missing] node_modules/pg — run npm install"
fi

if setup_pg_env; then
  echo "[ok] PostgreSQL binaries: $PGBIN"
  "$PGBIN/postgres" --version
else
  echo "[missing] PostgreSQL binaries — run npm run setup"
fi

if pg_is_running; then
  echo "[ok] local pg_ctl cluster is running (port $PG_PORT)"
else
  echo "[info] pg_ctl-managed cluster is not running; an external DATABASE_URL/PG* may still work"
fi

node "$ROOT_DIR/scripts/db-check.js" || true

if command -v curl >/dev/null 2>&1; then
  if curl -fsS "http://127.0.0.1:${PORT:-3210}/api/health" >/tmp/locklab-health.json 2>/dev/null; then
    echo "[ok] web console responds on port ${PORT:-3210}"
  else
    echo "[info] web console is not running on port ${PORT:-3210} (npm start)"
  fi
fi
