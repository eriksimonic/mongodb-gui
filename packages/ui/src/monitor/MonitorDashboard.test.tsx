// @vitest-environment jsdom
import type { ConnectionStatus, DashboardLayout } from '@mongo-gui/core';
import { dashboardLayoutKey, defaultDashboardLayout } from '@mongo-gui/core';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi, type MockUiApiOptions } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import { renderWithApp } from '../test-support/render';
import { MonitorDashboard } from './MonitorDashboard';

const STANDALONE: ConnectionStatus = {
  state: 'connected',
  serverVersion: '8.0.4',
  topology: 'standalone',
  hosts: ['localhost:27017'],
};
const REPLICA_SET: ConnectionStatus = {
  state: 'connected',
  serverVersion: '8.0.4',
  topology: 'replicaSet',
  setName: 'rs0',
  hosts: ['db-1:27017', 'db-2:27017', 'db-3:27017'],
};
const LONG_TIMEOUT_MS = 15_000;
const KEY = dashboardLayoutKey(localConnectionId);

/** A mock api with the local connection already open, as the shell would leave it. */
async function connectedApi(options: MockUiApiOptions = { preset: 'unlocked' }): Promise<UiApi> {
  const api = createMockUiApi(options);
  await api.rpc.connections.connect({ id: localConnectionId });
  return api;
}

function renderDashboard(api: UiApi, status: ConnectionStatus = STANDALONE) {
  return renderWithApp(<MonitorDashboard connectionId={localConnectionId} />, {
    api,
    initialState: { statuses: { [localConnectionId]: status } },
  });
}

/** The ids of the panels on the grid, in the order they are drawn. */
function panelIds(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-testid="chart-card"]')).map((card) =>
    card.getAttribute('data-panel-id'),
  );
}

async function waitForGrid(): Promise<void> {
  await screen.findByTestId('panel-grid');
}

describe('MonitorDashboard panels', () => {
  it(
    'draws the default panels on a standalone server, without replication lag',
    async () => {
      const api = await connectedApi();
      renderDashboard(api);
      await waitForGrid();
      expect(panelIds()).toEqual([
        'operations-by-type',
        'connections',
        'network',
        'memory',
        'queues',
      ]);
      expect(screen.queryByText('Replication lag')).not.toBeInTheDocument();
      expect(screen.getAllByTestId('chart-container')).toHaveLength(5);
    },
    LONG_TIMEOUT_MS,
  );

  it(
    'adds the replication lag panel on a replica set',
    async () => {
      const api = await connectedApi({ preset: 'unlocked', replication: true });
      renderDashboard(api, REPLICA_SET);
      await waitForGrid();
      expect(panelIds()).toContain('replication-lag');
      expect(screen.getByText('Replication lag')).toBeInTheDocument();
    },
    LONG_TIMEOUT_MS,
  );

  it(
    'keeps the stat tiles and the range and interval controls',
    async () => {
      const api = await connectedApi();
      renderDashboard(api);
      expect(await screen.findByText('Uptime')).toBeInTheDocument();
      expect(screen.getByText('Operations per second')).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: '5 min' })).toBeChecked();
      expect(screen.getByRole('radio', { name: '2 s' })).toBeChecked();
    },
    LONG_TIMEOUT_MS,
  );

  it(
    'sends the chosen sampling interval to the api',
    async () => {
      const api = await connectedApi();
      const setInterval = vi.spyOn(api.rpc.monitor, 'setInterval');
      renderDashboard(api);
      await waitForGrid();

      fireEvent.click(screen.getByRole('radio', { name: '5 s' }));

      await waitFor(() =>
        expect(setInterval).toHaveBeenCalledWith({
          connectionId: localConnectionId,
          intervalMs: 5000,
        }),
      );
    },
    LONG_TIMEOUT_MS,
  );

  it(
    'freezes the view on pause and says so',
    async () => {
      const api = await connectedApi();
      renderDashboard(api);
      await waitForGrid();
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
      expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
      expect(screen.getByText(/· Paused$/)).toBeInTheDocument();
    },
    LONG_TIMEOUT_MS,
  );
});

