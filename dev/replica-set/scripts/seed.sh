#!/bin/bash
# Runs inside the rs1 container: docker compose exec rs1 bash /scripts/seed.sh
set -euo pipefail
exec mongosh --quiet "mongodb://admin:admin@localhost:27117/?replicaSet=rs0&authSource=admin" --file /scripts/seed.js
