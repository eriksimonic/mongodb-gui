import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '../../fixtures';

const execFileAsync = promisify(execFile);

interface Order {
  orderNumber: number;
  status: string;
}

test.use({ realDocker: true });

test('connect to a container with no published port, find its orders', async ({ page, wiring }) => {
  // Read the documents with docker exec, so the check does not trust the UI.
  const container = process.env['E2E_DOCKER_CONTAINER'];
  if (container === undefined) {
    throw new Error('E2E_DOCKER_CONTAINER is not set. Run with E2E_SEGMENT=docker.');
  }
  const { stdout } = await execFileAsync('docker', [
    'exec',
    container,
    'mongosh',
    '--quiet',
    '--eval',
    "JSON.stringify(db.getSiblingDB('docker_shop').orders.find({}, { _id: 0 }).sort({ orderNumber: 1 }).toArray())",
  ]);
  const orders = JSON.parse(stdout) as Order[];
  expect(orders).toHaveLength(2);

  await page.goto(wiring.url);
  // The Docker node starts open and lists the container by name. Connect from its menu.
  await page.getByRole('treeitem', { name: container, exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();

  // The container has no user name, so no credentials dialog opens. The connection
  // row keeps the container name. It starts collapsed, so expand it with the keyboard.
  const connection = page.getByRole('treeitem', { name: container, exact: true });
  await expect(page.getByLabel('Connected', { exact: true })).toBeVisible();
  await connection.press('ArrowRight');
  const database = page.getByRole('treeitem', { name: 'docker_shop', exact: true });
  await expect(database).toBeVisible();
  await database.press('ArrowRight');
  await expect(page.getByRole('treeitem', { name: 'orders', exact: true })).toBeVisible();

  await database.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open editor', exact: true }).click();
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.insertText('db.orders.find({})');
  await page.keyboard.press('F5');

  await expect(
    page.getByText(`1 to ${orders.length} of ${orders.length}`, { exact: true }),
  ).toBeVisible();
  const rows = page.getByRole('row').filter({ has: page.getByRole('gridcell') });
  await expect(rows).toHaveCount(orders.length);
  for (const [index, order] of orders.entries()) {
    for (const value of [String(order.orderNumber), order.status]) {
      await expect(
        rows.nth(index).getByRole('gridcell', { name: value, exact: true }),
      ).toBeVisible();
    }
  }

  // Disconnect from the connection row, so the forwarder container is removed.
  await page.getByRole('treeitem', { name: container, exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
  await expect(database).toHaveCount(0);
});
