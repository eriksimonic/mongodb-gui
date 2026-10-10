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

/** Opens the modal scrolled to one section, so each section has its own story. */
function sectionStory(id: string): Story {
  return {
    play: () => {
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
    },
  };
}

export const Appearance: Story = sectionStory('settings-appearance');
export const Security: Story = sectionStory('settings-security');
export const Connections: Story = sectionStory('settings-connections');
export const Updates: Story = sectionStory('settings-updates');
export const Data: Story = sectionStory('settings-data');
export const About: Story = sectionStory('settings-about');

/** The same modal with the light scheme saved in the settings. */
export const LightScheme: Story = {
  decorators: [
    (Story) => {
      const api = createMockUiApi({ preset: 'unlocked' });
      void api.rpc.settings.update({ theme: 'light' });
      return (
        <AppRoot api={api} initialState={{ settingsOpen: true }}>
          <Story />
        </AppRoot>
      );
    },
  ],
};
