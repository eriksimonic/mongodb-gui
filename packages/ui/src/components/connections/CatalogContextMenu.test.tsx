// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithApp } from '../../test-support/render';
import { TransferModals } from '../transfers/TransferModals';
import { ConnectionTree } from './ConnectionTree';

/** Renders the tree with the transfer dialogs, as the shell does, and expands Local dev and shop. */
async function openDatabase(database: string) {
  renderWithApp(
    <>
      <ConnectionTree />
      <TransferModals />
    </>,
    { mock: { preset: 'unlocked' } },
  );
  const local = await screen.findByRole('treeitem', { name: 'Local dev' });
  local.focus();
  fireEvent.keyDown(local, { key: 'ArrowRight' });
  const shop = await screen.findByRole('treeitem', { name: database });
  shop.focus();
  fireEvent.keyDown(shop, { key: 'ArrowRight' });
}

describe('catalog context menus', () => {
  it('offers import and export on a collection and opens the export dialog', async () => {
    await openDatabase('shop');
    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'orders' }));

    expect(
      await screen.findByRole('menuitem', { name: 'Import data', hidden: true }),
    ).toBeEnabled();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export data', hidden: true }));

    const dialog = await screen.findByRole('dialog', { name: 'Export data' });
    expect(dialog).toHaveTextContent('shop.orders');
  });

  it('opens the import wizard on a collection', async () => {
    await openDatabase('shop');
    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'orders' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Import data', hidden: true }));

    const dialog = await screen.findByRole('dialog', { name: 'Import data' });
    expect(within(dialog).getByLabelText('File path')).toBeInTheDocument();
  });

  it('offers only a new collection import on a database', async () => {
    await openDatabase('shop');
    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'shop' }));

    expect(
      await screen.findByRole('menuitem', {
        name: 'Import data into new collection',
        hidden: true,
      }),
    ).toBeEnabled();
    expect(screen.queryByRole('menuitem', { name: 'Export data' })).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Import data into new collection', hidden: true }),
    );
    await waitFor(() => expect(screen.getByLabelText('New collection name')).toBeInTheDocument());
  });
});
