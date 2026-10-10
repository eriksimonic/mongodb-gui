import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../AppRoot';
import { connectedMockApi } from '../api/connected-mock';
import { localConnectionId } from '../api/mock-fixtures';
import type { UiApi } from '../api/ui-api';
import { CollectionStatsPanel } from './StatsPanels';

const meta: Meta<typeof CollectionStatsPanel> = {
  title: 'Diagnostics/CollectionStatsPanel',
  component: CollectionStatsPanel,
  args: { connectionId: localConnectionId, database: 'shop', collection: 'orders' },
  loaders: [async () => ({ api: await connectedMockApi() })],
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

export const Default: Story = {};
