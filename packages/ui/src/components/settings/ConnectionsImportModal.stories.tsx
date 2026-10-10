import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../../AppRoot';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { ConnectionsImportModal } from './ConnectionsImportModal';

/** The mock open dialog registers its file as picked, so the modal can read it. */
const PICKED_PATH = '/mock/orders.csv';

const meta: Meta<typeof ConnectionsImportModal> = {
  title: 'Settings/ConnectionsImportModal',
  component: ConnectionsImportModal,
  args: { path: PICKED_PATH, onClose: () => undefined },
  decorators: [
    (Story) => {
      const api = createMockUiApi({ preset: 'unlocked' });
      void api.rpc.app.showOpenDialog({ title: 'Choose a connections file', filters: [] });
      return (
        <AppRoot api={api}>
          <Story />
        </AppRoot>
      );
    },
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Open: Story = {};

export const Closed: Story = { args: { path: undefined } };
