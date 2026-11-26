#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/pg-common.sh
source "$SCRIPT_DIR/pg-common.sh"

if setup_pg_env && pg_is_running; then
  "$PGBIN/pg_ctl" -D "$PG_DATA" -m fast stop
  echo "PostgreSQL stopped."
else
  echo "PostgreSQL is not running."
fi
