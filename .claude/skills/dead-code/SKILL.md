---
name: dead-code
description: Find code that nothing calls, with knip. Use when asked to find dead code, unused functions, unused exports or unreachable code, or to clean up the codebase.
---

# Find dead code

Run from the repo root:

```sh
pnpm run knip
```

The script is `knip --production --exclude duplicates`. The config is `knip.jsonc`.

## What the report means

Production mode starts at the real entry points and follows every import. Code that no entry point
reaches is reported. Tests, stories and test helpers do not count as callers, so a function that
only a test calls is reported too.

| Section | Meaning |
| --- | --- |
| Unused files | No entry point imports the file. |
| Unused dependencies | A package in `package.json` that no production file imports. |
| Unused exports | A function or constant with `export` that no other production file imports. |
| Unused exported types | The same for TypeScript types. |

`ignoreExportsUsedInFile` is on. An export that the same file still calls is not reported, so every
reported export has no production caller at all.

The report is clean now, so any line it prints is new dead code. Three exports are kept on purpose and
listed under `ignoreIssues` in `knip.jsonc`: `fromChildProcess`, `themeRules` and `exportText`.
Tests or the e2e wiring server use them.

## Entry points

These are the starting points in `knip.jsonc`. Add a new one there when the app gets a new process
or a new bundle, or knip reports everything behind it as dead.

- `packages/app/src/main/index.ts`: the Electron main process.
- `packages/app/src/preload/index.ts`: the preload script.
- `packages/app/src/renderer/main.tsx`: the window UI.
- `packages/ui/src/browser-main.tsx`: the browser mock UI from `pnpm dev:ui`.
- `src/index.ts` of each package, plus `core/src/rpc/channels.ts` and `storage/src/spill/index.ts`.
- `packages/shell-runtime`: `main.ts` starts a separate process. Knip does not follow its imports,
  so `session.ts`, `host.ts` and `transport.ts` are listed as entries too.

## Check each finding before you delete

Knip cannot see some uses. Search the repo for the name first (`grep -rn name packages --include=*.ts --include=*.tsx`).

1. A name used only in `*.test.ts` files. The function is dead in the app. Delete it and its
   tests, or keep it and say it is test-only. Do not delete it alone, because the tests would fail.
2. A name used through a string, such as a menu id, an RPC channel name or `import.meta.glob`. Knip
   sees no import. Keep it.
3. CSS or font imports (`@fontsource/...`). Knip does not read CSS. The UI package lists them
   under `ignoreDependencies`.
4. Code that Storybook, Playwright (`e2e/`) or the scripts in `dev/` use. They are outside the
   production graph on purpose. Keep it if one of them calls it.
5. A public export of a workspace package that another package imports under a different path.
   Check `exports` in that package's `package.json`.

## After a deletion

1. Run `pnpm run check` for lint, typecheck and the unit tests. Run a failing test file alone
   before you call a failure real, because Vitest workers crash now and then.
2. Run `pnpm run knip` again. Removing one function can leave its helpers unused.
3. Commit the deletion on its own, not mixed with a feature.

## Notes for someone new to React

- A component is a function that returns markup, for example `function Panel()`. It is used when
  another file writes `<Panel />`. Search for `<Panel`, not for `Panel(`.
- A hook is a function whose name starts with `use`. Search for `useName(`.
- A `*.stories.tsx` file is a Storybook example. It is not part of the app.
- A `*-model.ts` file holds plain logic that a component calls. Most findings land there.
