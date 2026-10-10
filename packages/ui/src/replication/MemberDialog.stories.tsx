import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AppRoot } from '../AppRoot';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import { createReplicationStore } from './replication-store';
import { MemberDialog } from './MemberDialogs';

async function memberStore() {
  const api = createMockUiApi({ preset: 'unlocked', replication: true });
  await api.rpc.connections.connect({ id: localConnectionId });
  const store = createReplicationStore(api, localConnectionId);
  await store.getState().refresh();
  return { api, store };
}

const meta: Meta<typeof MemberDialog> = {
  title: 'Replication/AddMemberDialog',
  component: MemberDialog,
  args: { mode: { kind: 'add' }, setName: 'rs0', onClose: fn() },
  loaders: [async () => memberStore()],
  decorators: [
    (Story, context) => {
      const loaded = context.loaded as Awaited<ReturnType<typeof memberStore>>;
      return (
        <AppRoot api={loaded.api as UiApi}>
          <Story args={{ store: loaded.store }} />
        </AppRoot>
      );
    },
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
