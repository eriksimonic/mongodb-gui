#!/usr/bin/env bash
# Usage: run.sh   Opens the real app at http://localhost:6080/vnc.html. Stop: docker rm -f mongo-gui-electron
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
src=/tmp/mgui-electron-src
docker rm -f mongo-gui-electron >/dev/null 2>&1 || true
rm -rf "$src" && mkdir -p "$src"
tar -C "$repo" --exclude=node_modules --exclude=.git --exclude=release --exclude=out -cf - . | tar -C "$src" -xf -
docker build -q -t mongo-gui-electron "$repo/dev/electron-docker"
docker run -d --name mongo-gui-electron --shm-size=1g -p 6080:6080 \
  --add-host=host.docker.internal:host-gateway \
  -v "$(cygpath -m "$src" 2>/dev/null || echo "$src"):/src:ro" mongo-gui-electron
echo "Starting. Open http://localhost:6080/vnc.html?autoconnect=1&resize=scale once 'docker logs mongo-gui-electron' shows 'shell state changed'."
