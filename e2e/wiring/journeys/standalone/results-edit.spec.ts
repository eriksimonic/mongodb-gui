import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

// Editing a document from the results of a find: a field in the tree view, and the whole document
// in the editor dialog. The server is read through a second client, not through the UI.

function databaseName(): string {
  return `wiring_results_edit_${randomBytes(4).toString('hex')}`;
}

/** Connects Local dev, opens an editor on the database and runs a find on items. */
async function findItems(page: Page, url: string, database: string): Promise<void> {
  await page.goto(url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  await page.getByRole('treeitem', { name: database, exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open editor', exact: true }).click();
  // A click on the role textbox did not focus the editor. The visible lines do.
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.insertText('db.items.find({})');
  await page.keyboard.press('F5');
}

test('edit a field in the tree view and the whole document in the dialog', async ({
  page,
  wiring,
}) => {
  const DATABASE = databaseName();
  const client = new MongoClient(mongoUriFromEnv());
  try {
    const items = client.db(DATABASE).collection('items');
    const { insertedId } = await items.insertOne({ sku: 'A-1', status: 'new' });

    await findItems(page, wiring.url, DATABASE);
    await expect(page.getByText('1 to 1 of 1', { exact: true })).toBeVisible();

    // management.updateDocumentFields: one field of the first document, edited in the tree.
    await page.locator('label[for$="-tree"]').click();
    await page.getByRole('button', { name: 'Edit status', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'New value for status' });
    await input.fill('shipped');
    await input.press('Enter');
    await expect(input).toBeHidden();
    await expect
      .poll(async () => (await items.findOne({ _id: insertedId }))?.['status'])
      .toBe('shipped');

    // management.replaceDocument: the table row opens the document, and Save replaces it.
    await page.locator('label[for$="-table"]').click();
    // A scalar cell edits in place, so the _id cell, which cannot be edited, opens the document.
    await page.getByRole('gridcell', { name: insertedId.toHexString(), exact: true }).dblclick();
    const dialog = page.getByRole('dialog', { name: 'Edit document in items', exact: true });
    await dialog.locator('.monaco-editor .view-lines').click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Delete');
    await page.keyboard.insertText(
      JSON.stringify({ _id: { $oid: insertedId.toHexString() }, sku: 'A-1', status: 'replaced' }),
    );
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => (await items.findOne({ _id: insertedId }))?.['status'])
      .toBe('replaced');
  } finally {
    await client.db(DATABASE).dropDatabase();
    await client.close();
  }
});
