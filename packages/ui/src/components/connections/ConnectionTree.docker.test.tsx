// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { renderWithApp } from '../../test-support/render';
import { ConnectionTree } from './ConnectionTree';

describe('ConnectionTree Docker node', () => {
  it('lists the discovered containers under the Docker node', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });

    const shop = await screen.findByRole('treeitem', { name: 'shop-mongo' });
    const orders = screen.getByRole('treeitem', { name: 'orders-mongo' });
    expect(screen.getByRole('treeitem', { name: 'Docker' })).toBeInTheDocument();
    expect(shop).toHaveAttribute('aria-level', '2');
    expect(orders).toHaveAttribute('aria-level', '2');
    expect(within(orders).getByLabelText('via forwarder')).toBeInTheDocument();
    expect(within(shop).getByLabelText('Published port')).toBeInTheDocument();
  });

  it('connects a container with one click and shows the connection under the node', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    fireEvent.click(await screen.findByRole('treeitem', { name: 'orders-mongo' }));

    // The container row is replaced by the connection row, so the element is read again after the wait.
    await waitFor(() => expect(screen.getByLabelText('Connected')).toBeInTheDocument());
    const connection = screen.getByRole('treeitem', { name: 'orders-mongo' });
    expect(connection).toHaveAttribute('aria-level', '2');

    connection.focus();
    fireEvent.keyDown(connection, { key: 'ArrowRight' });
    expect(await screen.findByRole('treeitem', { name: 'shop' })).toHaveAttribute(
      'aria-level',
      '3',
    );
  });

  it('connects a container with Enter from the keyboard', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    const shop = await screen.findByRole('treeitem', { name: 'shop-mongo' });
    shop.focus();
    fireEvent.keyDown(shop, { key: 'Enter' });

    expect(await screen.findByLabelText('Connected')).toBeInTheDocument();
  });

  it('shows Docker not available with the reason when the engine is unreachable', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked', docker: 'unavailable' } });

    expect(await screen.findByText('Docker not available')).toBeInTheDocument();
    expect(screen.getByText('Docker is not reachable. (ENOENT)')).toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: 'shop-mongo' })).not.toBeInTheDocument();
  });

  it('opens the container menu and lists the environment variable names only', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'shop-mongo' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open container details' }));

    expect(await screen.findByText('Container details')).toBeInTheDocument();
    expect(screen.getByText('MONGO_INITDB_ROOT_PASSWORD')).toBeInTheDocument();
    expect(
      screen.getByText('6c1e0b9d4f2a7e83c5d1b0a9f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6b'),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('secret');
  });

  it('disables Copy URI until the container has a connection', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'orders-mongo' }));

    // Mantine's open transition leaves the items outside the accessibility tree in jsdom, so
    // the state is read with hidden items included.
    expect(
      await screen.findByRole('menuitem', { name: 'Copy URI (redacted)', hidden: true }),
    ).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Connect', hidden: true })).toBeEnabled();
  });

  it('turns connect automatically on from the Docker node menu', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    renderWithApp(<ConnectionTree />, { api });
    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'Docker' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Connect automatically' }));

    await waitFor(async () => {
      expect((await api.rpc.settings.get()).dockerAutoConnect).toBe(true);
    });
  });
});
