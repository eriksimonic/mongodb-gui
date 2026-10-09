import type { ConnectionStatus, DashboardLayout } from '@mongo-gui/core';
import { dashboardLayoutKey } from '@mongo-gui/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../AppRoot';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import type { AppData } from '../state/app-store';
import { MonitorDashboard } from './MonitorDashboard';

const CONNECTED: ConnectionStatus = {
  state: 'connected',
  serverVersion: '8.0.4',
  topology: 'standalone',
  hosts: ['localhost:27017'],
};

const REPLICA_CONNECTED: ConnectionStatus = {
  state: 'connected',
  serverVersion: '8.0.4',
  topology: 'replicaSet',
  setName: 'rs0',
  hosts: ['db-1:27017', 'db-2:27017', 'db-3:27017'],
};

/** WiredTiger and transaction panels, as an operator would compose them for a write-heavy server. */
const WIREDTIGER_LAYOUT: DashboardLayout = {
  version: 1,
  panels: [
    { id: 'wt-cache', w: 2, h: 1 },
    { id: 'wt-cache-fill', w: 1, h: 1 },
    { id: 'tickets', w: 1, h: 1 },
    { id: 'transactions-open', w: 1, h: 1 },
    { id: 'transactions-rate', w: 2, h: 1 },
    { id: 'wt-pages', w: 1, h: 1 },
    { id: 'block-io', w: 2, h: 1 },
    { id: 'operations-by-type', w: 2, h: 2 },
  ],
};

function seededState(status: ConnectionStatus): Partial<AppData> {
  return { statuses: { [localConnectionId]: status } };
}

const standaloneApi = createMockUiApi({ preset: 'unlocked' });
const replicaSetApi = createMockUiApi({ preset: 'unlocked', replication: true });
const customApi = createMockUiApi({ preset: 'unlocked' });

async function openLocal(api: UiApi): Promise<Record<string, never>> {
  await api.rpc.connections.connect({ id: localConnectionId });
  return {};
}

async function openWith(api: UiApi, layout: DashboardLayout): Promise<Record<string, never>> {
  await api.rpc.layout.set({ key: dashboardLayoutKey(localConnectionId), value: layout });
  return openLocal(api);
}

const meta: Meta<typeof MonitorDashboard> = {
  title: 'Monitor/MonitorDashboard',
  component: MonitorDashboard,
  args: { connectionId: localConnectionId },
  decorators: [
    (Story) => (
      <div style={{ height: '100vh', overflow: 'auto' }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

/** A standalone server with the six default panels. Replication lag is hidden here. */
export const Standalone: Story = {
  loaders: [() => openLocal(standaloneApi)],
  decorators: [
    (Story) => (
      <AppRoot api={standaloneApi} initialState={seededState(CONNECTED)}>
        <Story />
      </AppRoot>
    ),
  ],
};

/** A replica set. The default layout includes the replication lag panel, which appears here. */
export const ReplicaSet: Story = {
  loaders: [() => openLocal(replicaSetApi)],
  decorators: [
    (Story) => (
      <AppRoot api={replicaSetApi} initialState={seededState(REPLICA_CONNECTED)}>
        <Story />
      </AppRoot>
    ),
  ],
};

/** A saved layout with the WiredTiger cache, tickets, transactions and block manager panels. */
export const WiredTigerAndTransactions: Story = {
  loaders: [() => openWith(customApi, WIREDTIGER_LAYOUT)],
  decorators: [
    (Story) => (
      <AppRoot api={customApi} initialState={seededState(CONNECTED)}>
        <Story />
      </AppRoot>
    ),
  ],
};
