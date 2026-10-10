import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../../AppRoot';
import { localConnectionId } from '../../api/mock-fixtures';
import type { UiApi } from '../../api/ui-api';
import { connectedMockApi } from '../../api/connected-mock';
import { GridFsBucketDialogs } from './GridFsBucketDialogs';

const meta: Meta<typeof GridFsBucketDialogs> = {
  title: 'GridFS/DropBucketDialog',
  component: GridFsBucketDialogs,
  loaders: [async () => ({ api: await connectedMockApi() })],
  decorators: [
    (Story, context) => (
      <AppRoot
        api={context.loaded.api as UiApi}
        initialState={{
          gridfsDialog: {
            kind: 'dropBucket',
            connectionId: localConnectionId,
            database: 'shop',
            bucket: 'product_images',
          },
        }}
      >
        <Story />
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

/** Drop the bucket of the shop database. The button stays disabled until the name is typed. */
export const DropBucket: Story = {};
