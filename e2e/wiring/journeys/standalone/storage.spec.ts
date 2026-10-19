import type { Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

// A database of its own, so the tile and row this journey looks for are the ones it made.
const DATABASE = 'storage_journey';

/** Connects Local dev, then opens its Storage panel from the Monitoring submenu. */
async function openStorage(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Monitoring', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Storage', exact: true }).click();
}

test('storage: the panel lists a database, and drilling in lists its collections', async ({
  page,
  wiring,
}) => {
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client.db(DATABASE).dropDatabase();
    await client
      .db(DATABASE)
      .collection('orders')
      .insertMany([{ sku: 'a', qty: 1 }, { sku: 'b', qty: 2 }]);
  } finally {
    await client.close();
  }

  try {
    await openStorage(page, wiring.url);
    await page.getByTestId(`storage-row-${DATABASE}`).click();
    await expect(page.getByTestId('storage-row-orders')).toBeVisible();
  } finally {
    const cleanup = new MongoClient(mongoUriFromEnv());
    try {
      await cleanup.db(DATABASE).dropDatabase();
    } finally {
      await cleanup.close();
    }
  }
});
