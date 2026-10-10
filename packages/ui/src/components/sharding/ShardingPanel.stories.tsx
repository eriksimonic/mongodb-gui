import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../../AppRoot';
import { localConnectionId } from '../../api/mock-fixtures';
import { createMockUiApi } from '../../api/mock-rpc-client';
import type { UiApi } from '../../api/ui-api';
import { ShardingPanel } from './ShardingPanel';

const meta: Meta<typeof ShardingPanel> = {
  title: 'Sharding/ShardingPanel',
  component: ShardingPanel,
  args: { connectionId: localConnectionId },
  decorators: [
    (Story, context) => (
      <AppRoot api={context.loaded.api as UiApi}>
        <Story />
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

/** A seeded two-shard cluster with one sharded database, two sharded collections and a zone. */
const clusterApi = createMockUiApi({ preset: 'unlocked', sharding: 'cluster' });

export const Cluster: Story = {
  loaders: [
    async () => {
      await clusterApi.rpc.connections.connect({ id: localConnectionId });
      return { api: clusterApi };
    },
  ],
};

/** A standalone server. The panel says sharding is not available and shows no tabs. */
const standaloneApi = createMockUiApi({ preset: 'unlocked' });

export const Standalone: Story = {
  loaders: [
    async () => {
      await standaloneApi.rpc.connections.connect({ id: localConnectionId });
      return { api: standaloneApi };
    },
  ],
};
