import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AppRoot } from '../../AppRoot';
import { localConnectionId } from '../../api/mock-fixtures';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { ExportDialogBody } from './ExportDialog';

const meta: Meta<typeof ExportDialogBody> = {
  title: 'Transfers/ExportDialog',
  component: ExportDialogBody,
  args: {
    connectionId: localConnectionId,
    database: 'shop',
    collection: 'orders',
    onClose: fn(),
  },
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'unlocked' })}>
        <div style={{ width: 640, padding: 16 }}>
          <Story />
        </div>
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

/** The export form with the default NDJSON format and no file chosen yet. */
export const Form: Story = {};
