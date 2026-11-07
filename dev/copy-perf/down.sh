#!/bin/bash
# Stops both servers and deletes their data. The seed is lost, so the next up.sh seeds again.
set -euo pipefail
cd "$(dirname "$0")"
docker compose down -v
