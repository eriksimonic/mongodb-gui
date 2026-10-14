#!/usr/bin/env bash
# Copies the mounted source, installs, and runs the real Electron dev app on a virtual display.
set -e
Xvfb :99 -screen 0 1600x1000x24 &
export DISPLAY=:99
fluxbox >/dev/null 2>&1 &
x11vnc -display :99 -forever -nopw -quiet >/dev/null 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &
mkdir /work && cp -r /src/. /work && cd /work
export npm_config_manage_package_manager_versions=false
npx -y pnpm@"$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' package.json)" install --frozen-lockfile
cd packages/app
node "$(dirname "$(node -p "require.resolve('electron/package.json')")")/install.js"
npx -y pnpm@12.10.1 run build:shell-runtime
exec npx -y pnpm@12.10.1 exec electron-vite dev --noSandbox
