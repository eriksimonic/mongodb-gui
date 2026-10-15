import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '../../fixtures';

const PASSPHRASE = 'wiring-passphrase-1';

test('export connections to a file, preview it, import it as a copy', async ({ page, wiring }) => {
  // The file goes to a temp dir. Each test has its own saved connections, so nothing leaks to other specs.
  const filePath = join(mkdtempSync(join(tmpdir(), 'wiring-conn-')), 'connections.mgconn');

  await page.goto(wiring.url);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'Connections', exact: true });

  // Export. Every saved connection starts selected.
  wiring.setDialogPicks([filePath]);
  await manager.getByRole('button', { name: 'Export', exact: true }).click();
  const exporter = page.getByRole('dialog', { name: 'Export connections', exact: true });
  const boxes = exporter.getByRole('checkbox');
  await expect(exporter.getByRole('checkbox', { name: 'Local dev', exact: true })).toBeChecked();
  const total = await boxes.count();
  await exporter.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await exporter.getByLabel('Confirm passphrase', { exact: true }).fill(PASSPHRASE);
  await exporter.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(exporter.getByRole('status')).toContainText(`Saved ${total} connections`);
  await exporter.getByRole('button', { name: 'Done', exact: true }).click();
  expect(existsSync(filePath)).toBe(true);
  expect(statSync(filePath).size).toBeGreaterThan(0);

  // Import. Read file previews, and the name collides with the saved Local dev.
  wiring.setDialogPicks([filePath]);
  await manager.getByRole('button', { name: 'Import', exact: true }).click();
  const importer = page.getByRole('dialog', { name: 'Import connections', exact: true });
  await importer.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await importer.getByRole('button', { name: 'Read file', exact: true }).click();
  const preview = importer.getByRole('table', { name: 'Connections in the file' });
  await expect(preview.getByRole('cell', { name: 'Local dev', exact: true })).toBeVisible();
  await expect(preview.getByText('Exists', { exact: true })).toHaveCount(total);

  await importer.getByRole('radio', { name: /Import as copies/ }).check();
  await importer.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(importer.getByRole('status')).toContainText(`Imported ${total}, renamed ${total}`);
  await importer.getByRole('button', { name: 'Done', exact: true }).click();

  // The tree reloaded, so the copy shows next to the original.
  await manager.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: /^Local dev/ })).toHaveCount(2);
});
