import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

test('run a statement, save it as a favourite, remove it, then clear the history', async ({
  page,
  wiring,
}) => {
  const database = `wiring_history_favourites_${randomUUID().slice(0, 8)}`;
  const client = new MongoClient(mongoUriFromEnv());
  try {
    await client
      .db(database)
      .collection('notes')
      .insertMany([{ text: 'one' }, { text: 'two' }]);

    await page.goto(wiring.url);
    await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
    await page.getByRole('treeitem', { name: database, exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open editor', exact: true }).click();
    await page.locator('.monaco-editor .view-lines').first().click();
    await page.keyboard.insertText('db.notes.find({})');
    await page.keyboard.press('F5');
    await expect(page.getByText('1 to 2 of 2', { exact: true })).toBeVisible();

    // history.list returns the recorded run.
    await page.getByRole('tab', { name: 'History', exact: true }).click();
    const historyRows = page.getByTestId('history-panel').getByRole('listitem');
    await expect(historyRows).toHaveCount(1);
    await expect(historyRows.first()).toContainText('db.notes.find({})');
    await expect(historyRows.first()).toContainText(database);

    // favourites.save through the dialog.
    await historyRows.first().getByRole('button', { name: 'Save as favourite' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save as favourite' });
    await dialog.getByLabel('Name').fill('Notes list');
    await dialog.getByLabel('Folder').fill('Wiring');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();

    // favourites.list shows it under its folder.
    await page.getByRole('tab', { name: 'Favourites', exact: true }).click();
    const favourites = page.getByTestId('favourites-panel');
    await expect(favourites.getByRole('heading', { name: 'Wiring' })).toBeVisible();
    const favouriteRow = favourites.getByRole('listitem');
    await expect(favouriteRow).toHaveCount(1);
    await expect(favouriteRow).toContainText('Notes list');
    await expect(favouriteRow).toContainText('db.notes.find({})');

    // favourites.remove, then the list is empty again.
    await favouriteRow.getByRole('button', { name: 'Delete Notes list' }).click();
    await expect(favourites.getByText('No favourites yet.', { exact: false })).toBeVisible();

    // history.clear empties the history.
    await page.getByRole('tab', { name: 'History', exact: true }).click();
    await expect(historyRows).toHaveCount(1);
    await page.getByRole('button', { name: 'Clear history', exact: true }).click();
    await expect(historyRows).toHaveCount(0);
    await expect(page.getByText('No runs match.', { exact: false })).toBeVisible();
  } finally {
    await client.db(database).dropDatabase();
    await client.close();
  }
});
