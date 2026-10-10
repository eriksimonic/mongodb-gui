import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../AppRoot';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import { ReplicationPanel } from './ReplicationPanel';

async function memberApi(): Promise<UiApi> {
  const api = createMockUiApi({ preset: 'unlocked', replication: true });
  await api.rpc.connections.connect({ id: localConnectionId });
  return api;
}

async function uninitiatedApi(): Promise<UiApi> {
  const api = createMockUiApi({ preset: 'unlocked', replSetUninitiated: true });
  await api.rpc.connections.connect({ id: localConnectionId });
  return api;
}

const meta: Meta<typeof ReplicationPanel> = {
  title: 'Replication/ReplicationPanel',
  component: ReplicationPanel,
  args: { connectionId: localConnectionId },
  decorators: [
    (Story, context) => (
      <AppRoot api={context.loaded.api as UiApi}>
        <div style={{ height: 640 }}>
          <Story />
        </div>
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

export const ThreeMemberSet: Story = {
  loaders: [async () => ({ api: await memberApi() })],
};

export const Uninitiated: Story = {
  loaders: [async () => ({ api: await uninitiatedApi() })],
};
