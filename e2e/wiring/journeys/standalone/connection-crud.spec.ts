import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';
import { connectionOption, openConnectionManager } from '../../connection-manager';

/** Database names from the server, read through a second client and not the UI. */
async function serverDatabaseNames(): Promise<string[]> {
  const client = new MongoClient(mongoUriFromEnv());
  try {
    const { databases } = await client.db('admin').admin().listDatabases();
    return databases.map((database) => database.name);
  } finally {
    await client.close();
  }
}

test('create a saved connection, see it after reload, and connect to it', async ({
  page,
  wiring,
}) => {
  const uri = mongoUriFromEnv();
  const databaseNames = await serverDatabaseNames();
  expect(databaseNames).toContain('shop');

  await page.goto(wiring.url);
  // New connections are added from the Connections dialog, which the header button opens.
  const manager = await openConnectionManager(page);
  await manager.getByRole('button', { name: 'New connection', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'New connection', exact: true });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Staging');
  await dialog.getByRole('textbox', { name: 'Connection string', exact: true }).fill(uri);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(connectionOption(manager, 'Staging')).toBeVisible();
  await manager.getByRole('button', { name: 'Close', exact: true }).click();

  const tree = page.getByRole('treeitem', { name: 'Staging', exact: true });
  await expect(tree).toBeVisible();

  // A reload reads the saved list from the router, so the entry must survive it.
  await page.reload();
  await expect(tree).toBeVisible();

  await tree.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  for (const name of databaseNames) {
    await expect(page.getByRole('treeitem', { name, exact: true })).toBeVisible();
  }
});

test('rename a saved connection and keep the new name after reload', async ({ page, wiring }) => {
  const databaseNames = await serverDatabaseNames();
  expect(databaseNames).toContain('shop');

  await page.goto(wiring.url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Edit connection', exact: true });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Renamed dev');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  const renamed = page.getByRole('treeitem', { name: 'Renamed dev', exact: true });
  const oldName = page.getByRole('treeitem', { name: 'Local dev', exact: true });
  await expect(renamed).toBeVisible();
  await expect(oldName).toHaveCount(0);

  await page.reload();
  await expect(renamed).toBeVisible();
  await expect(oldName).toHaveCount(0);

  // Connecting under the new name proves the saved URI still points at the server.
  await renamed.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  for (const name of databaseNames) {
    await expect(page.getByRole('treeitem', { name, exact: true })).toBeVisible();
  }
});

test('delete a saved connection, keep it deleted after reload, and leave the server alone', async ({
  page,
  wiring,
}) => {
  await page.goto(wiring.url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();

  const confirm = page.getByRole('dialog', { name: 'Remove connection', exact: true });
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(confirm).toBeHidden();

  const removed = page.getByRole('treeitem', { name: 'Local dev', exact: true });
  await expect(removed).toHaveCount(0);
  await page.reload();
  await expect(removed).toHaveCount(0);
  // The other saved connection stays, so the delete removed only the one entry.
  await expect(page.getByRole('treeitem', { name: 'Secured dev', exact: true })).toBeVisible();

  // Deleting a saved connection must not touch data on the server.
  const databaseNames = await serverDatabaseNames();
  expect(databaseNames).toContain('shop');
});

test('connections dialog lists each saved connection with its host', async ({ page, wiring }) => {
  // The host is read from the same URI the server uses, so the dialog is checked against the server.
  // MongoClient does not connect until it runs a command, so this costs nothing on the network.
  const client = new MongoClient(mongoUriFromEnv());
  let host: string;
  try {
    host = client.options.hosts.map((address) => address.toString()).join(',');
  } finally {
    await client.close();
  }

  await page.goto(wiring.url);
  const manager = await openConnectionManager(page);

  // The Local dev and Secured dev entries both point at the same host.
  for (const name of ['Local dev', 'Secured dev']) {
    const option = connectionOption(manager, name);
    await expect(option).toBeVisible();
    await expect(option).toContainText(host);
  }
});
