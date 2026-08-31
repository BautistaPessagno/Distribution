#!/bin/sh
# One-command deploy from a clean checkout: ./scripts/deploy.sh
# Requires: flyctl authenticated (fly auth login), and the Litestream secrets
# set once via:
#   fly secrets set LITESTREAM_BUCKET=... LITESTREAM_ENDPOINT=... \
#     LITESTREAM_ACCESS_KEY_ID=... LITESTREAM_SECRET_ACCESS_KEY=...
set -eu
cd "$(dirname "$0")/.."

if ! command -v fly >/dev/null 2>&1 && ! command -v flyctl >/dev/null 2>&1; then
  echo "error: flyctl is not installed. See https://fly.io/docs/flyctl/install/" >&2
  exit 1
fi
FLY=$(command -v fly || command -v flyctl)

"$FLY" deploy --remote-only
