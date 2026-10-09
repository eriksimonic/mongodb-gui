import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../../AppRoot';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { SettingsModal } from './SettingsModal';

const meta: Meta<typeof SettingsModal> = {
  title: 'Settings/SettingsModal',
  component: SettingsModal,
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'unlocked' })} initialState={{ settingsOpen: true }}>
        <Story />
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Open: Story = {};
