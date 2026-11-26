#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -z "${DATABASE_URL:-}" && "${PG_AUTO_SETUP:-1}" == "1" ]]; then
  bash "$SCRIPT_DIR/setup-local-postgres.sh"
fi

cd "$ROOT_DIR"
exec node server/server.js
