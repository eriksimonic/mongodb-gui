import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../AppRoot';
import { createMockUiApi } from '../api/mock-rpc-client';
import { ShortcutsModal } from './ShortcutsModal';

const meta: Meta<typeof ShortcutsModal> = {
  title: 'Shortcuts/ShortcutsModal',
  component: ShortcutsModal,
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'unlocked' })} initialState={{ shortcutsOpen: true }}>
        <Story />
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Open: Story = {};
