// @vitest-environment jsdom
import type { ConnectionStatus } from '@mongo-gui/core';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import { useBackupDialogs } from '../backup';
import { ProfilerOpenerContext } from '../profiler';
import { connectionNodeId } from '../state/node-ids';
import { PanelOpenerContext, type OpenPanel } from '../state/panel-opener';
import { renderWithApp } from '../test-support/render';
import { openSubmenu } from '../test-support/menu';
import { ConnectionTree } from './ConnectionTree';
import { FOCUS_TREE_SEARCH_EVENT } from './search-constants';

describe('ConnectionTree', () => {
  it('searches without crashing and keeps the typed text', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    const local = await screen.findByRole('treeitem', { name: 'Local dev' });
    local.focus();
    fireEvent.keyDown(local, { key: 'ArrowRight' });
    const shop = await screen.findByRole('treeitem', { name: 'shop' });
    shop.focus();
    fireEvent.keyDown(shop, { key: 'ArrowRight' });
    await screen.findByRole('treeitem', { name: 'orders' });
    await screen.findByRole('treeitem', { name: 'shop-mongo' });
    const box = screen.getByLabelText('Search databases and collections');
    for (const value of ['o', 'or', 'ord', 'zzz', '']) {
      fireEvent.change(box, { target: { value } });
      expect(box).toHaveValue(value);
    }
    fireEvent.change(box, { target: { value: 'ord' } });
    expect(box).toHaveValue('ord');
    expect(await screen.findByText(/matches? in/)).toBeInTheDocument();
    expect(screen.getByText('In connected servers')).toBeInTheDocument();
    expect((await screen.findAllByRole('treeitem', { name: 'orders' })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('treeitem', { name: 'Monitoring' })).not.toBeInTheDocument();
  });

  it('loads databases when a connection is opened with the keyboard', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    const local = await screen.findByRole('treeitem', { name: 'Local dev' });
    local.focus();
    fireEvent.keyDown(local, { key: 'ArrowRight' });

    expect(await screen.findByRole('treeitem', { name: 'shop' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'analytics' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'logs' })).toBeInTheDocument();
  });

  it('shows collections when a database is expanded', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    const local = await screen.findByRole('treeitem', { name: 'Local dev' });
    local.focus();
    fireEvent.keyDown(local, { key: 'ArrowRight' });
    const shop = await screen.findByRole('treeitem', { name: 'shop' });
    shop.focus();
    fireEvent.keyDown(shop, { key: 'ArrowRight' });

    expect(await screen.findByRole('treeitem', { name: 'orders' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'paid_orders' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'sensor_readings' })).toBeInTheDocument();
  });

  it('gives one tab stop to the whole tree and moves it with the arrow keys', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    const local = await screen.findByRole('treeitem', { name: 'Local dev' });
    const staging = screen.getByRole('treeitem', { name: 'Staging' });
    expect(local).toHaveAttribute('tabindex', '0');
    expect(staging).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(local, { key: 'ArrowDown' });
    expect(staging).toHaveFocus();
    expect(staging).toHaveAttribute('tabindex', '0');
    expect(local).toHaveAttribute('tabindex', '-1');
    expect(staging).toHaveAttribute('aria-level', '1');
  });

  it('collapses with the Left arrow and returns focus to the parent', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    const local = await screen.findByRole('treeitem', { name: 'Local dev' });
    local.focus();
    fireEvent.keyDown(local, { key: 'ArrowRight' });
    const shop = await screen.findByRole('treeitem', { name: 'shop' });
    shop.focus();

    fireEvent.keyDown(shop, { key: 'ArrowLeft' });
    expect(local).toHaveFocus();
    fireEvent.keyDown(local, { key: 'ArrowLeft' });
    await waitFor(() => expect(local).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.queryByRole('treeitem', { name: 'shop' })).not.toBeInTheDocument();
  });

  it('connects a connection with Enter and shows the auth error', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    const staging = await screen.findByRole('treeitem', { name: 'Staging' });
    staging.focus();
    fireEvent.keyDown(staging, { key: 'Enter' });

    expect(await screen.findByText('Authentication failed')).toBeInTheDocument();
    expect(staging).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the context menu on right click', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'Local dev' }));

    expect(await screen.findByRole('menuitem', { name: 'Connect' })).toBeInTheDocument();
    expect(await screen.findByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Remove')).toBeInTheDocument();
  });

  it('opens the context menu from the keyboard with Shift+F10', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    const local = await screen.findByRole('treeitem', { name: 'Local dev' });
    local.focus();
    fireEvent.keyDown(local, { key: 'F10', shiftKey: true });

    expect(await screen.findByRole('menuitem', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('opens the profiler of a database from its Profiler node', async () => {
    const open = vi.fn();
    renderWithApp(
      <ProfilerOpenerContext.Provider value={{ open }}>
        <ConnectionTree />
      </ProfilerOpenerContext.Provider>,
      { mock: { preset: 'unlocked' } },
    );
    const local = await screen.findByRole('treeitem', { name: 'Local dev' });
    local.focus();
    fireEvent.keyDown(local, { key: 'ArrowRight' });
    const shop = await screen.findByRole('treeitem', { name: 'shop' });
    shop.focus();
    fireEvent.keyDown(shop, { key: 'ArrowRight' });

    const profiler = await screen.findByRole('treeitem', { name: 'Profiler' });
    profiler.focus();
    fireEvent.keyDown(profiler, { key: 'Enter' });

    expect(open).toHaveBeenCalledWith(localConnectionId, 'shop');
  });

  it('opens the profiler from the database context menu', async () => {
    const open = vi.fn();
    renderWithApp(
      <ProfilerOpenerContext.Provider value={{ open }}>
        <ConnectionTree />
      </ProfilerOpenerContext.Provider>,
      { mock: { preset: 'unlocked' } },
    );
    const local = await screen.findByRole('treeitem', { name: 'Local dev' });
    local.focus();
    fireEvent.keyDown(local, { key: 'ArrowRight' });

    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'analytics' }));
    await openSubmenu('Monitoring');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open profiler' }));

    expect(open).toHaveBeenCalledWith(localConnectionId, 'analytics');
  });

  it('shows a hint when there are no connections', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    for (const connection of await api.rpc.connections.list()) {
      await api.rpc.connections.remove({ id: connection.id });
    }
    renderWithApp(<ConnectionTree />, { api });
    expect(await screen.findByText('No connections yet.')).toBeInTheDocument();
  });

  it('focuses and selects the search box on the find event', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    await screen.findByRole('treeitem', { name: 'Local dev' });
    const box = screen.getByLabelText('Search databases and collections') as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'ord' } });
    window.dispatchEvent(new Event(FOCUS_TREE_SEARCH_EVENT));
    expect(box).toHaveFocus();
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(3);
  });

  it('finds a collection in a database that was never opened and reveals it on select', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    const local = await screen.findByRole('treeitem', { name: 'Local dev' });
    local.focus();
    fireEvent.keyDown(local, { key: 'ArrowRight' });
    await screen.findByRole('treeitem', { name: 'analytics' });
    expect(screen.queryByRole('treeitem', { name: 'bson_samples' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search databases and collections'), {
      target: { value: 'bson_sam' },
    });
    fireEvent.click(
      (await screen.findAllByRole('treeitem', { name: 'bson_samples' }))[0] as HTMLElement,
    );

    await waitFor(() =>
      expect(
        screen
          .getAllByRole('treeitem', { name: 'bson_samples' })
          .some((item) => item.getAttribute('aria-selected') === 'true'),
      ).toBe(true),
    );
    expect(screen.getByLabelText('Search databases and collections')).toHaveValue('');
    expect(screen.getByRole('treeitem', { name: 'analytics' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});

describe('ConnectionTree name catalog fetching', () => {
  it('fetches at once the first time, debounces later fetches and refreshes on demand', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = createMockUiApi({ preset: 'unlocked' });
      const listNames = vi.spyOn(api.rpc.catalog, 'listNames');
      renderWithApp(<ConnectionTree />, { api });
      await screen.findByRole('treeitem', { name: 'Local dev' });
      const box = screen.getByLabelText('Search databases and collections');

      fireEvent.change(box, { target: { value: 'o' } });
      await vi.advanceTimersByTimeAsync(500);
      const first = listNames.mock.calls.length;
      expect(first).toBeGreaterThan(0);

      // Typing again inside the age limit never refetches, even after the debounce passes.
      fireEvent.change(box, { target: { value: 'or' } });
      await vi.advanceTimersByTimeAsync(4000);
      expect(listNames.mock.calls.length).toBe(first);

      // Past the age limit, a keystroke starts the debounce and the fetch follows it.
      fireEvent.change(box, { target: { value: 'ord' } });
      await vi.advanceTimersByTimeAsync(4900);
      expect(listNames.mock.calls.length).toBe(first);
      await vi.advanceTimersByTimeAsync(300);
      expect(listNames.mock.calls.length).toBeGreaterThan(first);

      // The refresh button fetches at once.
      const before = listNames.mock.calls.length;
      await vi.advanceTimersByTimeAsync(100);
      fireEvent.click(screen.getByRole('button', { name: 'Reload names from the servers' }));
      await vi.advanceTimersByTimeAsync(10);
      expect(listNames.mock.calls.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

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
    // shop-mongo is connected in the mock too, so two connected icons appear after this click.
    await waitFor(() => expect(screen.getAllByLabelText('Connected')).toHaveLength(2));
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
    const orders = await screen.findByRole('treeitem', { name: 'orders-mongo' });
    orders.focus();
    fireEvent.keyDown(orders, { key: 'Enter' });

    await waitFor(() => expect(screen.getAllByLabelText('Connected')).toHaveLength(2));
  });

  it('keeps the container meta and menu on a connected container', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    const shop = await screen.findByRole('treeitem', { name: 'shop-mongo' });

    expect(shop).toHaveAttribute('aria-level', '2');
    expect(within(shop).getByLabelText('Published port')).toBeInTheDocument();
    expect(within(shop).getByLabelText('Running')).toBeInTheDocument();
  });

  it('copies the redacted URI and opens the container details from a connected container', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithApp(<ConnectionTree />, { api });
    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'shop-mongo' }));
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Copy URI (redacted)', hidden: true }),
    );

    const summary = (await api.rpc.connections.list()).find((item) => item.name === 'shop-mongo');
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(summary?.uriRedacted));
    expect(summary?.uriRedacted).not.toContain('secret');

    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'shop-mongo' }));
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Open container details', hidden: true }),
    );
    expect(await screen.findByText('Container details')).toBeInTheDocument();
    expect(screen.getByText('MONGO_INITDB_ROOT_PASSWORD')).toBeInTheDocument();
  });

  it('shows Docker not available with the reason and keeps saved docker connections', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked', docker: 'unavailable' } });

    expect(await screen.findByText('Docker not available')).toBeInTheDocument();
    expect(
      screen.getByText('Docker is not reachable at /var/run/docker.sock (ENOENT).'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: 'orders-mongo' })).not.toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'shop-mongo' })).toHaveAttribute(
      'title',
      'Docker not reachable',
    );
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

  it('opens backup and restore from a connected container', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'shop-mongo' }));
    await openSubmenu('Backup');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Back up…', hidden: true }));
    expect(useBackupDialogs.getState().request).toMatchObject({ kind: 'backup' });

    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'shop-mongo' }));
    await openSubmenu('Backup');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Restore…', hidden: true }));
    expect(useBackupDialogs.getState().request).toMatchObject({ kind: 'restore' });
  });

  it('disables backup and restore on a container without a connection', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'orders-mongo' }));
    expect(await screen.findByRole('menuitem', { name: /^Back up…/, hidden: true })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: /^Restore…/, hidden: true })).toBeDisabled();
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

