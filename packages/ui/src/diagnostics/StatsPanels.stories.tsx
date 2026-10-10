import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../AppRoot';
import { connectedMockApi } from '../api/connected-mock';
import { localConnectionId } from '../api/mock-fixtures';
import type { UiApi } from '../api/ui-api';
import { DatabaseStatsPanel } from './StatsPanels';

const databaseMeta: Meta<typeof DatabaseStatsPanel> = {
  title: 'Diagnostics/DatabaseStatsPanel',
  component: DatabaseStatsPanel,
  args: { connectionId: localConnectionId, database: 'shop' },
  loaders: [async () => ({ api: await connectedMockApi() })],
  decorators: [
    (Story, context) => (
      <AppRoot api={context.loaded.api as UiApi}>
        <Story />
      </AppRoot>
    ),
  ],
};

export default databaseMeta;

export const Database: StoryObj<typeof DatabaseStatsPanel> = {};
