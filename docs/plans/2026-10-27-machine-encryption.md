# Machine encryption: execution plan

Plan file: `docs/plans/2026-10-27-machine-encryption.md`. Status file: `docs/plans/2026-10-27-machine-encryption.status.md`. CPD baseline file: `docs/plans/2026-10-27-machine-encryption.cpd-baseline.md`. All paths below are relative to the repo root `C:\_git\mongo-gui`.

## Goal and done check

The store stays encrypted in both modes. A random data key (DEK) encrypts the store with AES-256-GCM, as it does today. Password mode keeps today's design: a scrypt key from the master password wraps the DEK in `keyring.json`, and the app shows the unlock screen at startup. The new device mode wraps the DEK with Electron `safeStorage` (DPAPI, Keychain, libsecret or KWallet) and unlocks the vault at startup without a prompt. The DEK and the store format do not change, so nothing is re-encrypted.

The work is done when all of the following are true:

- `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm format:check` pass with no failure or new lint warning beyond the baseline. The baseline lint run has 12 warnings, and the final run may have no more than 12.
- A first run in the mock UI shows the choice screen with nothing selected. Machine encryption creates the vault in device mode, and password encryption leads to the existing password form.
- With `?preset=fresh&devicekey=basic-text`, the machine option is disabled and shows the reason, the "How to set up a keyring" link and "Check again".
- With `?preset=device`, Settings shows "Set master password" and hides the idle lock, "Change master password" and "Lock now". The shell has no Lock button.
- With `?preset=unlocked`, Settings shows "Remove master password" next to the existing rows.
- With `?preset=device-locked`, the app unlocks without a prompt. With `?preset=device-locked&deviceunlock=fail`, it shows the recovery screen, which has "Try again" and "Reset store".
- `docs/security.md` states the threat model for device mode. `docs/PLAN.md` 3.2 and 3.4 describe both modes. The CHANGELOG has an `## Unreleased` entry.
- T10 has reported its CPD comparison against the T0 baseline.
- `git status --porcelain` lists only files named in this plan, the plan, its status file and its CPD baseline file. `docs/screenshots` is unchanged.

## Constraints and do-not-change list

- Do not change the encrypted store format, the AES-GCM code (`packages/storage/src/crypto/aead.ts`), the scrypt parameters or `DEFAULT_KDF_PARAMS` (`packages/storage/src/crypto/kdf.ts`), or the DEK AAD string `mongo-gui:dek:v1` (`vault.ts:28`).
- Do not change the export file format or anything under `packages/*/src/**/connections-file*`.
- Password mode writes exactly the version 1 keyring shape that it writes today, byte for byte, so older app versions can still open password-mode data.
- Do not rename or change existing RPC calls. `vault.initialise({password})`, `vault.unlock({password})` and `vault.changePassword` keep their names and inputs. The schemas only gain the optional field and the new calls listed in the spec.
- Do not edit `docs/screenshots`. It holds exactly six files (`diagnostics.png`, `explain.png`, `monitoring.png`, `profiler.png`, `query.png`, `sql.png`), and none of them shows the first-run screen, so none becomes stale. Test and manual-check images go to `e2e/output`.
- Add no runtime dependency. `safeStorage` comes from the existing `electron` dependency (`^44.7.0`).
- `packages/storage` must not import `electron`. The provider is injected (see the spec).
- Write the simplest code that meets the task. Add no interface, factory or wrapper beyond the ones the spec names. Use named exports and match the style of the file you edit. UI strings are inline, with no i18n.
- Prose in docs, comments, UI strings and commits follows the unslop rules: plain whole sentences, sentence case, no em dashes, no bold-label lists.
- Every task edits only the files it lists. A Haiku implementer that finds the plan wrong reports and stops without guessing. The plan counts as wrong when a file is missing, a line range has moved by more than 30 lines, a name clashes, or an acceptance command cannot pass for a reason outside the task.

## Baseline

The baseline was taken before any change.

- `pnpm typecheck` passes.
- `pnpm lint` passes with 0 errors and 12 warnings: 9 react-hooks "Compilation Skipped" and 3 exhaustive-deps.
- `pnpm test` passes 365 files, with 6910 tests passed, 6 skipped and 0 failed.

Commands:

- Single test file: `pnpm exec vitest run --project unit <path>`. The unit project includes `packages/*/src/**/*.test.{ts,tsx}` and `tests/**/*.test.ts`.
- Typecheck one package: `pnpm exec tsc -b packages/<name>`.
- Lint one file: `pnpm exec eslint <path>`.
- Format check: `pnpm format:check`. Full gate: `pnpm check`.

T0 records the CPD baseline before any change.

### Expected red windows

No agent blames these on its own task.

- From T3 until T5 is done, root `pnpm typecheck` fails in `packages/ui/src/api/mock-rpc-client.ts`. That file types the mock as `RpcClient`, which lacks the new calls until T5 adds them.
- From T3 until T4b is done, `packages/app/src/main/rpc/router.test.ts` fails "answers every contract method without treating it as unknown" (line ~322).
- From T1 until T2 is done, `pnpm exec tsc -b packages/storage` fails in `vault.ts` and `vault.test.ts` (`kdf` does not exist on the keyring union).
- From T2 until T4a is done, nothing app-side uses the new Vault options. That is fine, and no red window is expected there.

Each task's acceptance command is scoped so that it passes during these windows.

## Specification

Every task references this section. Nothing here is left to the implementer.

### S1. Keyring file (`packages/storage/src/vault/keyring.ts`)

Version 1 stays the password keyring, unchanged. Version 2 is the device keyring. The file holds one wrap only. Switching modes overwrites `keyring.json` through the existing atomic `writeKeyringFile` (temp file, fsync, rename), which is also how the old wrap is deleted. No code writes a second file.

- Change `canonicalBase64(bytes)` to `canonicalBase64(minBytes: number, maxBytes = minBytes)`. It accepts canonical base64 whose decoded length is within the inclusive range.
- Add `const MAX_DEVICE_WRAPPED_BYTES = 4096;`. The `safeStorage` output length varies by platform, so the field is bounded rather than fixed.
- `PasswordKeyringSchema` is the current object (`version: z.literal(1)`, `kdf`, `wrappedDek: canonicalBase64(WRAPPED_DEK_BYTES)`), `.strict()`.
- `DeviceKeyringSchema = z.object({ version: z.literal(2), mode: z.literal('device'), wrappedDek: canonicalBase64(1, MAX_DEVICE_WRAPPED_BYTES) }).strict()`.
- `export const KeyringFileSchema = z.discriminatedUnion('version', [PasswordKeyringSchema, DeviceKeyringSchema]);`
- Exported types:
  - `export type PasswordKeyring = z.infer<typeof PasswordKeyringSchema>;`
  - `export type DeviceKeyring = z.infer<typeof DeviceKeyringSchema>;`
  - `export type KeyringFile = PasswordKeyring | DeviceKeyring;`
