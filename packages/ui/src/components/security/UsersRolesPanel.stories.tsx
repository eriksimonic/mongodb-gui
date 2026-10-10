import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../../AppRoot';
import { localConnectionId } from '../../api/mock-fixtures';
import type { UiApi } from '../../api/ui-api';
import { connectedMockApi } from '../../api/connected-mock';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { UsersRolesPanel } from './UsersRolesPanel';

const meta: Meta<typeof UsersRolesPanel> = {
  title: 'Security/UsersRolesPanel',
  component: UsersRolesPanel,
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

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** A signed-in user with no user or role rights. Every control reads disabled, with its reason on hover. */
const viewerApi = createMockUiApi({ preset: 'unlocked', security: 'viewer' });

export const ViewerRights: Story = {
  loaders: [
    async () => {
      await viewerApi.rpc.connections.connect({ id: localConnectionId });
      return { api: viewerApi };
    },
  ],
};
