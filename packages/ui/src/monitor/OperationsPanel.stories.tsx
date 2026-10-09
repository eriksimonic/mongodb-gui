import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../AppRoot';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import { OperationsPanel } from './OperationsPanel';

const meta: Meta<typeof OperationsPanel> = {
  title: 'Monitor/OperationsPanel',
  component: OperationsPanel,
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

const openApi = createMockUiApi({ preset: 'unlocked' });

/** The local connection is open. The long aggregation on shop.events is the one to kill. */
export const Running: Story = {
  loaders: [
    async () => {
      await openApi.rpc.connections.connect({ id: localConnectionId });
      return {};
    },
  ],
  decorators: [
    (Story) => (
      <AppRoot api={openApi}>
        <Story />
      </AppRoot>
    ),
  ],
};

const closedApi = createMockUiApi({ preset: 'unlocked' });

/** The connection is not open, so the list shows the server's refusal instead of rows. */
export const NotConnected: Story = {
  decorators: [
    (Story) => (
      <AppRoot api={closedApi}>
        <Story />
      </AppRoot>
    ),
  ],
};