- `export function keyringMode(keyring: KeyringFile): VaultMode` returns `'password'` for version 1 and `'device'` for version 2. `VaultMode` is imported from `@mongo-gui/core` (S3).
- `parseKeyringFile`, `readKeyringFile`, `writeKeyringFile` and `removeKeyringFile` keep their signatures. They now take or return the union type. Parse errors still throw the single fixed INTERNAL message.

### S2. Device key provider and Vault (`packages/storage/src/vault/vault.ts`)

The provider interface is declared in `vault.ts` and exported from `packages/storage/src/index.ts` line 5 as `export { Vault, type VaultOptions, type DeviceKeyProvider } from './vault/vault';`.

```ts
export interface DeviceKeyProvider {
  availability(): DeviceKeyAvailability; // from @mongo-gui/core
  encrypt(dek: Buffer): Buffer;
  decrypt(wrapped: Buffer): Buffer;
}
```

`VaultOptions` gains `readonly deviceKey?: DeviceKeyProvider;`. When it is absent, `deviceKeyAvailability()` returns `{ available: false, reason: 'no-encryption' }`.

The new private field is `#mode: VaultMode | undefined`. It is set before every `#install(dek)` call and by `setPassword` and `removePassword`. `reset()` clears it to `undefined`.

#### Idle lock in device mode

`touch()` and `setIdleLockMs()` never arm the idle timer while `#mode === 'device'`. `setIdleLockMs` still validates and stores the value. `lock()` keeps working in device mode, because `before-quit` in `packages/app/src/main/index.ts:480` uses it to zero the key.

#### Status

`status(): VaultStatus` behaves as follows:

- When the file is missing, it returns `{ state: 'uninitialised' }`.
- Otherwise it reads the file with `readKeyringFile` inside try/catch. A malformed file counts as mode `'password'`, so the user still reaches the unlock screen and its "Reset store" button, as today.
- It returns `{ state: dek ? 'unlocked' : 'locked', mode }`.

#### Methods

All messages are exact.

- `initialise(password)` is unchanged, except that it sets `#mode = 'password'`.
- `async unlock(password)`: when the keyring is version 2, it throws `VALIDATION` "The vault uses machine encryption and has no master password." Otherwise it behaves as today and sets `#mode = 'password'`.
- `async changePassword(current, next)`: same device-mode guard and message as `unlock`. Otherwise unchanged.
- `deviceKeyAvailability(): DeviceKeyAvailability` returns `this.#deviceKey?.availability()` or the fallback above.
- `initialiseDevice(): void`
  1. When the file exists, it throws `VALIDATION` "The vault is already initialised."
  2. When availability is not `available: true`, it throws `VALIDATION` "Machine encryption is not available on this system."
  3. It creates the DEK with `randomBytes(32)`.
  4. It writes `{ version: 2, mode: 'device', wrappedDek: provider.encrypt(dek).toString('base64') }` after the same `mkdirSync` as `initialise`.
  5. It sets `#mode = 'device'`, calls `#install(dek)` and calls `onUnlocked`.
- `unlockDevice(): void`
  1. It reads the keyring with `#requireKeyring()`.
  2. A version 1 keyring throws `VALIDATION` "The vault uses a master password."
  3. With no provider, it throws `INTERNAL` "This machine could not open the vault key."
  4. It calls `provider.decrypt(Buffer.from(wrappedDek, 'base64'))` inside try/catch. Any throw, or a result whose length is not 32, throws the same `INTERNAL` message. A wrong-length result is zeroed first. The cause is not attached.
  5. It sets `#mode = 'device'`, calls `#install(dek)` and calls `onUnlocked`.
- `setPassword(next: string): void` switches device to password.
  1. It calls `assertPasswordLength(next)`.
  2. A version 1 keyring throws `VALIDATION` "The vault uses a master password."
  3. When `#dek` is undefined, it throws `VAULT_LOCKED` "The vault is locked."
  4. It writes `this.#wrap(next, randomBytes(SALT_BYTES), this.#dek)`, which is version 1.
  5. It sets `#mode = 'password'` and calls `touch()` so the idle timer arms.

  It must not `fill(0)` the live `#dek`. This is the one place where copying `changePassword` would be wrong.

- `async removePassword(current: string): Promise<void>` switches password to device.
  1. A version 2 keyring throws the `unlock` device-mode message.
  2. When availability is not available, it throws `VALIDATION` "Machine encryption is not available on this system."
  3. It unwraps with `#unwrap(keyring, current)`. A wrong password waits the failure delay and throws `VAULT_BAD_PASSWORD`, as `changePassword` does.
  4. It writes the version 2 keyring from `provider.encrypt(dek)` and zeroes the unwrapped copy in `finally`.
  5. It sets `#mode = 'device'` and clears the idle timer (`clearTimeout`, set it to undefined).

No new error code is added. The UI does not branch on the code of a device unlock failure.

### S3. Core schemas and contract

In `packages/core/src/schemas/vault.ts`:

```ts
export const VaultModeSchema = z.enum(['password', 'device']);
export const VaultStatusSchema = z.object({
  state: z.enum(['uninitialised', 'locked', 'unlocked']),
  mode: VaultModeSchema.optional(), // present whenever state is not 'uninitialised'
});
export const DeviceKeyAvailabilitySchema = z.object({
  available: z.boolean(),
  reason: z.enum(['no-encryption', 'basic-text', 'unknown-backend']).optional(),
});
```

In `packages/core/src/domain/vault.ts`, add `export type VaultMode = z.infer<typeof VaultModeSchema>;` and `export type DeviceKeyAvailability = z.infer<typeof DeviceKeyAvailabilitySchema>;` next to `VaultStatus` (line 4).

In `packages/core/src/rpc/contract.ts`, add these entries to the `vault` group after `changePassword` (line 315). They reuse the existing `password` and `newPassword` field schemas.

```ts
initialiseDevice: defineCall(z.void(), z.void()),
unlockDevice: defineCall(z.void(), z.void()),
deviceKeyAvailability: defineCall(z.void(), DeviceKeyAvailabilitySchema),
setPassword: defineCall(z.object({ password: newPassword }), z.void()),
removePassword: defineCall(z.object({ current: password }), z.void()),
```

