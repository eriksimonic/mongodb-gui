---
name: run-app
description: Launch and drive Mongo GUI. Use when asked to run, start or screenshot the app, or to see a UI change working. Covers the Electron app and the browser-only mock UI.
---

# Run Mongo GUI

The repo has two ways to run the UI. Pick the one that fits the job.

| Goal | Launch | Data |
| --- | --- | --- |
| Use the real app, with connections and a master password | Electron dev app | Real vault and servers |
| Check a UI change, take screenshots, drive it with Playwright | Browser mock UI | Mock connections and documents |

Run one Electron or Playwright session at a time. Several at once have crashed this machine before.

## Electron dev app

1. Run `pnpm install` once if `node_modules` is missing.
2. Build the shell runtime once, and again after changes under `packages/shell-runtime`:
   `pnpm --filter @mongo-gui/app run build:shell-runtime`
3. Start the app from the repo root, in the background so the shell stays free:
   `cd packages/app && nohup pnpm exec electron-vite dev --noSandbox > <scratchpad>/electron.log 2>&1 &`

`pnpm dev` runs the same command without `--noSandbox`. On this Linux machine it aborts with
`The SUID sandbox helper binary was found, but is not configured correctly`, because
`chrome-sandbox` inside `node_modules/.../electron/dist` is not owned by root. Either keep the
`--noSandbox` flag, or run once `sudo chown root <path to chrome-sandbox> && sudo chmod 4755 <path>`.

The window opens on the display in `$DISPLAY`. The log fills with `libEGL warning` lines, which are
harmless. The line `shell state changed` means the main process is up. The renderer reloads on
source changes, so leave the process running while you edit.

Stop it with `fuser -k 5173/tcp`, which ends the dev server, then `pkill -f "[e]lectron/dist"`. The
call can exit with code 144 even though the kill worked, so check with
`pgrep -fc "[e]lectron/dist"`, which prints 0 when the app is gone. Do not use `pkill -f vite`,
because it also matches the shell that runs the command.

### Restart

Always stop a running app before you start one, because a second instance fights over port 5173
and the vault. To restart, run the stop commands above in their own call, confirm the count is 0,
then repeat step 3 in a new call. Check
the log for `shell state changed` before you say the app is up. Do this whenever the user asks to
run the app again, and after changes under `packages/shell-runtime` or `packages/app/src/main`,
which the renderer reload does not pick up.

## Browser mock UI

1. Start the dev server in the background: `pnpm dev:ui`. It serves `http://localhost:5174/`.
2. Open `http://localhost:5174/?preset=unlocked`. The preset skips the master password and loads
   the mock connections. Add `&replset=member` for the replica set mock.
3. Stop it with `fuser -k 5174/tcp`.

The mock shell ignores `$lookup`, so a join shows unjoined rows.

### Driving it with Playwright

Chromium is not bundled. Use the installed Chrome and the `@playwright/test` package from the repo:

```js
import { chromium } from '/home/erik/Documents/mongo-gui/node_modules/@playwright/test/index.mjs';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://localhost:5174/?preset=unlocked');
```

Keep scripts in the session scratchpad, not in the repo. Look at the screenshot after each step.
A blank frame means the page failed to load.

Selectors that work:

- Connection menu: `page.getByText('Local dev', { exact: true }).first().click({ button: 'right' })`,
  then `getByRole('menuitem', { name: 'Connect', exact: true })`. Without `exact`, "Disconnect" and
  "Sharding" also match.
- New query tab: the menu item "Open editor".
- Mongo/SQL toggle: the radio input is hidden, so click `page.locator('label[for$="-sql"]')`.
- Monaco editor: click `.monaco-editor .view-lines` first, then use `page.keyboard`. Clicking the
  textbox role fails because the view lines cover it.
- F5 or Ctrl+Enter runs the statement under the cursor.
- Mantine Switch: click `getByRole('switch')`, not the label.
- Tree nodes expand with ArrowRight.

## Checks before you say it works

Run `pnpm run check` for lint, typecheck and the unit tests. It exits non-zero on a worker crash
(`SIGSEGV` in a Vitest worker) or on a timer that fires after jsdom teardown. Both are known flakes,
so run the failing file alone, or `pnpm run test` again, before you treat the failure as real. Run
vitest through the root scripts, not from `packages/ui`, or the config differs and many tests fail.
