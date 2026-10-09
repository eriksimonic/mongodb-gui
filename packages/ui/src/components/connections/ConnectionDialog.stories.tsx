import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AppRoot } from '../../AppRoot';
import { localConnectionId } from '../../api/mock-fixtures';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { ConnectionDialog } from './ConnectionDialog';

const meta: Meta<typeof ConnectionDialog> = {
  title: 'Connections/ConnectionDialog',
  component: ConnectionDialog,
  args: { onClose: fn(), connectionId: undefined },
};

export default meta;

type Story = StoryObj<typeof meta>;

export const UriMode: Story = {
  args: { initialMode: 'uri' },
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'unlocked' })}>
        <Story />
      </AppRoot>
    ),
  ],
};

export const FormMode: Story = {
  args: { initialMode: 'form' },
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'unlocked' })}>
        <Story />
      </AppRoot>
    ),
  ],
};

export const EditExisting: Story = {
  args: { connectionId: localConnectionId, initialMode: 'uri' },
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'unlocked' })}>
        <Story />
      </AppRoot>
    ),
  ],
};