In `e2e/coverage-map.ts`, add one line per new call after line 11, each with `{ excluded: 'Electron layer: vault machine encryption' }`.

### S4. App provider (`packages/app/src/main/device-key.ts`, new)

```ts
type SafeStorageLike = Pick<
  Electron.SafeStorage,
  'isEncryptionAvailable' | 'getSelectedStorageBackend' | 'encryptString' | 'decryptString'
>;
export function createSafeStorageDeviceKey(
  safeStorage: SafeStorageLike,
  platform: NodeJS.Platform,
): DeviceKeyProvider;
```

`availability()` works as follows:

1. It calls `isEncryptionAvailable()` first. On Linux, that call also selects the backend. When it returns false, the result is `{ available: false, reason: 'no-encryption' }`.
2. On `platform === 'linux'` only, it calls `getSelectedStorageBackend()`. `'basic_text'` gives `reason: 'basic-text'` and `'unknown'` gives `reason: 'unknown-backend'`. Any other backend counts as available.
3. Otherwise the result is `{ available: true }`.

`encrypt(dek)` returns `safeStorage.encryptString(dek.toString('base64'))`. `decrypt(wrapped)` returns `Buffer.from(safeStorage.decryptString(wrapped), 'base64')`. The intermediate JS string cannot be zeroed, which is accepted (see Risks).

The T4a implementer checks `node_modules/electron/electron.d.ts` for the `SafeStorage` member names and the literal union that `getSelectedStorageBackend` returns. If the names differ, it reports and stops.

`AppServicesOptions` gains `readonly deviceKey?: DeviceKeyProvider;`, which is passed into `vaultOptions` (`app-services.ts:126-141`) the same way `failureDelayMs` is.

`index.ts` imports `safeStorage` from `electron` and passes `deviceKey: createSafeStorageDeviceKey(safeStorage, process.platform)` in the `createAppServices({...})` call (line 391). That call already runs inside `app.whenReady()` (line 388), and the provider only touches `safeStorage` lazily on first use, so both conditions for safe use after ready hold. Startup auto-unlock is not done in `index.ts` (see S6).

### S5. App RPC handlers (`packages/app/src/main/rpc/vault.ts`)

Inside `vaultOperations`, extract two local functions. `afterUnlock()` holds today's unlock tail at lines 76-80: `applyStoredIdleLock`, docker `pruneMissing(deps.emit)`, `autoConnect`, `resume`, and `updates.refreshSchedule`. `afterInitialise()` holds lines 72-73: `applyStoredIdleLock` and `refreshSchedule`. The existing entries call them. The new entries are:

- `vault.initialiseDevice` calls `deps.vault.initialiseDevice()` and then `afterInitialise()`.
- `vault.unlockDevice` calls `deps.vault.unlockDevice()` and then `afterUnlock()`.
- `vault.deviceKeyAvailability` calls `deps.vault.deviceKeyAvailability()`.
- `vault.setPassword` calls `deps.vault.setPassword(input.password)` and then `applyStoredIdleLock()`, so the stored timeout arms.
- `vault.removePassword` calls `await deps.vault.removePassword(input.current)`.

`VaultDeps` does not change, because the provider lives inside `Vault`.

### S6. UI store and mock

#### Store (`packages/ui/src/state/app-store.ts`)

- New state is `vaultMode: VaultMode | undefined`. It is undefined while loading or uninitialised.
- `refreshVault` reads `{ state, mode }` and sets both. Locked device mode only sets `vault: 'locked'`. The device unlock screen calls the unlock.
- Add one local helper, `afterOpen(mode: VaultMode)`. It sets `{ vault: 'unlocked', vaultMode: mode, lockReason: undefined }`, calls `void get().loadSettings()` and awaits `get().loadConnections()`. `initialise` (mode `password`), `unlock` (mode `password`) and the new actions use it, so the bodies are not duplicated.
- New actions:

```ts
initialiseDevice(): Promise<void>;
unlockDevice(): Promise<void>;
setPassword(password: string): Promise<void>;
removePassword(current: string): Promise<void>;
deviceKeyAvailability(): Promise<DeviceKeyAvailability>;
```

- `initialiseDevice` and `unlockDevice` call the RPC and then `afterOpen('device')`.
- `setPassword` calls the RPC and sets `vaultMode: 'password'`.
- `removePassword` calls the RPC and sets `vaultMode: 'device'`.
- `deviceKeyAvailability` returns the RPC result and stores nothing.
- `reset` leaves `vaultMode` to `refreshVault`.

#### Mock (`packages/ui/src/api/mock-rpc-client.ts`)

- `MockState` gains `vaultMode: VaultMode | undefined`, `deviceKey: DeviceKeyAvailability` and `deviceUnlockFails: boolean`.
- `MockPreset` becomes `'fresh' | 'unlocked' | 'device' | 'device-locked'`. `device` is unlocked with `vaultMode: 'device'` and `password: undefined`. `device-locked` is the same but locked. `unlocked` gets `vaultMode: 'password'`.
- Two new mock options:
  - `deviceKey?: 'available' | 'no-encryption' | 'basic-text' | 'unknown-backend'` (default `available`). It maps to `{ available: true }` or to `{ available: false, reason }`.
  - `deviceUnlock?: 'ok' | 'fail'` (default `ok`).
- Handlers mirror S2, with the same guard messages.
  - `status` returns `mode` when the vault is initialised.
  - When `deviceUnlockFails` is set, `unlockDevice` throws `fail('INTERNAL', 'This machine could not open the vault key.')`.
  - `reset` sets `vaultMode` to undefined.

#### URL parameters (`packages/ui/src/browser-main.tsx`, lines 13 and 27)

- `?preset=` accepts `unlocked`, `device` and `device-locked`. Anything else means `fresh`.
- `?devicekey=` accepts the four `deviceKey` values.
- `?deviceunlock=fail` sets `deviceUnlock` to `fail`.

#### Link constant (`packages/ui/src/settings/links.ts`)

`export const KEYRING_HELP_URL = \`${PROJECT_URL}/blob/main/docs/keyring-setup.md\`;`is a placeholder until the wiki URL is decided.`app.openExternal` only accepts project pages on github.com (`isProjectLink`, `packages/core/src/rpc/contract.ts:284`), so the final URL must also be on `github.com/eriksimonic/mongodb-gui`, for example `/wiki/Keyring-setup`.

### S7. UI copy and behaviour

#### Device key notice (`packages/ui/src/screens/DeviceKeyNotice.tsx`, new)

