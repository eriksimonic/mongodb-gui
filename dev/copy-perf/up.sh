#!/bin/bash
# Starts the two servers, waits until both are healthy, seeds the data, and prints the URIs.
# Extra arguments go to seed.mjs, for example `bash up.sh --force`.
set -euo pipefail
cd "$(dirname "$0")"

docker compose up -d --wait
node seed.mjs "$@"

cat <<MSG

Server A, the source. Holds shop.events (1,000,000 documents) and shop.customers:
  mongodb://127.0.0.1:27217/

Server B, the target. Starts empty:
  mongodb://127.0.0.1:27218/

Add each URI as a connection in the app and name them mongo-a and mongo-b.
To copy, see README.md.
MSG
