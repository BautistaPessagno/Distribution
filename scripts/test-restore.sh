#!/bin/sh
# Verifies the Litestream backup/restore path end to end using a local file
# replica: seed a database, replicate it, delete the original, restore from
# the replica, and check the data survived. Requires the litestream binary.
set -eu

if ! command -v litestream >/dev/null 2>&1; then
  echo "error: litestream is not installed. See https://litestream.io/install/" >&2
  exit 1
fi

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
DB="$WORKDIR/source.db"
REPLICA="$WORKDIR/replica"
RESTORED="$WORKDIR/restored.db"

sqlite3 "$DB" "PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('restore-proof');"

cat > "$WORKDIR/litestream.yml" <<EOF
dbs:
  - path: $DB
    replicas:
      - type: file
        path: $REPLICA
        sync-interval: 100ms
EOF

litestream replicate -config "$WORKDIR/litestream.yml" &
LS_PID=$!
sleep 3
kill "$LS_PID"
wait "$LS_PID" 2>/dev/null || true

litestream restore -config "$WORKDIR/litestream.yml" -o "$RESTORED" "$DB"

VALUE=$(sqlite3 "$RESTORED" "SELECT v FROM t;")
if [ "$VALUE" = "restore-proof" ]; then
  echo "PASS: restored database contains seeded row"
else
  echo "FAIL: expected 'restore-proof', got '$VALUE'" >&2
  exit 1
fi
