import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../../AppRoot';
import { localConnectionId } from '../../api/mock-fixtures';
import { createMockUiApi } from '../../api/mock-rpc-client';
import type { UiApi } from '../../api/ui-api';
import { ShardCollectionDialog } from './ShardCollectionDialog';

const meta: Meta<typeof ShardCollectionDialog> = {
  title: 'Sharding/ShardCollectionDialog',
  component: ShardCollectionDialog,
  args: {
    connectionId: localConnectionId,
    database: 'shop',
    collection: 'sensor_readings',
    onClose: () => undefined,
  },
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

const clusterApi = createMockUiApi({ preset: 'unlocked', sharding: 'cluster' });

export const Default: Story = {
  loaders: [
    async () => {
      await clusterApi.rpc.connections.connect({ id: localConnectionId });
      return { api: clusterApi };
    },
  ],
};
