import type { Locator, Page } from '@playwright/test';

/**
 * Opens the Connections manager from the tree header and returns its dialog. The dialog has no
 * accessible name of its own, so it is found by the saved connections list it holds.
 */
export async function openConnectionManager(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Manage connections', exact: true }).click();
  return connectionManager(page);
}

/** The manager dialog, for a test that already opened it. */
export function connectionManager(page: Page): Locator {
  return page.getByRole('dialog').filter({
    has: page.getByRole('listbox', { name: 'Saved connections' }),
  });
}

/** One saved connection of the manager list. */
export function connectionOption(manager: Locator, name: string): Locator {
  return manager.getByRole('option').filter({ hasText: name });
}
