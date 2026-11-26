#!/usr/bin/env bash
# Shared paths/helpers for the reproducible local PostgreSQL bench.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_PORT="${PG_PORT:-55432}"
PGHOST="${PGHOST:-127.0.0.1}"
PG_BASE="${PG_LOCAL_DIR:-$ROOT_DIR/.postgres}"
PG_DIST="$PG_BASE/dist"
PG_DATA="$PG_BASE/data"
PG_RUN="$PG_BASE/run"
PG_LOG="$PG_BASE/postgres.log"
PG_APT_LISTS="$PG_BASE/apt-lists"
PG_APT_ARCHIVES="$PG_BASE/apt-archives"
PG_USER="${PGUSER:-locklab}"
PG_DB="${PGDATABASE:-locklab}"

mkdir -p "$PG_BASE" "$PG_RUN"

find_pg_bin() {
  if [[ -n "${LOCKLAB_PG_BIN:-}" && -x "$LOCKLAB_PG_BIN/initdb" ]]; then
    printf '%s\n' "$LOCKLAB_PG_BIN"
    return 0
  fi

  local candidate
  for candidate in "$PG_DIST"/usr/lib/postgresql/*/bin /usr/lib/postgresql/*/bin /usr/local/pgsql/bin; do
    if [[ -x "$candidate/initdb" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  if command -v initdb >/dev/null 2>&1; then
    dirname "$(command -v initdb)"
    return 0
  fi
  return 1
}

setup_pg_env() {
  local pg_bin
  pg_bin="$(find_pg_bin || true)"
  if [[ -z "$pg_bin" ]]; then
    return 1
  fi
  export PGBIN="$pg_bin"
  export PATH="$PGBIN:$PATH"

  local lib_dirs=()
  local dir
  for dir in "$PG_DIST/usr/lib/x86_64-linux-gnu" "$PG_DIST/usr/lib/aarch64-linux-gnu" "$PG_DIST/usr/lib" "$PG_DIST/lib/x86_64-linux-gnu" "$PG_DIST/lib"; do
    [[ -d "$dir" ]] && lib_dirs+=("$dir")
  done
  if [[ ${#lib_dirs[@]} -gt 0 ]]; then
    local joined
    joined="$(IFS=:; echo "${lib_dirs[*]}")"
    export LD_LIBRARY_PATH="$joined${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  fi
  return 0
}

pg_is_running() {
  setup_pg_env || return 1
  "$PGBIN/pg_ctl" -D "$PG_DATA" status >/dev/null 2>&1
}

wait_for_tcp() {
  local host="$1" port="$2" tries="${3:-50}"
  node - "$host" "$port" "$tries" <<'NODE'
const net = require('node:net');
const [host, port, triesArg] = process.argv.slice(2);
const tries = Number(triesArg);
let i = 0;
function attempt() {
  const socket = net.connect({ host, port: Number(port) });
  socket.once('connect', () => socket.end(() => process.exit(0)));
  socket.once('error', () => {
    socket.destroy();
    if (++i >= tries) process.exit(1);
    setTimeout(attempt, 150);
  });
}
attempt();
NODE
}