The component takes `{ availability: DeviceKeyAvailability; onCheckAgain: () => void; checking: boolean; checkedOnce: boolean }`. The first-run screen and the remove-password modal both use it. It renders the reason text, an anchor "How to set up a keyring" that calls `rpc.app.openExternal({ url: KEYRING_HELP_URL })` through `runReported` (as in `SettingsModal.tsx:556`), and a button "Check again".

| Reason            | Text                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `basic-text`      | No keyring is running, so Linux would keep the key in plain text. Set up GNOME Keyring or KWallet, then restart the app.  |
| `unknown-backend` | The app could not tell which keyring this Linux desktop uses. Set up GNOME Keyring or KWallet, then restart the app.      |
| `no-encryption`   | This system offers no key storage for your user account. On Linux, set up GNOME Keyring or KWallet, then restart the app. |

After a check that still reports unavailable (`checkedOnce`), the notice adds: "Still not available. Linux picks the keyring when the app starts, so restart the app after you set one up."

#### First-run screen (`FirstRunScreen.tsx`)

Step 1 is the choice. On mount it calls `deviceKeyAvailability()`. The heading is "Choose how to protect your data", and the intro is "Mongo GUI encrypts your saved connections, passwords and history. Choose what protects the key." Two radio cards follow, with nothing selected (`Radio.Group` value starts `undefined`).

The first card is "Machine encryption". Its description is "Your operating system protects the key for your user account on this computer. The app opens without a password." Its warning text is "The data opens only for this user on this computer. If you reinstall the system, lose your user profile or copy the data folder elsewhere, the data cannot be opened and the only way out is a reset. Use connection export files to move connections to another computer." The checkbox, required for this option, is "I understand that this data cannot be moved or recovered."

When the device key is unavailable, the card is disabled and shows `DeviceKeyNotice`. The Linux case is the main one.

The second card is "Password encryption". Its description is "A master password protects the key. You type it when the app starts and after the idle lock. The data folder can be moved to another computer."

The primary button "Continue" is disabled until a choice is made, and, for machine encryption, until the checkbox is ticked. With machine encryption, Continue calls `initialiseDevice()`, and errors show in the existing failure `Alert`. With password encryption, Continue shows step 2.

Step 2 is today's form, unchanged, with heading "Create master password", labels "Master password" and "Confirm master password", and button "Create vault". A "Back" button returns to step 1.

#### Device unlock screen (`packages/ui/src/screens/DeviceUnlockScreen.tsx`, new)

`App.tsx` `VaultScreen` renders it when `vault === 'locked' && vaultMode === 'device'`.

On mount, it calls `unlockDevice()` once and shows `<Loader aria-label="Opening the vault" />`. On failure it shows the title "The vault cannot be opened on this computer" and the body "Machine encryption ties the key to this user account on this computer. The key could not be read, for example because the data folder came from another computer or user, or the keyring was reset. Without the key the saved data cannot be recovered." The error message follows in dimmed text.

The buttons are "Try again", which calls `unlockDevice()` again, and "Reset store", which opens the existing `ResetStoreModal` as `UnlockScreen.tsx:20,68,77` does.

#### Settings, Security section (`SettingsModal.tsx:290-320`)

Password mode keeps all of today's rows and adds the row "Remove master password". Its description is "Switch to machine encryption. The app then opens without a password, on this computer only." Its button "Remove master password" opens `RemovePasswordModal`.

Device mode hides "Idle lock (minutes)", "Master password" (the change row) and "Lock" (Lock now). It shows the row "Master password" with the description "None. Machine encryption protects the vault on this computer." and the button "Set master password", which opens `SetPasswordModal`.

#### Set password modal (`packages/ui/src/settings/SetPasswordModal.tsx`, new)

The title is "Set master password", and the text is "The app will ask for this password when it starts and after the idle lock. The data folder can then be moved to another computer." The fields are "New master password" and "Confirm new password", with `PasswordStrengthMeter` and `validateNewPassword` from `screens/password-rules.ts`. The buttons are "Cancel" and "Set password", which calls the store's `setPassword`. Server errors show as `ChangePasswordModal` shows them.

On success, the notification title is "Master password set" and the message is "The app asks for it from the next start."

#### Remove password modal (`packages/ui/src/settings/RemovePasswordModal.tsx`, new)

The title is "Remove master password". The modal shows the S7 machine warning text, the field "Current master password", and the checkbox "I understand that this data cannot be moved or recovered." The buttons are "Cancel" and "Remove password", which calls the store's `removePassword` and stays disabled until the checkbox is ticked.

On open, the modal calls `deviceKeyAvailability()`. When the key is unavailable, it shows `DeviceKeyNotice` and keeps "Remove password" disabled.

On success, the notification title is "Master password removed" and the message is "The app opens without a password on this computer."

#### Shell (`ShellScreen.tsx`)

When `vaultMode === 'device'`, the Lock `ActionIcon` (lines ~832-842) is not rendered, and the `lock` hotkey handler (line 669) is `() => undefined`.

## Pattern to copy

- For Vault methods and tests, follow `changePassword` in `packages/storage/src/vault/vault.ts:110-119` and its tests in `packages/storage/src/vault/vault.test.ts:179-222`, which use `FAST_KDF`, `newDir`, `newVault(dir, options)` and `expectCode`. Idle tests use the fake clock in the same file. For keyring tests, use the `validKeyring` fixture and `caughtInternal` in `packages/storage/src/vault/keyring.test.ts`.
- For RPC entries, follow `entry('vault.changePassword', ...)` in `packages/app/src/main/rpc/vault.ts:86-88`. Router tests go in `describe('vault calls')` at `packages/app/src/main/rpc/router.test.ts:194`. The harness is at 116-130.
- For injecting an Electron API into `createAppServices`, follow `updates: { autoUpdater, platform: process.platform, ... }` in `packages/app/src/main/index.ts:395-400`.
- For mock handlers, follow `changePassword` in `packages/ui/src/api/mock-rpc-client.ts:930-936`. Presets are in `initialState` at 168-199.
- For modals, follow `packages/ui/src/settings/ChangePasswordModal.tsx`, which already has form state, errors after the first submit, the busy state and server error text, and its test `ChangePasswordModal.test.tsx`. The settings wiring follows `SettingsModal.tsx:298-320`.
- For screen tests, follow `packages/ui/src/screens/FirstRunScreen.test.tsx`, which uses `renderApp({ mock: { preset: 'fresh' } })`, and `UnlockScreen.test.tsx`.
- For contract tests, follow `packages/core/src/schemas/vault.test.ts` and `packages/core/src/rpc/contract.test.ts`.

