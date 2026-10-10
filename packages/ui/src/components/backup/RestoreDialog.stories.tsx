import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn, userEvent, within } from 'storybook/test';
import { AppRoot } from '../../AppRoot';
import { localConnectionId } from '../../api/mock-fixtures';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { RestoreDialogBody } from './RestoreDialog';

const meta: Meta<typeof RestoreDialogBody> = {
  title: 'Backup/RestoreDialog',
  component: RestoreDialogBody,
  args: { connectionId: localConnectionId, onClose: fn() },
  decorators: [
    (Story, context) => (
      <AppRoot
        api={createMockUiApi({
          preset: 'unlocked',
          ...(context.name === 'Tools mismatch' ? { tools: 'mismatch' as const } : {}),
        })}
      >
        <div style={{ width: 720, padding: 16 }}>
          <Story />
        </div>
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

async function pick(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: 'Choose archive…' }));
  await canvas.findByTestId('restore-summary');
  return canvas;
}

/** A backup made by Mongo GUI, with one database renamed on restore. */
export const WithSidecarAndRename: Story = {
  name: 'With sidecar and rename',
  play: async ({ canvasElement }) => {
    const canvas = await pick(canvasElement);
    const field = await canvas.findByLabelText('Restore shop as');
    await userEvent.clear(field);
    await userEvent.type(field, 'shop_copy');
  },
};

/** Only 100.19.1 is installed and the backup was made with 100.12.1. */
export const ToolsMismatch: Story = {
  name: 'Tools mismatch',
  play: async ({ canvasElement }) => {
    await pick(canvasElement);
  },
};

/** The form before any backup is chosen. */
export const NoBackupChosen: Story = { name: 'No backup chosen' };
