import { MONGO_ROOT_PASSWORD } from '../../../support/mongo';
import { expect, test } from '../../fixtures';

test('connect to a secured server, type the password, see the tree', async ({ page, wiring }) => {
  await page.goto(wiring.url);
  await page.getByRole('treeitem', { name: 'Secured dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password', { exact: true }).fill(MONGO_ROOT_PASSWORD);
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: 'shop', exact: true })).toBeVisible();
});
