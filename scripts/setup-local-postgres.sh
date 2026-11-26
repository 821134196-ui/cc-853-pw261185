#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/pg-common.sh
source "$SCRIPT_DIR/pg-common.sh"

echo "== Lock diagnostic bench setup =="
echo "Project: $ROOT_DIR"
echo "Local PostgreSQL port: $PG_PORT"

if [[ ! -d "$ROOT_DIR/node_modules/pg" ]]; then
  echo "== Installing Node dependencies =="
  npm install --cache "$PG_BASE/npm-cache" --no-audit --no-fund
fi

if ! setup_pg_env; then
  echo "== No PostgreSQL binaries found; downloading user-local Debian packages =="
  if ! command -v apt-get >/dev/null 2>&1 || ! command -v dpkg-deb >/dev/null 2>&1; then
    cat >&2 <<'EOF'
Could not find PostgreSQL and this automatic bootstrap currently supports
Debian/Ubuntu with apt-get + dpkg-deb. Install PostgreSQL 14+ and either:
  1) export DATABASE_URL=postgres://... or PGHOST/PGPORT/PGUSER/PGDATABASE, or
  2) export LOCKLAB_PG_BIN=/path/to/postgres/bin and rerun npm run setup.
EOF
    exit 1
  fi

  mkdir -p "$PG_APT_LISTS/partial" "$PG_APT_ARCHIVES/partial" "$PG_BASE/apt-cache/partial"
  APT_OPTS=(
    -o "Dir::State::Lists=$PG_APT_LISTS"
    -o "Dir::Cache=$PG_BASE/apt-cache"
    -o "Dir::Cache::archives=$PG_APT_ARCHIVES"
    -o Debug::NoLocking=true
    -o Acquire::Retries=3
  )

  # One flaky/502 mirror suite should not discard a usable main package index.
  apt-get "${APT_OPTS[@]}" update || echo "Warning: apt-get update reported partial index errors; continuing with available indexes." >&2

  DEB_DIR="$(mktemp -d /tmp/locklab-pg-debs.XXXXXX)"
  trap 'rm -rf "$DEB_DIR"' EXIT

  # postgresql-client is unnecessary: the workbench uses the pg Node driver.
  PACKAGES=(postgresql-15 libpq5 libicu72 libxml2)
  (
    cd "$DEB_DIR"
    apt-get "${APT_OPTS[@]}" download "${PACKAGES[@]}"
  )

  mkdir -p "$PG_DIST"
  for deb in "$DEB_DIR"/*.deb; do
    echo "Extracting $(basename "$deb")"
    dpkg-deb -x "$deb" "$PG_DIST"
  done

  setup_pg_env
fi

echo "Using PostgreSQL bin: $PGBIN"
"$PGBIN/postgres" --version

if [[ ! -s "$PG_DATA/PG_VERSION" ]]; then
  echo "== Initializing user-local database cluster =="
  mkdir -p "$PG_DATA" "$PG_RUN"
  "$PGBIN/initdb" \
    -D "$PG_DATA" \
    -U postgres \
    --auth-local=trust \
    --auth-host=trust \
    -E UTF8 \
    --locale=C
fi

if ! pg_is_running; then
  echo "== Starting PostgreSQL =="
  "$PGBIN/pg_ctl" \
    -D "$PG_DATA" \
    -l "$PG_LOG" \
    -W \
    start \
    -o "-h 127.0.0.1 -p $PG_PORT -k $PG_RUN -c unix_socket_directories=$PG_RUN -c max_connections=80 -c deadlock_timeout=1s -c log_lock_waits=on -c logging_collector=off"
  # -W means do not wait; use TCP probe for a deterministic readiness check.
  if ! wait_for_tcp "$PGHOST" "$PG_PORT" 80; then
    echo "PostgreSQL did not become ready. Log:" >&2
    tail -80 "$PG_LOG" >&2 || true
    exit 1
  fi
else
  echo "PostgreSQL is already running."
fi

echo "== Creating role/database =="
PGPORT="$PG_PORT" PGHOST="$PGHOST" node "$ROOT_DIR/scripts/init-db.js"

cat <<EOF

Setup complete.

  Web console: npm start then open http://127.0.0.1:${PORT:-3210}
  Database:    $PG_USER@$PGHOST:$PG_PORT/$PG_DB
  Stop DB:     npm run db:stop
  Log:         $PG_LOG

For an existing PostgreSQL instead, set DATABASE_URL or PG* variables before
running npm start.
EOF