## Roles and models

- The coordinator is Sonnet. It sends each implementer the plan path and a task id, nothing else. It runs the phase checks, writes one status line per task to the status file (`- T2: passed, next T4a`), and commits. It writes no feature code.
- Implementers are Haiku, with under 100k tokens of context each. Each one edits only its listed files and reports in at most 10 lines: the changed files, the acceptance output tail, and any problem with the plan.
- Validators are Opus or Fable and are never the agent that wrote the code. After each phase, a validator reruns every task's acceptance command, reviews the diff against the spec section the task names, and answers pass or fail with the failing output.

## Tasks

T0. Baseline CPD.

- Model: Haiku.
- Edits: `docs/plans/2026-10-27-machine-encryption.cpd-baseline.md` (new).
- Reads: `.claude/skills/` cpd-duplication skill instructions.
- Work: run the cpd-duplication skill on `packages/storage/src`, `packages/core/src`, `packages/app/src` and `packages/ui/src` with the skill's default settings. Write the clusters with files and line ranges.
- Acceptance: `test -s docs/plans/2026-10-27-machine-encryption.cpd-baseline.md && echo ok`.
- Waits for: nothing. It runs before any other task.

T3. Core schemas, contract and coverage map.

- Spec: S3.
- Model: Haiku.
- Edits: `packages/core/src/schemas/vault.ts`, `packages/core/src/domain/vault.ts`, `packages/core/src/rpc/contract.ts`, `packages/core/src/schemas/vault.test.ts`, `e2e/coverage-map.ts`.
- Reads: `packages/core/src/rpc/contract.ts:280-320`, `packages/core/src/index.ts:80-84`, `e2e/coverage-map.ts:1-15`, `tests/coverage-map.test.ts`.
- Tests: the status schema accepts `mode` and accepts its absence, and rejects an unknown mode. Availability accepts each reason and rejects an unknown one.
- Acceptance: `pnpm exec tsc -b packages/core && pnpm exec vitest run --project unit packages/core/src/schemas/vault.test.ts packages/core/src/rpc/contract.test.ts tests/coverage-map.test.ts`.
- Waits for: T0.

T8a. Security and design docs.

- Model: Haiku.
- Edits: `docs/security.md`, `docs/PLAN.md`, `docs/architecture.md`, `docs/troubleshooting.md`.
- Reads: `docs/security.md:25-70` and `:180-200`, `docs/PLAN.md:110-160`, `docs/architecture.md:105-120`, `docs/troubleshooting.md:80-95`, and spec S1, S2 and S7.
- `security.md`: add a section "Machine encryption". It explains the version 2 keyring and that the key is wrapped by DPAPI, Keychain, libsecret or KWallet for the current OS user. The threat model must be stated in these words or close to them: "Machine encryption protects against a copied data folder or a stolen disk image without the user's login. It does not protect against malware or another program running as the same OS user, which can ask the operating system to unwrap the key." It also covers the non-portable data and reset as the only way out, the disabled idle lock in device mode, the Linux `basic_text` refusal, and that switching modes rewrites only `keyring.json`. Update the lines near 37, 61 and 191 that assume a password always exists.
- `PLAN.md`: in 3.2, line ~131 says the minimum is 10 characters, but the code says 4. Correct that line. "Every launch: the app shows the unlock screen" becomes true only for password mode. Rewrite 3.4 (lines ~148-158): keep the reasoning for why the OS keychain is not the only root, say that device mode now exists as a user choice with that trade-off, and drop "can be added later".
- `architecture.md:113`: mention the two keyring versions and the injected device key provider.
- `troubleshooting.md:87-90`: add "The vault cannot be opened on this computer" with the causes and the reset, plus "Machine encryption is disabled on Linux" with a link to `keyring-setup.md`.
- Acceptance: `pnpm exec prettier --check docs/security.md docs/PLAN.md docs/architecture.md docs/troubleshooting.md && grep -q "same OS user" docs/security.md && echo ok`.
- Waits for: T0.

T8b. User docs, keyring page and changelog.

- Model: Haiku.
- Edits: `docs/keyring-setup.md` (new), `docs/user-guide.md`, `README.md`, `CHANGELOG.md`.
- Reads: `docs/user-guide.md:30-70` and `:1005-1012`, `README.md:20-40` and `:150-158`, `CHANGELOG.md:1-20`, and spec S7.
- `keyring-setup.md`: a page the owner can copy to the wiki. It has sections for GNOME Keyring (packages `gnome-keyring` and `libsecret`, starting the daemon, checking with `secret-tool`), KWallet (KDE, `kwallet6` or `kwalletmanager`), and the Electron flag `--password-store=gnome-libsecret|kwallet5|kwallet6` with how to pass it to the AppImage and to the `.desktop` file. It ends by saying the app needs a restart after setup.
- `user-guide.md`: the first-launch section describes the choice, with the S7 strings in quotes. The Security list at ~1010 gets the new rows.
- `README.md`: lines 25-34 and 155 mention both modes.
- `CHANGELOG.md`: insert `## Unreleased` above `## 0.4.4 - 2026-10-27`, following the history in commit `cc61c3c`. Under `### Added`, add a bullet for machine encryption as a first-run choice and a bullet for "Set master password" and "Remove master password" in Settings. Under `### Changed`, add a bullet that the first run asks for a choice. Wrap near 100 columns.
- Acceptance: `pnpm exec prettier --check docs/keyring-setup.md docs/user-guide.md README.md CHANGELOG.md && grep -q "^## Unreleased" CHANGELOG.md && echo ok`.
- Waits for: T0.

T1. Keyring version 2.

- Spec: S1.
- Model: Haiku.
- Edits: `packages/storage/src/vault/keyring.ts`, `packages/storage/src/vault/keyring.test.ts`.
- Reads: `packages/storage/src/vault/keyring.ts:1-120` and the test file.
- Tests:
  - A version 2 file round-trips.
  - Version 2 with `kdf` is rejected (strict).
  - Version 2 without `mode` is rejected.
  - Empty `wrappedDek` and one over 4096 bytes are rejected, and non-canonical base64 is rejected.
  - Version 3 is rejected.
  - The existing version 1 fixtures still pass unchanged.
  - `keyringMode` returns both values.
- Acceptance: `pnpm exec vitest run --project unit packages/storage/src/vault/keyring.test.ts`. The `tsc -b packages/storage` check moves to T2, because `vault.ts` reads `keyring.kdf` until T2 narrows it.
- Waits for: T3.

