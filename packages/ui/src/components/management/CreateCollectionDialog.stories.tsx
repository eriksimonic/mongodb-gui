import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AppRoot } from '../../AppRoot';
import { localConnectionId } from '../../api/mock-fixtures';
import type { UiApi } from '../../api/ui-api';
import { connectedMockApi } from '../../api/connected-mock';
import { CreateCollectionDialog } from './CreateCollectionDialog';

const meta: Meta<typeof CreateCollectionDialog> = {
  title: 'Management/CreateCollectionDialog',
  component: CreateCollectionDialog,
  args: { connectionId: localConnectionId, database: 'shop', onClose: fn() },
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