const CONNECTED: ConnectionStatus = {
  state: 'connected',
  serverVersion: '8.0.4',
  topology: 'standalone',
  hosts: ['localhost:27017'],
};

function renderOpenConnected(openPanel: OpenPanel) {
  return renderWithApp(
    <PanelOpenerContext.Provider value={openPanel}>
      <ConnectionTree />
    </PanelOpenerContext.Provider>,
    {
      mock: { preset: 'unlocked' },
      initialState: {
        statuses: { [localConnectionId]: CONNECTED },
        expanded: { [connectionNodeId(localConnectionId)]: true },
      },
    },
  );
}

describe('ConnectionTree monitor children', () => {
  it('opens the monitor panel for the connection on double click of Monitoring', async () => {
    const openPanel = vi.fn<OpenPanel>();
    renderOpenConnected(openPanel);

    fireEvent.doubleClick(await screen.findByRole('treeitem', { name: 'Monitoring' }));

    expect(openPanel).toHaveBeenCalledWith({
      kind: 'monitor',
      connectionId: localConnectionId,
      connectionName: 'Local dev',
    });
  });

  it('offers Monitor in the connection context menu once the connection is open', async () => {
    const openPanel = vi.fn<OpenPanel>();
    renderOpenConnected(openPanel);

    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'Local dev' }));
    await openSubmenu('Monitoring');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Monitor' }));

    expect(openPanel).toHaveBeenCalledWith({
      kind: 'monitor',
      connectionId: localConnectionId,
      connectionName: 'Local dev',
    });
  });

  it('opens the operations panel with Enter on the Operations child', async () => {
    const openPanel = vi.fn<OpenPanel>();
    renderOpenConnected(openPanel);

    const operations = await screen.findByRole('treeitem', { name: 'Operations' });
    operations.focus();
    fireEvent.keyDown(operations, { key: 'Enter' });

    expect(openPanel).toHaveBeenCalledWith({
      kind: 'operations',
      connectionId: localConnectionId,
      connectionName: 'Local dev',
    });
  });
});