T5. UI store, mock client and link constant.

- Spec: S6.
- Model: Haiku.
- Edits: `packages/ui/src/state/app-store.ts`, `packages/ui/src/api/mock-rpc-client.ts`, `packages/ui/src/api/mock-rpc-client.test.ts`, `packages/ui/src/browser-main.tsx`, `packages/ui/src/settings/links.ts`.
- Reads: `app-store.ts:75-90`, `:195-265`, `:695-750` and `:1375-1385`, `mock-rpc-client.ts:80-135`, `:160-200` and `:895-945`, `mock-rpc-client.test.ts:60-80`, `browser-main.tsx:1-40`, `links.ts`.
- Tests:
  - Each preset reports the right status and mode.
  - `initialiseDevice` works with available and is rejected with `basic-text`.
  - `unlockDevice` works with ok and fails with fail.
  - `setPassword` and `removePassword` switch the mode.
  - `removePassword` with a wrong password gives `VAULT_BAD_PASSWORD`.
  - The `unlock` guard works in device mode.
- Acceptance: `pnpm exec tsc -b packages/ui && pnpm exec vitest run --project unit packages/ui/src/api/mock-rpc-client.test.ts`.
- Waits for: T3.

T2. Vault device mode.

- Spec: S2.
- Model: Haiku.
- Edits: `packages/storage/src/vault/vault.ts`, `packages/storage/src/vault/vault.test.ts`, `packages/storage/src/index.ts`.
- Reads: `vault.ts:1-290`, `vault.test.ts` (helpers at the top, `:179-222`, the idle tests), `keyring.ts` after T1.
- The tests define one inline fake provider: availability `{ available: true }`, encrypt prefixes a fixed 4-byte marker, and decrypt checks and strips it, throwing otherwise. They also define an unavailable variant.
- Tests:
  - `initialiseDevice` writes version 2, and `status` reports `{ unlocked, device }`.
  - After `lock`, `unlockDevice` restores the same DEK. `withDek` returns the same bytes before and after.
  - `unlockDevice` throws INTERNAL with the exact message when decrypt throws and when it returns 31 bytes.
  - Device mode never locks on idle with the fake clock, and `setIdleLockMs` does not arm the timer.
  - `setPassword` writes version 1, `unlock(next)` works after `lock`, and the idle lock works again. `withDek` still works right after `setPassword`, which proves the live DEK was not zeroed.
  - `setPassword` in password mode is rejected, and `setPassword` while locked gives `VAULT_LOCKED`.
  - `removePassword` with the right password writes version 2, and `unlockDevice` then works.
  - `removePassword` with a wrong password gives `VAULT_BAD_PASSWORD` and leaves the file unchanged.
  - `removePassword` and `initialiseDevice` with the unavailable provider give `VALIDATION`.
  - `unlock` and `changePassword` in device mode give `VALIDATION`.
  - A malformed `keyring.json` gives `status()` `{ locked, password }` and does not throw.
  - A vault without a provider reports `no-encryption`.
- Acceptance: `pnpm exec tsc -b packages/storage && pnpm exec vitest run --project unit packages/storage/src/vault`.
- Waits for: T1, T3.

T6a. First-run choice screen and device key notice.

- Spec: S7, the first-run screen and the notice.
- Model: Haiku.
- Edits: `packages/ui/src/screens/FirstRunScreen.tsx`, `packages/ui/src/screens/FirstRunScreen.test.tsx`, `packages/ui/src/screens/FirstRunScreen.stories.tsx`, `packages/ui/src/screens/DeviceKeyNotice.tsx` (new).
- Reads: `FirstRunScreen.tsx:1-86`, `FirstRunScreen.test.tsx`, `FirstRunScreen.stories.tsx`, `SettingsModal.tsx:550-560`, `links.ts`, `CenteredScreen.tsx`.
- Tests:
  - Nothing is selected at first and Continue is disabled.
  - Machine encryption without the checkbox keeps Continue disabled. With the checkbox, Continue reaches the shell (the mock goes unlocked).
  - Password encryption with Continue shows the existing form. The existing three tests are kept after one choose-and-continue step.
  - With `devicekey: 'basic-text'`, the machine radio is disabled and the reason text, the link and "Check again" are shown.
  - "Check again" while still unavailable shows the restart sentence.
- Stories: add `basic-text`.
- Acceptance: `pnpm exec vitest run --project unit packages/ui/src/screens/FirstRunScreen.test.tsx && pnpm exec eslint packages/ui/src/screens/FirstRunScreen.tsx packages/ui/src/screens/DeviceKeyNotice.tsx`.
- Waits for: T5.

T6b. Device unlock screen.

- Spec: S7, the device unlock screen.
- Model: Haiku.
- Edits: `packages/ui/src/screens/DeviceUnlockScreen.tsx` (new), `packages/ui/src/screens/DeviceUnlockScreen.test.tsx` (new), `packages/ui/src/App.tsx`.
- Reads: `App.tsx:1-50`, `UnlockScreen.tsx:1-80`, `ResetStoreModal.tsx`, `UnlockScreen.test.tsx` (the setup helpers).
- Tests:
  - `preset: 'device-locked'` reaches the shell without a password field.
  - With `deviceUnlock: 'fail'`, the screen shows the title, "Try again" and "Reset store", and "Reset store" opens the modal.
  - `preset: 'unlocked'`, after a lock, still shows the password unlock screen.
- Acceptance: `pnpm exec vitest run --project unit packages/ui/src/screens/DeviceUnlockScreen.test.tsx packages/ui/src/screens/UnlockScreen.test.tsx`.
- Waits for: T5.

T4a. Safe storage provider and service wiring.

- Spec: S4.
- Model: Haiku.
- Edits: `packages/app/src/main/device-key.ts` (new), `packages/app/src/main/device-key.test.ts` (new), `packages/app/src/main/rpc/app-services.ts`, `packages/app/src/main/index.ts`.
- Reads: `app-services.ts:60-145`, `index.ts:1-40` and `:385-400`, the `SafeStorage` section of `node_modules/electron/electron.d.ts`.
- Tests use a plain object fake for `safeStorage`:
  - On win32, available.
  - On win32 with `isEncryptionAvailable` false, `no-encryption`.
  - On linux, `basic_text` gives `basic-text` and `unknown` gives `unknown-backend`, and `gnome_libsecret` is available.
  - `getSelectedStorageBackend` is not called on darwin or win32.
  - encrypt then decrypt round-trips 32 bytes.
