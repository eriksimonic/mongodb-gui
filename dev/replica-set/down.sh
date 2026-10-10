#!/bin/bash
# Stops the replica set and deletes its named volumes.
set -euo pipefail
cd "$(dirname "$0")"
docker compose down -v
