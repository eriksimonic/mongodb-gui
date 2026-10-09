import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AppRoot } from '../../AppRoot';
import { localConnectionId } from '../../api/mock-fixtures';
import type { UiApi } from '../../api/ui-api';
import { connectedMockApi } from '../../api/connected-mock';
import { DocumentEditorDialog } from './DocumentEditorDialog';

const EDIT_TEXT = `{
  "_id": { "$oid": "000000000000000000000001" },
  "name": "orders-1",
  "status": "pending",
  "customerId": "C-1",
  "qty": 1
}
`;

const meta: Meta<typeof DocumentEditorDialog> = {
  title: 'Management/DocumentEditorDialog',
  component: DocumentEditorDialog,
  args: {
    connectionId: localConnectionId,
    database: 'shop',
    collection: 'orders',
    mode: 'edit',
    initialText: EDIT_TEXT,
    idEjson: '{"$oid":"000000000000000000000001"}',
    onClose: fn(),
  },
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

export const Edit: Story = {};

export const Insert: Story = {
  args: { mode: 'insert', initialText: '{}\n', idEjson: undefined },
};
