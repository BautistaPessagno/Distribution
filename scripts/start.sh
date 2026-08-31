#!/bin/sh
# Container entrypoint. With LITESTREAM_ENABLED=1, restores the database from
# the replica when the local copy is missing, then runs the app under
# litestream replication. Without it, runs the app directly (development).
set -eu

if [ "${LITESTREAM_ENABLED:-0}" = "1" ]; then
  mkdir -p "$(dirname "$DATABASE_PATH")"
  if [ ! -f "$DATABASE_PATH" ]; then
    echo "database missing; attempting restore from replica"
    litestream restore -config /etc/litestream.yml -if-replica-exists "$DATABASE_PATH"
  fi
  exec litestream replicate -config /etc/litestream.yml \
    -exec "node dist/server/main.js"
else
  exec node dist/server/main.js
fi