/** Opens Local dev, which the mock runs as a three-member replica set, and waits for the members. */
async function openReplicaSet(): Promise<void> {
  renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked', replication: true } });
  const local = await screen.findByRole('treeitem', { name: 'Local dev' });
  local.focus();
  fireEvent.keyDown(local, { key: 'ArrowRight' });
  await screen.findByRole('treeitem', { name: 'localhost:27018' });
}

describe('ConnectionTree replica set node', () => {
  it('lists the members with their state under the set node', async () => {
    await openReplicaSet();

    const node = screen.getByRole('treeitem', { name: 'Replica set rs0' });
    const primary = screen.getByRole('treeitem', { name: 'localhost:27017' });
    const arbiter = screen.getByRole('treeitem', { name: 'localhost:27019' });
    expect(node).toHaveAttribute('aria-expanded', 'true');
    expect(primary).toHaveAttribute('aria-level', '3');
    expect(primary).toHaveAttribute('title', 'PRIMARY · this connection');
    expect(within(primary).getByText('PRIMARY · this')).toBeInTheDocument();
    expect(arbiter).toHaveAttribute('title', 'ARBITER');
    expect(screen.getByRole('treeitem', { name: 'localhost:27018' })).toHaveAttribute(
      'title',
      'SECONDARY · 2.5 s behind',
    );
  });

  it('connects directly to a member from its menu and shows the new connection', async () => {
    await openReplicaSet();
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'localhost:27018' }));
    fireEvent.click(await screen.findByText('Connect directly'));

    const direct = await screen.findByRole('treeitem', { name: 'Local dev · localhost:27018' });
    await waitFor(() => expect(direct).toHaveAttribute('aria-expanded', 'true'));
  });

  it('collapses the set node and remembers that', async () => {
    await openReplicaSet();
    const node = screen.getByRole('treeitem', { name: 'Replica set rs0' });
    node.focus();
    fireEvent.keyDown(node, { key: 'ArrowLeft' });

    await waitFor(() =>
      expect(screen.queryByRole('treeitem', { name: 'localhost:27018' })).not.toBeInTheDocument(),
    );
    expect(node).toHaveAttribute('aria-expanded', 'false');
  });
});
