#!/usr/bin/env bash
# Starts a single mongod 8.0.17 on 127.0.0.1:27218 (no auth) and seeds db `explain_lab`.
set -euo pipefail
cd "$(dirname "$0")"
docker start mongo-gui-explain-lab 2>/dev/null || docker run -d --name mongo-gui-explain-lab -p 127.0.0.1:27218:27017 -v mongo-gui-explain-lab:/data/db mongo:8.0.17 >/dev/null
until docker exec mongo-gui-explain-lab mongosh --quiet --eval 'db.adminCommand("ping").ok' >/dev/null 2>&1; do sleep 1; done
docker cp seed.js mongo-gui-explain-lab:/tmp/seed.js
docker exec mongo-gui-explain-lab mongosh --quiet --file /tmp/seed.js
echo "mongodb://127.0.0.1:27218/explain_lab"
