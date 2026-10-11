#!/usr/bin/env bash
# Starts a single mongod on 127.0.0.1:27217 (no auth) and seeds db `grid`.
set -euo pipefail
cd "$(dirname "$0")"
docker start mongo-gui-grid 2>/dev/null || docker run -d --name mongo-gui-grid -p 127.0.0.1:27217:27017 -v mongo-gui-grid:/data/db mongo:7.0 >/dev/null
until docker exec mongo-gui-grid mongosh --quiet --eval 'db.adminCommand("ping").ok' >/dev/null 2>&1; do sleep 1; done
docker exec -i mongo-gui-grid mongosh --quiet < seed.js
echo "mongodb://127.0.0.1:27217/grid"
