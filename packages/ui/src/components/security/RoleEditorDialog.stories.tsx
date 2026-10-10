import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AppRoot } from '../../AppRoot';
import { localConnectionId } from '../../api/mock-fixtures';
import type { UiApi } from '../../api/ui-api';
import { connectedMockApi } from '../../api/connected-mock';
import { createSecurityStore, type SecurityStore } from '../../security/security-store';
import { RoleEditorDialog } from './RoleEditorDialog';

interface Loaded {
  readonly api: UiApi;
  readonly store: SecurityStore;
}

const meta: Meta<typeof RoleEditorDialog> = {
  title: 'Security/RoleEditorDialog',
  component: RoleEditorDialog,
  args: { store: undefined as unknown as SecurityStore, database: 'shop', onClose: fn() },
  loaders: [
    async (): Promise<Loaded> => {
      const api = await connectedMockApi();
      const store = createSecurityStore(
        { connectionId: localConnectionId, database: 'shop' },
        api.rpc.security,
      );
      await store.getState().load();
      return { api, store };
    },
  ],
  decorators: [
    (Story, context) => (
      <AppRoot api={(context.loaded as Loaded).api}>
        <Story />
      </AppRoot>
    ),
  ],
  render: (args, context) => (
    <RoleEditorDialog {...args} store={(context.loaded as Loaded).store} />
  ),
};

export default meta;

type Story = StoryObj<typeof meta>;

export const NewRole: Story = {};

export const EditCustomRole: Story = {
  args: {
    role: {
      id: 'shop.analyst',
      role: 'analyst',
      db: 'shop',
      isBuiltin: false,
      roles: [{ role: 'read', db: 'shop' }],
      privileges: [
        { resource: { db: 'shop', collection: 'orders' }, actions: ['find', 'listIndexes'] },
      ],
      authenticationRestrictions: [],
    },
  },
};

export const BuiltinRoleReadOnly: Story = {
  args: {
    role: {
      id: 'shop.readWrite',
      role: 'readWrite',
      db: 'shop',
      isBuiltin: true,
      roles: [],
      privileges: [],
      authenticationRestrictions: [],
    },
  },
};