- Acceptance: `pnpm exec tsc -b packages/app && pnpm exec vitest run --project unit packages/app/src/main/device-key.test.ts`.
- Waits for: T2.

T7a. Set and remove password modals.

- Spec: S7, the two modals.
- Model: Haiku.
- Edits: `packages/ui/src/settings/SetPasswordModal.tsx` (new), `packages/ui/src/settings/RemovePasswordModal.tsx` (new), `packages/ui/src/settings/MasterPasswordModals.test.tsx` (new).
- Reads: `ChangePasswordModal.tsx:1-113`, `ChangePasswordModal.test.tsx`, `change-password.ts`, `screens/password-rules.ts`, `screens/DeviceKeyNotice.tsx`.
- Tests:
  - Set with short or mismatched passwords shows the errors. A valid set calls `onDone`, and the store mode becomes `password`.
  - Remove with a wrong password shows the server message. Remove without the checkbox keeps the button disabled. A valid remove calls `onDone` and the mode becomes `device`.
  - Remove with `devicekey: 'basic-text'` shows the notice with the button disabled.
- Both modals take `{ opened, onClose, onDone }`, like `ChangePasswordModal`, and call the store actions from T5.
- Acceptance: `pnpm exec vitest run --project unit packages/ui/src/settings/MasterPasswordModals.test.tsx packages/ui/src/settings/ChangePasswordModal.test.tsx`.
- Waits for: T5, T6a.

T4b. Vault RPC handlers.

- Spec: S5.
- Model: Haiku.
- Edits: `packages/app/src/main/rpc/vault.ts`, `packages/app/src/main/rpc/router.test.ts`.
- Reads: `vault.ts:1-91`, `router.test.ts:100-140`, `:194-260` and `:318-332`.
- The harness Vault at 119-127 gets `deviceKey` with an inline marker fake, like the one in T2.
- Tests in `describe('vault calls')`:
  - `initialiseDevice`, `status` (expect the device mode), `lock`, then `unlockDevice` gives ok.
  - `deviceKeyAvailability` gives `{ available: true }`.
  - From password mode, `removePassword` with the right password gives ok and the status mode becomes `device`. `setPassword` gives ok and the mode becomes `password`, and `unlock` with the new password works after `lock`.
  - `unlock` in device mode gives `VALIDATION`.
- If the "answers every contract method" loop now initialises the harness vault and a later assertion in that test breaks, the implementer reports and stops.
- Acceptance: `pnpm exec vitest run --project unit packages/app/src/main/rpc/router.test.ts`.
- Waits for: T4a.

T7b. Settings and shell wiring for device mode.

- Spec: S7, the settings and shell parts.
- Model: Haiku.
- Edits: `packages/ui/src/settings/SettingsModal.tsx`, `packages/ui/src/screens/ShellScreen.tsx`, `packages/ui/src/settings/SettingsSections.test.tsx`, `packages/ui/src/screens/ShellScreen.lock.test.tsx` (new).
- Reads: `SettingsModal.tsx:280-330`, `ShellScreen.tsx:525-540`, `:660-672` and `:828-845`, `SettingsSections.test.tsx:80-110`.
- The modals from T7a show their own success notifications, so `onDone` in `SettingsModal` only closes the modal. It must not show a second notification.
- Tests:
  - With `preset: 'unlocked'`, the security section shows "Change master password", "Remove master password", "Lock now" and the idle field.
  - With `preset: 'device'`, the security section shows "Set master password" and none of the other four.
  - The shell has a Lock button with `unlocked` and none with `device`.
- Acceptance: `pnpm exec vitest run --project unit packages/ui/src/settings/SettingsSections.test.tsx packages/ui/src/screens/ShellScreen.lock.test.tsx`.
- Waits for: T7a.

VF. Full gate.

- Model: Opus validator, not an implementer.
- Edits: nothing.
- Work: run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm format:check`. Compare the results with the baseline: 0 lint errors and no more than 12 warnings, 0 test failures, typecheck clean. Check `git status --porcelain` against the file lists in this plan, and check that `docs/screenshots` is unchanged. Grep the new code for `fill(0)` on `#dek` inside `setPassword`.
- Acceptance: `pnpm check`.
- Waits for: T4b, T6b, T7b, T8a, T8b.

T9. Manual check in the mock UI.

- Model: Haiku. This task uses the serial port 5174.
- Edits: images only, `e2e/output/machine-encryption-*.png`. The Playwright script lives in a scratch folder outside the repo.
- Reads: `.claude/skills/run-app/SKILL.md`, the "Browser mock UI" and Playwright sections.
- Windows adaptation: start `pnpm dev:ui` in the background, and wait until `http://localhost:5174/` answers. Stop the server with PowerShell `Get-NetTCPConnection -LocalPort 5174 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Confirm:$false }` instead of `fuser`.
- Work: take a screenshot at 1536x1024 of each state:
  1. `?preset=fresh` (choice, nothing selected)
  2. `?preset=fresh` with machine selected and the checkbox shown
  3. `?preset=fresh&devicekey=basic-text`
  4. `?preset=fresh` with password selected and Continue clicked (form)
  5. `?preset=device`, Settings, Security
  6. `?preset=unlocked`, Settings, Security
  7. The remove password modal
  8. The set password modal
  9. `?preset=device-locked&deviceunlock=fail`

  Name the files `machine-encryption-01-choice.png` through `-09-unlock-failed.png`.

- Acceptance: `ls e2e/output/machine-encryption-0*.png | wc -l` prints 9. An Opus validator then opens each image and checks it against the S7 copy.
- Waits for: VF.

T10. Finishing CPD scan.

- Model: Opus validator.
- Edits: nothing in the repo. The result goes to the coordinator, who appends it to the status file.
- Work: after VF and T9 pass, run the cpd-duplication skill on the same four package folders with the same settings as T0. Compare the result with `docs/plans/2026-10-27-machine-encryption.cpd-baseline.md`. Report each new or grown cluster with its files, line ranges and a proposed fix. Do not refactor. Likely candidates are the inline fake providers in `vault.test.ts` and `router.test.ts`, the device keyring write in `initialiseDevice` and `removePassword`, `SetPasswordModal` against `ChangePasswordModal`, and the warning text in `FirstRunScreen` and `RemovePasswordModal`.
- Acceptance: the report lists either "no new or grown clusters" or each cluster with files and ranges.
- Waits for: T9.

## Phases

