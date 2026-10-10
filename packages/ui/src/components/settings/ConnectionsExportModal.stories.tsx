import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../../AppRoot';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { ConnectionsExportModal } from './ConnectionsExportModal';

const meta: Meta<typeof ConnectionsExportModal> = {
  title: 'Settings/ConnectionsExportModal',
  component: ConnectionsExportModal,
  args: { opened: true, onClose: () => undefined },
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'unlocked' })}>
        <Story />
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Open: Story = {};
