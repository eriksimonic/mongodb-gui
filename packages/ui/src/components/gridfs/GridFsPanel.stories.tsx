import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../../AppRoot';
import { localConnectionId } from '../../api/mock-fixtures';
import type { UiApi } from '../../api/ui-api';
import { connectedMockApi } from '../../api/connected-mock';
import { GridFsPanel } from './GridFsPanel';

const meta: Meta<typeof GridFsPanel> = {
  title: 'GridFS/GridFsPanel',
  component: GridFsPanel,
  args: { connectionId: localConnectionId, database: 'shop', bucket: 'receipts' },
  parameters: { layout: 'fullscreen' },
  loaders: [async () => ({ api: await connectedMockApi() })],
  decorators: [
    (Story, context) => (
      <AppRoot api={context.loaded.api as UiApi}>
        <div style={{ height: '100vh' }}>
          <Story />
        </div>
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

/** Four receipts with metadata, and one row selected for download, rename or delete. */
export const Populated: Story = {};

export const Empty: Story = {
  args: { bucket: 'product_images_empty' },
};

/** A 5 MB upload running. Its progress bar and cancel button show above the table. */
export const Uploading: Story = {
  loaders: [
    async () => {
      const api = await connectedMockApi();
      await api.rpc.gridfs.startUpload({
        connectionId: localConnectionId,
        database: 'shop',
        bucket: 'receipts',
        path: '/mock/receipt-1005.pdf',
      });
      return { api };
    },
  ],
};
