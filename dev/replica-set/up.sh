#!/bin/bash
# Starts the replica set, initiates it, seeds the data, and prints the URIs.
set -euo pipefail
cd "$(dirname "$0")"

docker compose up -d

ok=0
for attempt in $(seq 1 30); do
  if docker compose exec -T rs1 bash /scripts/init.sh; then
    ok=1
    break
  fi
  echo "init attempt ${attempt} failed, retrying in 5 seconds"
  sleep 5
done
if [ "$ok" -ne 1 ]; then
  echo "Replica set init failed after 30 attempts" >&2
  exit 1
fi

docker compose exec -T rs1 bash /scripts/seed.sh

cat <<MSG

Direct connection to rs1 (the app shows "direct"):
  mongodb://admin:admin@127.0.0.1:27117/?directConnection=true&authSource=admin

Full replica set URI (needs the /etc/hosts line from README.md):
  mongodb://admin:admin@127.0.0.1:27117,127.0.0.1:27118,127.0.0.1:27119/?replicaSet=rs0&authSource=admin
MSG
