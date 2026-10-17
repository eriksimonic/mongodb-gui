import { MongoClient } from 'mongodb';
import type { Page } from '@playwright/test';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';
import { connectionOption, openConnectionManager } from '../../connection-manager';

// Port 1 has no server behind it, so the connection is refused. The side-channel client reads the 1 s timeout from the URI.
// The app dialog uses the profile connect timeout (10 s by default), so that test takes about 12 s.
const UNREACHABLE_URI = 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=1000';

/** The version the server reports, read through a second client so the UI is not the only source. */
async function serverVersion(): Promise<string> {
  const client = new MongoClient(mongoUriFromEnv());
  try {
    const info = await client.db('admin').command({ buildInfo: 1 });
    return String(info['version']);
  } finally {
    await client.close();
  }
}

/** Opens the New connection dialog from the Connections manager. The manager stays open behind it. */
async function openNewConnectionDialog(page: Page) {
  const manager = await openConnectionManager(page);
  await manager.getByRole('button', { name: 'New connection', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New connection', exact: true });
  // Saving needs a name. Testing needs one too, so the draft always has it.
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Probe');
  return dialog;
}

test('test connection in the dialog reports the server version and saves nothing', async ({
  page,
  wiring,
}) => {
  const version = await serverVersion();

  await page.goto(wiring.url);
  const dialog = await openNewConnectionDialog(page);
  await dialog
    .getByRole('textbox', { name: 'Connection URI', exact: true })
    .fill(mongoUriFromEnv());
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();

  // The status line shows the version the app read from the server.
  await expect(dialog.getByRole('status')).toHaveText(
    new RegExp(`^Connected in \\d+ ms\\. Server ${version.replaceAll('.', '\\.')}, standalone\\.$`),
  );

  // Cancel closes the dialog without saving. The tree keeps Local dev and gets no Probe.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  // Reload so the tree reads the saved list from the router again.
  await page.reload();
  await expect(page.getByRole('treeitem', { name: 'Local dev', exact: true })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'Probe', exact: true })).toHaveCount(0);
});

test('test connection in the dialog fails for an unreachable server', async ({ page, wiring }) => {
  // The bad URI must fail on its own. The real server must still answer, so the failure is the URI.
  const unreachable = new MongoClient(UNREACHABLE_URI);
  const reachable = new MongoClient(mongoUriFromEnv());
  try {
    await expect(unreachable.db('admin').command({ ping: 1 })).rejects.toThrow();
    const ping = await reachable.db('admin').command({ ping: 1 });
    expect(ping['ok']).toBe(1);
  } finally {
    await unreachable.close();
    await reachable.close();
  }

  await page.goto(wiring.url);
  const dialog = await openNewConnectionDialog(page);
  await dialog.getByRole('textbox', { name: 'Connection URI', exact: true }).fill(UNREACHABLE_URI);
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();

  // The message names the refused port, so the failure is the bad address and not a generic error.
  await expect(dialog.getByRole('alert')).toHaveText(
    'Could not connect to the server (connect ECONNREFUSED 127.0.0.1:1)',
  );
});

test('test from the connection manager: Local dev answers with its version', async ({
  page,
  wiring,
}) => {
  const version = await serverVersion();

  await page.goto(wiring.url);
  const manager = await openConnectionManager(page);
  await connectionOption(manager, 'Local dev').click();
  await manager.getByRole('button', { name: 'Test', exact: true }).click();

  // The notification names the connection and the version from the server.
  await expect(page.getByText('Connection works', { exact: true })).toBeVisible();
  await expect(
    page.getByText(`Local dev answered. MongoDB ${version}.`, { exact: true }),
  ).toBeVisible();
});
