import { expect, test, type Page } from '@playwright/test';
import {
  closeWindowAndWaitForExit,
  createUserDataDir,
  expectCleanLogs,
  forceClose,
  launchApp,
  removeUserDataDir,
  type AppSession,
} from '../support/app';
import { mongoUriFromEnv } from '../support/mongo';
import { captureStep } from '../support/screenshots';

const SPEC = 'smoke';
const MASTER_PASSWORD = 'correct horse battery staple';
const WRONG_PASSWORD = 'wrong horse battery staple';
const CONNECTION_NAME = 'E2E Mongo';
const SERVER_VERSION = '8.0.17';

test('master password, connection tree and lock, end to end', async () => {
  const userDataDir = await createUserDataDir();
  let session: AppSession | undefined;
  try {
    session = await launchApp(userDataDir);
    const app = session;
    const window = app.window;

    await test.step('first-run screen is visible', async () => {
      await expect(window.getByRole('heading', { name: 'Create master password' })).toBeVisible();
      await captureStep(window, SPEC, '01-first-run');
    });

    await test.step('set the master password and create the vault', async () => {
      await window.getByLabel('Master password', { exact: true }).fill(MASTER_PASSWORD);
      await window.getByLabel('Confirm master password', { exact: true }).fill(MASTER_PASSWORD);
      await window.getByRole('button', { name: 'Create vault' }).click();
      await expect(window.getByRole('button', { name: 'Lock', exact: true })).toBeVisible();
      await expect(window.getByText('No connections yet.')).toBeVisible();
      await captureStep(window, SPEC, '02-shell-empty');
    });

    await test.step('add a connection by URI and test it', async () => {
      await window.getByRole('button', { name: 'New connection' }).first().click();
      const dialog = window.getByRole('dialog', { name: 'New connection' });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Name', { exact: true }).fill(CONNECTION_NAME);
      await dialog.getByLabel('Connection URI').fill(mongoUriFromEnv());
      await dialog.getByRole('button', { name: 'Test connection' }).click();
      await expect(dialog.getByRole('status')).toContainText(`Connected. Server ${SERVER_VERSION}`);
      await captureStep(window, SPEC, '03-test-connection-ok');
    });

    await test.step('save the connection and see it in the tree', async () => {
      const dialog = window.getByRole('dialog', { name: 'New connection' });
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(connectionItem(window)).toBeVisible();
      await captureStep(window, SPEC, '04-saved-in-tree');
    });

    await test.step('double-click connects', async () => {
      await connectionItem(window).dblclick();
      await expect(window.getByLabel('Connected', { exact: true })).toBeVisible();
      await captureStep(window, SPEC, '05-connected');
    });

    await test.step('expand the connection and the shop database', async () => {
      await treeItem(window, CONNECTION_NAME).focus();
      await window.keyboard.press('ArrowRight');
      await expect(connectionItem(window)).toHaveAttribute('aria-expanded', 'true');
      await expect(treeItem(window, 'shop')).toBeVisible();

      await treeItem(window, 'shop').focus();
      await window.keyboard.press('ArrowRight');
      await expect(treeItem(window, 'shop')).toHaveAttribute('aria-expanded', 'true');
      await expect(treeItem(window, 'orders')).toBeVisible();
      await waitForToastToClear(window);
      await captureStep(window, SPEC, '06-tree-expanded', 'connection-tree.png');
    });

    await test.step('lock returns to the unlock screen', async () => {
      await window.getByRole('button', { name: 'Lock', exact: true }).click();
      await expect(window.getByRole('heading', { name: 'Unlock Mongo GUI' })).toBeVisible();
      await waitForToastToClear(window);
      await captureStep(window, SPEC, '07-locked', 'unlock.png');
    });

    await test.step('a wrong password shows the error', async () => {
      await unlockWith(window, WRONG_PASSWORD);
      await expect(window.getByText('Wrong master password. Try again.')).toBeVisible();
      await expect(window.getByLabel('Master password', { exact: true })).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      await captureStep(window, SPEC, '08-wrong-password');
    });

    await test.step('the right password returns to the shell with the connection listed', async () => {
      await unlockWith(window, MASTER_PASSWORD);
      await expect(window.getByRole('button', { name: 'Lock', exact: true })).toBeVisible();
      await expect(connectionItem(window)).toBeVisible();
      await captureStep(window, SPEC, '09-unlocked');
    });

    await test.step('closing the window quits the app', async () => {
      await captureStep(window, SPEC, '10-before-close');
      const exitCode = await closeWindowAndWaitForExit(app);
      expect(exitCode).toBe(0);
    });

    await test.step('the run wrote no error lines', async () => {
      expectCleanLogs(app);
    });
  } finally {
    if (session !== undefined) {
      await forceClose(session);
    }
    await removeUserDataDir(userDataDir);
  }
});

function treeItem(window: Page, name: string) {
  return window.getByRole('treeitem', { name, exact: true });
}

function connectionItem(window: Page) {
  return treeItem(window, CONNECTION_NAME);
}

/** The "Connection saved" toast hides itself after a few seconds. Docs shots wait for that. */
async function waitForToastToClear(window: Page): Promise<void> {
  await expect(window.getByText('Connection saved')).toBeHidden();
}

async function unlockWith(window: Page, password: string): Promise<void> {
  await window.getByLabel('Master password', { exact: true }).fill(password);
  await window.getByRole('button', { name: 'Unlock', exact: true }).click();
}
