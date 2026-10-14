---
name: local-build
description: Build local Mongo GUI installers into /tmp for manual testing. Use when asked to build a local version, installer, or Linux/Windows artifact.
---

# Local build

Run `.claude/skills/local-build/build.sh [win|linux|all]` from the repo root. Default is `all`.

| Target | Where it runs | Artifacts in `/tmp/mongo-gui-build/` |
| --- | --- | --- |
| `win` | Host, Node 24 fetched into `/tmp/node24` | `win/Mongo GUI-<version>-win-x64.exe` |
| `linux` | Docker `node:24` | `linux/*.AppImage`, `linux/*.deb` |

- Set `OUT=<dir>` to change the output folder.
- Windows cannot build in Docker. `fetch-mongo-tools.ts` only unpacks Windows archives on Windows.
- The Linux build copies the working tree, uncommitted changes included. Docker Desktop must be running.
- The host pnpm and Node are too old for this repo. The script runs pnpm from `packageManager` through `npx`.
- The installers are unsigned. Windows SmartScreen shows a warning.
