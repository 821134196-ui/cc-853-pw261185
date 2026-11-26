#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/pg-common.sh
source "$SCRIPT_DIR/pg-common.sh"

setup_pg_env

if pg_is_running; then
  echo "PostgreSQL already running on port $PG_PORT"
  exit 0
fi

if [[ ! -s "$PG_DATA/PG_VERSION" ]]; then
  echo "No cluster at $PG_DATA; run npm run setup first." >&2
  exit 1
fi

"$PGBIN/pg_ctl" \
  -D "$PG_DATA" \
  -l "$PG_LOG" \
  -w \
  start \
  -o "-h 127.0.0.1 -p $PG_PORT -k $PG_RUN -c unix_socket_directories=$PG_RUN -c max_connections=80 -c deadlock_timeout=1s -c log_lock_waits=on"

wait_for_tcp "$PGHOST" "$PG_PORT" 50
echo "PostgreSQL ready at $PGHOST:$PG_PORT"
