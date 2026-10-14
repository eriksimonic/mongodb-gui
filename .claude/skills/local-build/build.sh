#!/usr/bin/env bash
# Usage: build.sh [win|linux|all]   Output: ${OUT:-/tmp/mongo-gui-build}/<target>/
set -euo pipefail
target="${1:-all}"
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
out="${OUT:-/tmp/mongo-gui-build}"
mkdir -p "$out"
export npm_config_manage_package_manager_versions=false

# Pinned pnpm (packageManager field) via npx, so no global pnpm 12 is needed.
pnpm_version="$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "$repo/package.json")"

build_win() {
  # The mongo-tools fetch cannot unpack Windows archives on Linux, so this runs on the host.
  local node24=/tmp/node24
  [ -x "$node24/node_modules/node/bin/node.exe" ] || npm i --prefix "$node24" node@24
  export PATH="$node24/node_modules/node/bin:$PATH"
  cd "$repo"
  npx -y "pnpm@$pnpm_version" install --frozen-lockfile
  npx -y "pnpm@$pnpm_version" --filter @mongo-gui/app dist
  rm -rf "$out/win" && mkdir -p "$out/win"
  cp "$repo"/packages/app/release/*.exe "$out/win/"
}

build_linux() {
  # Copies the working tree (uncommitted changes included) into a Linux volume, so the host
  # node_modules and release folders never mix with the container's.
  rm -rf "$out/linux" && mkdir -p "$out/linux"
  tar -C "$repo" --exclude=node_modules --exclude=.git --exclude=release --exclude='packages/app/out' -cf - . |
    docker run --rm -i -v "$(cygpath -m "$out/linux" 2>/dev/null || echo "$out/linux"):/out" node:24 bash -c '
      set -e
      mkdir /work && tar -C /work -xf - && cd /work
      export npm_config_manage_package_manager_versions=false
      npx -y pnpm@'"$pnpm_version"' install --frozen-lockfile
      npx -y pnpm@'"$pnpm_version"' --filter @mongo-gui/app dist
      cp packages/app/release/*.AppImage packages/app/release/*.deb /out/'
}

case "$target" in
  win) build_win ;;
  linux) build_linux ;;
  all) build_win; build_linux ;;
  *) echo "usage: build.sh [win|linux|all]" >&2; exit 2 ;;
esac
echo "Artifacts in $out"
