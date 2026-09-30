#!/usr/bin/env bash
# Warn loudly when exported shell variables would shadow values in .env during compose interpolation
# (e.g. an old `export DATABASE_URL=...` or `export APP_PORT=3000`). Compose gives the shell precedence
# over .env for ${VAR} interpolation. Container env comes from env_file and is not affected, but
# APP_PORT / APP_BIND / BUILD_HASH / WORKER_MEM_LIMIT are interpolated.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "No .env — copy .env.example first"; exit 1; }
status=0
for var in APP_PORT APP_BIND BUILD_HASH WORKER_MEM_LIMIT DATABASE_URL ESTIMATES_DATABASE_URL POSTGRES_PASSWORD; do
  if [ -n "${!var+x}" ]; then
    file_val=$(grep -E "^${var}=" .env | head -1 | cut -d= -f2- || true)
    echo "WARNING: \$${var} is exported in your shell (value: '${!var}')${file_val:+; .env has '${file_val}'}."
    echo "         Compose interpolation uses the shell value. Run: unset ${var}"
    status=1
  fi
done
if grep -qE '^DATABASE_URL=' .env; then
  echo "NOTE: .env defines DATABASE_URL, which this app ignores. Use ESTIMATES_DATABASE_URL."
fi
[ $status -eq 0 ] && echo "env OK: no shadowing shell variables."
exit $status
