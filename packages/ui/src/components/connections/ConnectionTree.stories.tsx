import type { ConnectionStatus } from '@mongo-gui/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../../AppRoot';
import { localConnectionId, stagingConnectionId } from '../../api/mock-fixtures';
import { createMockUiApi } from '../../api/mock-rpc-client';
import type { AppData } from '../../state/app-store';
import { connectionNodeId, databaseNodeId } from '../../state/node-ids';
import { ConnectionTree } from './ConnectionTree';

const meta: Meta<typeof ConnectionTree> = {
  title: 'Connections/ConnectionTree',
  component: ConnectionTree,
  decorators: [
    (Story) => (
      <div style={{ width: 280, padding: 8 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

const connectedStatus: ConnectionStatus = {
  state: 'connected',
  serverVersion: '8.0.4',
  topology: 'standalone',
  hosts: ['localhost:27017'],
};

/** The connection list never arrives, so the tree stays in its loading state. */
export const Loading: Story = {
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'unlocked', latencyMs: 60_000 })}>
        <Story />
      </AppRoot>
    ),
  ],
};

/** The local connection is open, with the shop database expanded. The loader opens it in the mock. */
const expandedApi = createMockUiApi({ preset: 'unlocked' });
const expandedState: Partial<AppData> = {
  statuses: { [localConnectionId]: connectedStatus },
  expanded: {
    [connectionNodeId(localConnectionId)]: true,
    [databaseNodeId(localConnectionId, 'shop')]: true,
  },
};

export const Expanded: Story = {
  loaders: [
    async () => {
      await expandedApi.rpc.connections.connect({ id: localConnectionId });
      return {};
    },
  ],
  decorators: [
    (Story) => (
      <AppRoot api={expandedApi} initialState={expandedState}>
        <Story />
      </AppRoot>
    ),
  ],
};

/** The staging connection failed to authenticate. Its error shows under the connection. */
const errorState: Partial<AppData> = {
  statuses: {
    [stagingConnectionId]: {
      state: 'error',
      error: {
        code: 'AUTH_FAILED',
        message: 'Authentication failed',
        detail: 'Check the user name and password',
      },
    },
  },
  expanded: { [connectionNodeId(stagingConnectionId)]: true },
};

export const ConnectionError: Story = {
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'unlocked' })} initialState={errorState}>
        <Story />
      </AppRoot>
    ),
  ],
};

/** The Docker node lists a container with a published port and one that connects through a forwarder. */
export const DockerContainers: Story = {
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'unlocked' })}>
        <Story />
      </AppRoot>
    ),
  ],
};

/** The engine cannot be reached. The Docker node shows the reason and no containers. */
export const DockerUnavailable: Story = {
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'unlocked', docker: 'unavailable' })}>
        <Story />
      </AppRoot>
    ),
  ],
};
