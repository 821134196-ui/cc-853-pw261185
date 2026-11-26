#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

# Keep integration resets away from a developer's running console database.
# DATABASE_URL remains an explicit escape hatch and is used verbatim.
if [[ -z "${DATABASE_URL:-}" ]]; then
  export PGHOST="${PGHOST:-127.0.0.1}"
  export PGPORT="${PGPORT:-55432}"
  export PGUSER="${PGUSER:-locklab}"
  export PGPASSWORD="${PGPASSWORD:-locklab}"
  export PGDATABASE="${PGTEST_DATABASE:-locklab_test}"
fi

if [[ "${PG_AUTO_SETUP:-1}" == "1" ]]; then
  if ! node scripts/db-check.js >/dev/null 2>&1; then
    echo "== Test database is not reachable; running local setup =="
    bash "$SCRIPT_DIR/setup-local-postgres.sh"
    # Setup defaults PGDATABASE to locklab when invoked without our exported
    # test name in some shells; init the requested test DB explicitly.
    node "$ROOT_DIR/scripts/init-db.js"
  fi
fi

exec node --test test/*.test.js