| Phase | Tasks run together | Notes                                      |
| ----- | ------------------ | ------------------------------------------ |
| 0     | T0                 | Alone, before any change.                  |
| 1     | T3, T8a, T8b       | The docs are written from the spec.        |
| 2     | T1, T5             | Root typecheck turns green again after T5. |
| 3     | T2, T6a, T6b       | No shared files.                           |
| 4     | T4a, T7a           |                                            |
| 5     | T4b, T7b           | The router test turns green after T4b.     |
| 6     | VF                 |                                            |
| 7     | T9                 | Serial: port 5174.                         |
| 8     | T10                |                                            |

An Opus phase validator runs after each of phases 1 to 5, before the next phase starts.

## Serial resources

- The browser mock UI on port 5174 is used only by T9 and its validator, one at a time. No other task starts `pnpm dev:ui`.
- Only the coordinator touches the git index.
- Vitest runs may run in parallel.
- Run one Electron or Playwright session at a time, as the run-app skill warns.

## Finishing validation

T10 is the finishing validation. It runs only after VF and T9 have passed. It uses the cpd-duplication skill on the changed packages (storage, core, app, ui) and compares the result with the T0 baseline. It reports new or grown duplicate clusters with files, line ranges and a proposed fix, and changes no code. The coordinator passes the report to the owner, who decides whether a follow-up is wanted.

## Rework rule

When a validator fails a task, the coordinator sends the task back to the same implementer with the failing output and the spec section it violates. An implementer gets at most two rework rounds. If the task still fails after the second round, the coordinator rewrites the brief. It may split the task or add exact lines to the spec, and it gives the new brief to a fresh implementer. The status file records each round.

## Risks and open decisions

### Open decisions

- The wiki URL for the keyring link is open. `KEYRING_HELP_URL` in `packages/ui/src/settings/links.ts` points at `docs/keyring-setup.md` on GitHub until the owner decides. The URL must stay on `github.com/eriksimonic/mongodb-gui`, because `isProjectLink` (`packages/core/src/rpc/contract.ts:284`) refuses every other host.
- Should the choice screen show when the keyring file exists but has no mode? The plan says no. Version 1 means password mode, so existing users never see the choice screen.
- Device decrypt can fail at startup, for example after a profile move, a copied data folder, a keyring reset, or a Linux backend that changed between runs. The plan shows a recovery screen with "Try again" and "Reset store", and offers no other recovery, because no other key exists. The owner should confirm the wording, and say whether the screen should also mention that a copy of the old `keyring.json` on the original computer still opens the data there.
- Manual lock in device mode is open. The plan hides "Lock now", the shell Lock button and the lock hotkey in device mode, because the app would unlock again at once. The shortcuts help list may still show the lock shortcut, and the owner decides whether it should be hidden too.
- The macOS Keychain may prompt on first use. The first `safeStorage` call creates a "Mongo GUI Safe Storage" Keychain item and can ask for access. The builds use ad-hoc signing (README ~142), and the Keychain ties access to the code signature, so the prompt may come back after every update. If the user denies it, unlock fails and the recovery screen appears. Before release, someone should test this on a Mac with two consecutive builds.
- `safeStorage` needs the app to be ready. That holds here: `createAppServices` is called at `packages/app/src/main/index.ts:391`, inside `app.whenReady()` at 388, and the provider only calls `safeStorage` inside its methods.

### Risks

- An older app version that reads a version 2 keyring reports a malformed file and offers a reset. A user who downgrades after choosing machine encryption could lose data that way. The CHANGELOG bullet or the security doc should say that downgrading needs password mode first.
- The DEK passes through a base64 JS string on its way to and from `safeStorage`, and that string cannot be zeroed. The threat model already excludes same-user malware, so this is accepted. `security.md` should mention it.
- On Linux, Electron fixes the storage backend at startup, so "Check again" rarely changes the answer without a restart. The copy says so.
- On Linux with `basic_text`, `isEncryptionAvailable()` can return true. The provider relies on `getSelectedStorageBackend()` for that case, and T4a must confirm that the method exists in Electron 44 typings.
- The `before-quit` handler calls `vault.lock()` in both modes. The plan keeps `lock()` unchanged, so the key is still zeroed on quit.

### Discrepancies found against the brief

- `createAppServices` is called at `index.ts:391`, not 390.
- `packages/ui/src/security/mock.ts` is the MongoDB user-security mock and has nothing to do with the vault. No task edits it.
- `docs/PLAN.md` 3.2 says the minimum password is 10 characters, but the code (`vault.ts:24`) and `security.md` say 4. Section 3.2 also says every launch shows the unlock screen. T8a fixes both.
- The CHANGELOG has no unreleased heading today. History (commit `cc61c3c`) shows the convention: `## Unreleased` at the top, renamed to the version at release.
- `e2e/coverage-map.ts` must list every new RPC call, or `tests/coverage-map.test.ts` fails. The router test at ~322 requires a handler for every contract call. Both are handled in T3 and T4b.
- `status()` today only checks that the file exists. Reading the mode from the file would make it throw on a malformed file, which would hide the reset path. S2 catches that case.
- Lock entry points also exist in `ShellScreen.tsx` (532, 669, 839), not only in Settings. T7b handles them.
- `docs/user-guide.md` (32-66 and 1010) and `README.md` (25-34 and 155) describe the master password as mandatory. T8b covers them, although the brief did not list them.
- None of the six `docs/screenshots` files shows the first-run or unlock screen.

## Commit policy

- Only the coordinator commits, once per phase that passed its validator, on a branch `feat/machine-encryption` created from `main`.
- Commits follow CONTRIBUTING.md conventional commits, `type(scope): summary`, imperative, lower case, under about 72 characters, with a body that explains why. Examples: `feat(storage): wrap the data key with the os key store`, `feat(core): add vault calls for machine encryption`, `feat(app): unlock the vault with safeStorage`, `feat(ui): offer machine encryption on first run`, `docs: describe machine encryption and its threat model`.
- Commits carry no `Co-Authored-By`, no model or tool names, and no trailers of any kind. The owner's rule overrides any harness attribution reminder. Nobody pushes or opens a PR unless the owner asks.
- After T10, the coordinator reports to the owner and stops. The owner reviews with `//TODO-AI` comments, and no agent edits repo files while that review is open.

### Critical files for implementation

- `C:\_git\mongo-gui\packages\storage\src\vault\vault.ts`
- `C:\_git\mongo-gui\packages\storage\src\vault\keyring.ts`
- `C:\_git\mongo-gui\packages\core\src\rpc\contract.ts`
- `C:\_git\mongo-gui\packages\app\src\main\rpc\vault.ts`
- `C:\_git\mongo-gui\packages\ui\src\state\app-store.ts`
