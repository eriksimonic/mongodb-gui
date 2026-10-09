import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../AppRoot';
import { createMockUiApi } from '../api/mock-rpc-client';
import { ShellScreen } from './ShellScreen';

const meta: Meta<typeof ShellScreen> = {
  title: 'Screens/ShellScreen',
  component: ShellScreen,
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'unlocked' })}>
        <Story />
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Unlocked: Story = {};

/** The shell in the light scheme. The saved setting is set before the shell reads it. */
export const LightTheme: Story = {
  decorators: [
    (Story) => {
      const api = createMockUiApi({ preset: 'unlocked' });
      void api.rpc.settings.update({ theme: 'light' });
      return (
        <AppRoot api={api}>
          <Story />
        </AppRoot>
      );
    },
  ],
};
