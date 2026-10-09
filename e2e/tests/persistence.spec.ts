import { expect, test } from '@playwright/test';
import {
  closeWindowAndWaitForExit,
  createUserDataDir,
  expectCleanLogs,
  forceClose,
  launchApp,
  removeUserDataDir,
  type AppSession,
} from '../support/app';
import { captureStep } from '../support/screenshots';

const SPEC = 'persistence';
const MASTER_PASSWORD = 'correct horse battery staple';

test('a relaunch on the same profile asks for the master password', async () => {
  const userDataDir = await createUserDataDir();
  let session: AppSession | undefined;
  try {
    await test.step('create the vault and quit', async () => {
      session = await launchApp(userDataDir);
      const window = session.window;
      await window.getByLabel('Master password', { exact: true }).fill(MASTER_PASSWORD);
      await window.getByLabel('Confirm master password', { exact: true }).fill(MASTER_PASSWORD);
      await window.getByRole('button', { name: 'Create vault' }).click();
      await expect(window.getByRole('button', { name: 'Lock', exact: true })).toBeVisible();
      const exitCode = await closeWindowAndWaitForExit(session);
      expect(exitCode).toBe(0);
      expectCleanLogs(session);
    });

    await test.step('relaunch shows the unlock screen, not first run', async () => {
      session = await launchApp(userDataDir);
      const window = session.window;
      await expect(window.getByRole('heading', { name: 'Unlock Mongo GUI' })).toBeVisible();
      await expect(window.getByRole('heading', { name: 'Create master password' })).toBeHidden();
      await captureStep(window, SPEC, '01-unlock-after-relaunch');
      const exitCode = await closeWindowAndWaitForExit(session);
      expect(exitCode).toBe(0);
      expectCleanLogs(session);
    });
  } finally {
    if (session !== undefined) {
      await forceClose(session);
    }
    await removeUserDataDir(userDataDir);
  }
});
