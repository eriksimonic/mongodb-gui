import type { Meta, StoryObj } from '@storybook/react-vite';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import { AppRoot } from '../AppRoot';
import { ProfilerPanel } from './ProfilerPanel';

const meta: Meta<typeof ProfilerPanel> = {
  title: 'Profiler/ProfilerPanel',
  component: ProfilerPanel,
  args: { connectionId: localConnectionId, database: 'shop' },
  decorators: [
    (Story) => (
      <div style={{ height: 640, width: 1100, padding: 8 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

/** The shop database at level 1 with fixture rows across shop.orders and shop.customers. */
const withEntriesApi = createMockUiApi({ preset: 'unlocked' });

export const WithEntries: Story = {
  loaders: [
    async () => {
      await withEntriesApi.rpc.connections.connect({ id: localConnectionId });
      return {};
    },
  ],
  decorators: [
    (Story) => (
      <AppRoot api={withEntriesApi}>
        <Story />
      </AppRoot>
    ),
  ],
};

/** The logs database has no rows and its level is off. */
const emptyApi = createMockUiApi({ preset: 'unlocked' });

export const Empty: Story = {
  args: { database: 'logs' },
  loaders: [
    async () => {
      await emptyApi.rpc.connections.connect({ id: localConnectionId });
      return {};
    },
  ],
  decorators: [
    (Story) => (
      <AppRoot api={emptyApi}>
        <Story />
      </AppRoot>
    ),
  ],
};

/** Level 2 with the tail on. The warning about system.profile shows above the table. */
const tailApi = createMockUiApi({ preset: 'unlocked' });

export const TailOnLevelTwo: Story = {
  args: { seed: { tailEnabled: true, pollMs: 2000 } },
  loaders: [
    async () => {
      await tailApi.rpc.connections.connect({ id: localConnectionId });
      await tailApi.rpc.profiler.setLevel({
        connectionId: localConnectionId,
        database: 'shop',
        level: 2,
      });
      return {};
    },
  ],
  decorators: [
    (Story) => (
      <AppRoot api={tailApi}>
        <Story />
      </AppRoot>
    ),
  ],
};

/** The top shapes tab, opened on the shop database. */
const shapesApi = createMockUiApi({ preset: 'unlocked' });

export const ShapesTab: Story = {
  args: { seed: { tab: 'shapes' } },
  loaders: [
    async () => {
      await shapesApi.rpc.connections.connect({ id: localConnectionId });
      return {};
    },
  ],
  decorators: [
    (Story) => (
      <AppRoot api={shapesApi}>
        <Story />
      </AppRoot>
    ),
  ],
};