describe('MonitorDashboard layout', () => {
  it(
    'closes a panel from its menu and saves the layout',
    async () => {
      const api = await connectedApi();
      const set = vi.spyOn(api.rpc.layout, 'set');
      renderDashboard(api);
      await waitForGrid();

      fireEvent.click(screen.getByRole('button', { name: 'Options for Queued operations' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Close panel' }));

      expect(panelIds()).not.toContain('queues');
      await waitFor(
        () =>
          expect(set).toHaveBeenCalledWith({
            key: KEY,
            value: {
              version: 1,
              panels: defaultDashboardLayout().panels.filter((panel) => panel.id !== 'queues'),
            },
          }),
        { timeout: 2000 },
      );
    },
    LONG_TIMEOUT_MS,
  );

  it(
    'adds a WiredTiger panel from the picker and marks a panel already on the dashboard',
    async () => {
      const api = await connectedApi();
      renderDashboard(api);
      await waitForGrid();

      fireEvent.click(screen.getByRole('button', { name: 'Add panel' }));
      fireEvent.change(await screen.findByLabelText('Search panels'), {
        target: { value: 'cache' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add WiredTiger cache' }));

      expect(panelIds()).toContain('wt-cache');

      // A panel that is already on the dashboard is marked, and its add button is off.
      fireEvent.change(screen.getByLabelText('Search panels'), {
        target: { value: 'operations by type' },
      });
      const row = screen.getByTestId('picker-row');
      expect(row).toHaveAttribute('data-panel-id', 'operations-by-type');
      expect(within(row).getByText('On the dashboard')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add Operations by type' })).toBeDisabled();
    },
    LONG_TIMEOUT_MS,
  );

  it(
    'shows the reason a panel is unavailable and disables its add button',
    async () => {
      const api = await connectedApi();
      renderDashboard(api);
      await waitForGrid();

      fireEvent.click(screen.getByRole('button', { name: 'Add panel' }));
      fireEvent.change(await screen.findByLabelText('Search panels'), {
        target: { value: 'replication lag' },
      });
      const add = screen.getByRole('button', { name: 'Add Replication lag' });
      expect(add).toBeDisabled();
      expect(screen.getByText('Needs a replica set')).toBeInTheDocument();
    },
    LONG_TIMEOUT_MS,
  );

  it(
    'moves a panel when it is dropped on another card',
    async () => {
      const api = await connectedApi();
      const set = vi.spyOn(api.rpc.layout, 'set');
      renderDashboard(api);
      await waitForGrid();

      const network = document.querySelector(
        '[data-panel-id="network"] [data-testid="panel-header"]',
      );
      const connections = document.querySelector('[data-panel-id="connections"]');
      expect(network).not.toBeNull();
      expect(connections).not.toBeNull();
      if (network === null || connections === null) {
        return;
      }
      fireEvent.dragStart(network);
      fireEvent.dragOver(connections);
      fireEvent.drop(connections);

      expect(panelIds().slice(0, 3)).toEqual(['operations-by-type', 'network', 'connections']);
      await waitFor(() => expect(set).toHaveBeenCalled(), { timeout: 2000 });
    },
    LONG_TIMEOUT_MS,
  );

  it(
    'changes the width from the panel menu',
    async () => {
      const api = await connectedApi();
      renderDashboard(api);
      await waitForGrid();

      fireEvent.click(screen.getByRole('button', { name: 'Options for Memory' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: /3 columns/ }));

      const card = document.querySelector('[data-panel-id="memory"]') as HTMLElement | null;
      expect(card?.style.getPropertyValue('--panel-w')).toBe('3');
    },
    LONG_TIMEOUT_MS,
  );

  it(
    'resets the dashboard to the default panels',
    async () => {
      const api = await connectedApi();
      renderDashboard(api);
      await waitForGrid();

      fireEvent.click(screen.getByRole('button', { name: 'Options for Memory' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Close panel' }));
      expect(panelIds()).not.toContain('memory');

      fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));

      expect(panelIds()).toEqual([
        'operations-by-type',
        'connections',
        'network',
        'memory',
        'queues',
      ]);
    },
    LONG_TIMEOUT_MS,
  );

  it(
    'shows an empty state when every panel is closed, and lets the user reset',
    async () => {
      const api = await connectedApi();
      renderDashboard(api);
      await waitForGrid();

      for (const title of [
        'Operations by type',
        'Connections',
        'Network',
        'Memory',
        'Queued operations',
      ]) {
        fireEvent.click(screen.getByRole('button', { name: `Options for ${title}` }));
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Close panel' }));
      }

      const empty = await screen.findByTestId('dashboard-empty');
      expect(within(empty).getByText(/No panels to show/)).toBeInTheDocument();
      fireEvent.click(within(empty).getByRole('button', { name: 'Reset to default' }));
      await waitForGrid();
      expect(panelIds()).toHaveLength(5);
    },
    LONG_TIMEOUT_MS,
  );

  it(
    'loads the saved layout on open',
    async () => {
      const api = await connectedApi();
      const saved: DashboardLayout = { version: 1, panels: [{ id: 'asserts', w: 3, h: 1 }] };
      await api.rpc.layout.set({ key: KEY, value: saved });
      renderDashboard(api);
      await waitForGrid();
      expect(panelIds()).toEqual(['asserts']);
    },
    LONG_TIMEOUT_MS,
  );

  it(
    'keeps the layout on screen when a save fails',
    async () => {
      const api = await connectedApi();
      vi.spyOn(api.rpc.layout, 'set').mockRejectedValue(new Error('Storage is locked.'));
      renderDashboard(api);
      await waitForGrid();

      fireEvent.click(screen.getByRole('button', { name: 'Options for Memory' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Close panel' }));

      expect(
        await screen.findByText('The dashboard layout is not saved', {}, { timeout: 2000 }),
      ).toBeInTheDocument();
      expect(screen.getByText('Storage is locked.')).toBeInTheDocument();
      await act(async () => {
        await Promise.resolve();
      });
      expect(panelIds()).not.toContain('memory');
    },
    LONG_TIMEOUT_MS,
  );
});
