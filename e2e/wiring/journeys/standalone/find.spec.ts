import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

interface Order {
  orderNumber: number;
  status: string;
  total: number;
}

test('connect, run find on shop.orders, see the rows the server holds', async ({
  page,
  wiring,
}) => {
  await page.goto(wiring.url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  // The catalog loads once connected. Open the editor on the shop database.
  await page.getByRole('treeitem', { name: 'shop', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open editor', exact: true }).click();
  // A click on the role textbox did not focus the editor. The visible lines do.
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.insertText('db.orders.find({})');
  await page.keyboard.press('F5');

  // Read the documents through a second client, so the check does not trust the UI.
  const client = new MongoClient(mongoUriFromEnv());
  let orders: Order[];
  try {
    orders = await client
      .db('shop')
      .collection<Order>('orders')
      .find({}, { projection: { _id: 0, orderNumber: 1, status: 1, total: 1 } })
      .toArray();
  } finally {
    await client.close();
  }
  expect(orders).toHaveLength(3);

  await expect(
    page.getByText(`1 to ${orders.length} of ${orders.length}`, { exact: true }),
  ).toBeVisible();
  const rows = page.getByRole('row').filter({ has: page.getByRole('gridcell') });
  await expect(rows).toHaveCount(orders.length);
  for (const [index, order] of orders.entries()) {
    const values = [order.orderNumber, order.status, order.total].map(String);
    for (const value of values) {
      await expect(
        rows.nth(index).getByRole('gridcell', { name: value, exact: true }),
      ).toBeVisible();
    }
  }
});
