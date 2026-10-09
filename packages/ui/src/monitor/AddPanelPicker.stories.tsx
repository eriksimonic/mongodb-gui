import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../AppRoot';
import { createMockUiApi } from '../api/mock-rpc-client';
import { AddPanelPicker } from './AddPanelPicker';

const api = createMockUiApi({ preset: 'unlocked' });

const meta: Meta<typeof AddPanelPicker> = {
  title: 'Monitor/AddPanelPicker',
  component: AddPanelPicker,
  args: {
    opened: true,
    onClose: () => undefined,
    onAdd: () => undefined,
    addedIds: new Set(['operations-by-type', 'connections', 'network', 'memory', 'queues']),
    // A standalone server with WiredTiger: replica set panels show their reason as disabled.
    capabilities: { wiredTiger: true, replicaSet: false },
  },
  decorators: [
    (Story) => (
      <AppRoot api={api}>
        <Story />
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

/** The catalogue grouped by category. Panels already on the dashboard are marked, and the replica set panels say why they are off. */
export const Default: Story = {};

/** An empty dashboard. Every panel the connection supports can be added. */
export const EmptyDashboard: Story = {
  args: { addedIds: new Set() },
};
