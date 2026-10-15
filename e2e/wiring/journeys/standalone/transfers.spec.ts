import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

const DOCS = [
  { sku: 'A1', qty: 3 },
  { sku: 'B2', qty: 5 },
  { sku: 'C3', qty: 8 },
];

/** Creates a database of my own with an items collection, connects, and opens the export dialog. */
async function openExportDialog(page: Page, url: string, database: string) {
  await page.goto(url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  await page.getByRole('treeitem', { name: database, exact: true }).press('ArrowRight');
  await page.getByRole('treeitem', { name: 'items', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Import and export', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Export data', exact: true }).click();
  return page.getByRole('dialog', { name: 'Export data' });
}

/** Opens the editor of the database, then its Transfers tab. */
async function openTransfersTab(page: Page, database: string): Promise<void> {
  await page.getByRole('treeitem', { name: database, exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open editor', exact: true }).click();
  await page.getByRole('tab', { name: 'Transfers', exact: true }).click();
}

async function seed(database: string): Promise<void> {
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client.db(database).dropDatabase();
    await client.db(database).collection('items').insertMany(DOCS.map((doc) => ({ ...doc })));
  } finally {
    await client.close();
  }
}

async function dropDatabase(database: string): Promise<void> {
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client.db(database).dropDatabase();
  } finally {
    await client.close();
  }
}

test('export a collection to a file, see the file and the transfer in the list', async ({
  page,
  wiring,
}) => {
  const database = `wiring_transfers_${Math.random().toString(36).slice(2, 10)}`;
  const dir = mkdtempSync(join(tmpdir(), 'wiring-transfers-'));
  const filePath = join(dir, 'items.ndjson');
  try {
    await seed(database);
    wiring.setDialogPicks([filePath]);

    const dialog = await openExportDialog(page, wiring.url, database);
    await dialog.getByRole('button', { name: 'Save as', exact: true }).click();
    await expect(dialog.getByLabel('File')).toHaveValue(filePath);
    // Relaxed EJSON writes plain numbers.
    await dialog.getByRole('radiogroup', { name: 'EJSON mode' }).getByText('Relaxed EJSON').click();
    await dialog.getByRole('button', { name: 'Start export', exact: true }).click();

    await expect(dialog.getByText('Export finished', { exact: true })).toBeVisible();
    await expect(
      dialog.getByText(`Exported ${DOCS.length} documents to ${filePath}.`, { exact: true }),
    ).toBeVisible();

    // One NDJSON line per document in the file.
    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    const exported = lines.map((line) => JSON.parse(line) as { sku: string; qty: number });
    expect(exported.map(({ sku, qty }) => ({ sku, qty })).sort((a, b) => a.qty - b.qty)).toEqual(
      DOCS,
    );

    // The Transfers tab loads the list from the backend when it opens.
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await openTransfersTab(page, database);
    const line = page.locator('[data-testid^="transfer-"]').filter({
      hasText: `Export ${database}.items`,
    });
    await expect(line).toHaveCount(1);
    await expect(line.getByText('Done', { exact: true })).toBeVisible();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await dropDatabase(database);
  }
});

test('cancel a running export, see it cancelled in the list', async ({ page, wiring }) => {
  const database = `wiring_transfers_${Math.random().toString(36).slice(2, 10)}`;
  const dir = mkdtempSync(join(tmpdir(), 'wiring-transfers-'));
  const filePath = join(dir, 'items.ndjson');
  try {
    await seed(database);
    wiring.setDialogPicks([filePath]);

    const dialog = await openExportDialog(page, wiring.url, database);
    await dialog.getByRole('button', { name: 'Save as', exact: true }).click();
    await expect(dialog.getByLabel('File')).toHaveValue(filePath);
    // The server sleeps 6 seconds per document, so the export is still running when it is cancelled.
    await dialog.getByLabel('Filter').fill('{"$where": "sleep(6000) || true"}');
    await dialog.getByRole('button', { name: 'Start export', exact: true }).click();

    await expect(dialog.getByText(`Exporting ${database}.items`)).toBeVisible();
    // No bytes flow, so the dialog has no progress and no Cancel button. Cancel from the list.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await openTransfersTab(page, database);
    const line = page.locator('[data-testid^="transfer-"]').filter({
      hasText: `Export ${database}.items`,
    });
    await expect(line).toHaveCount(1);
    await expect(line.getByText('Running', { exact: true })).toBeVisible();
    await line.getByRole('button', { name: 'Cancel', exact: true }).click();
    // The export notices the cancel after the document in flight, so allow for the sleep.
    await expect(line.getByText('Cancelled', { exact: true })).toBeVisible({ timeout: 25_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await dropDatabase(database);
  }
});
