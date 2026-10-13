import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn, userEvent, waitFor, within } from 'storybook/test';
import { AppRoot } from '../AppRoot';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import { BackupDialogBody } from './BackupDialog';

const meta: Meta<typeof BackupDialogBody> = {
  title: 'Backup/BackupDialog',
  component: BackupDialogBody,
  args: { connectionId: localConnectionId, database: 'shop', onClose: fn() },
  decorators: [
    (Story, context) => (
      <AppRoot
        api={createMockUiApi({
          preset: 'unlocked',
          ...(context.name === 'With findings' ? { sharding: 'cluster' as const } : {}),
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

/** The form for one database with the defaults and no folder chosen yet. */
export const Form: Story = {};

/** A sharded cluster adds a warning above the footer. */
export const WithFindings: Story = { name: 'With findings' };

async function start(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: 'Choose folder…' }));
  const button = await canvas.findByRole('button', { name: 'Start backup' });
  await waitFor(() => {
    if (button.hasAttribute('disabled')) {
      throw new Error('Start is still disabled');
    }
  });
  await userEvent.click(button);
  return canvas;
}

/** The progress view while the job runs. */
export const Running: Story = {
  play: async ({ canvasElement }) => {
    await start(canvasElement);
  },
};

/** The result after the job finishes. */
export const Done: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await start(canvasElement);
    await canvas.findByText('Backup finished', undefined, { timeout: 15000 });
  },
};
