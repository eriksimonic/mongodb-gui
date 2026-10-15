import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

// Result handling of the shell: later batches, cancel, full documents, release and completion.

function databaseName(): string {
  return `wiring_shell_results_${randomBytes(4).toString('hex')}`;
}

/** Connects Local dev and opens an editor on one database. */
async function openEditor(page: Page, url: string, database: string): Promise<void> {
  await page.goto(url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  await page.getByRole('treeitem', { name: database, exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open editor', exact: true }).click();
  // A click on the role textbox did not focus the editor. The visible lines do.
  await page.locator('.monaco-editor .view-lines').first().click();
}

async function run(page: Page, code: string): Promise<void> {
  await page.keyboard.insertText(code);
  await page.keyboard.press('F5');
}

test('shell: Load all reads the later batches of a cursor', async ({ page, wiring }) => {
  const DATABASE = databaseName();
  const TOTAL = 120;
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client
      .db(DATABASE)
      .collection('items')
      .insertMany(Array.from({ length: TOTAL }, (_, n) => ({ n })));

    await openEditor(page, wiring.url, DATABASE);
    await run(page, 'db.items.find({})');

    // The first batch is 50 documents, so more are on the server.
    await expect(page.getByText('1 to 50 of ?', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Load all up to/ }).click();
    await page.getByRole('button', { name: 'Load', exact: true }).click();

    const count = await client.db(DATABASE).collection('items').countDocuments();
    expect(count).toBe(TOTAL);
    await expect(page.getByText(`1 to ${count} of ${count}`, { exact: true })).toBeVisible();
  } finally {
    await client.db(DATABASE).dropDatabase();
    await client.close();
  }
});

test('shell: Cancel stops a running statement', async ({ page, wiring }) => {
  const DATABASE = databaseName();
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client.db(DATABASE).collection('items').insertOne({ n: 1 });

    await openEditor(page, wiring.url, DATABASE);
    await run(page, 'sleep(60000)');

    // The Run button turns into Cancel while the statement runs.
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
    await expect(cancel).toBeVisible();
    await cancel.click();
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
    await expect(cancel).toHaveCount(0);
  } finally {
    await client.db(DATABASE).dropDatabase();
    await client.close();
  }
});

test('shell: a large document opens in full from the server', async ({ page, wiring }) => {
  const DATABASE = databaseName();
  const MARKER = 'wiring-shell-results-tail';
  // Over the 16 KiB preview limit, so the result carries a preview and the dialog reads the rest.
  const BODY = 'x'.repeat(20_000);
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client.db(DATABASE).collection('items').insertOne({ body: BODY, tail: MARKER });

    await openEditor(page, wiring.url, DATABASE);
    await run(page, 'db.items.find({})');

    const rows = page.getByRole('row').filter({ has: page.getByRole('gridcell') });
    await expect(rows).toHaveCount(1);
    await rows.first().dblclick();

    await expect(page.getByRole('dialog')).toBeVisible();
    // The preview cuts the document before the last field. Only the full text has it.
    // The body wraps over many lines, so the last field is below the visible ones. Jump to the end.
    await page.getByRole('dialog').locator('.monaco-editor .view-lines').click();
    await page.keyboard.press('Control+End');
    await expect(page.getByRole('dialog').locator('.view-lines')).toContainText(MARKER);
    const stored = await client.db(DATABASE).collection('items').findOne({});
    expect(stored?.['tail']).toBe(MARKER);
  } finally {
    await client.db(DATABASE).dropDatabase();
    await client.close();
  }
});

test('shell: closing the editor tab releases the held result', async ({ page, wiring }) => {
  const DATABASE = databaseName();
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client
      .db(DATABASE)
      .collection('items')
      .insertMany(Array.from({ length: 120 }, (_, n) => ({ n })));

    await openEditor(page, wiring.url, DATABASE);
    await run(page, 'db.items.find({})');
    await expect(page.getByText('1 to 50 of ?', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Close tab' }).click();
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0);
  } finally {
    await client.db(DATABASE).dropDatabase();
    await client.close();
  }
});

test('shell: completion lists a collection method', async ({ page, wiring }) => {
  const DATABASE = databaseName();
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client.db(DATABASE).collection('items').insertOne({ n: 1 });

    await openEditor(page, wiring.url, DATABASE);
    await page.keyboard.insertText('db.items.coun');
    await page.keyboard.press('Control+Space');

    await expect(
      page.locator('.suggest-widget').getByText('countDocuments', { exact: false }).first(),
    ).toBeVisible();
  } finally {
    await client.db(DATABASE).dropDatabase();
    await client.close();
  }
});
