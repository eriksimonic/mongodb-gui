import type { ConnectionStatus } from '@mongo-gui/core';
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
  hosts: ['db-1:27017', 'db-2:27017', 'db-3:27017'],
};

function seededState(status: ConnectionStatus): Partial<AppData> {
  return { statuses: { [localConnectionId]: status } };
}

const standaloneApi = createMockUiApi({ preset: 'unlocked' });
const replicaSetApi = createMockUiApi({ preset: 'unlocked', replication: true });

async function openLocal(api: UiApi): Promise<Record<string, never>> {
  await api.rpc.connections.connect({ id: localConnectionId });
  return {};
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

/** A standalone server with live mock samples. Operations, memory and cache stay in range. */
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

/** A replica set. The lag card and the oplog window tile appear only here. */
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
