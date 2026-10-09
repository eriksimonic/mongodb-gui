import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../AppRoot';
import { createMockUiApi } from '../api/mock-rpc-client';
import { FirstRunScreen } from './FirstRunScreen';

const meta: Meta<typeof FirstRunScreen> = {
  title: 'Screens/FirstRunScreen',
  component: FirstRunScreen,
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'fresh' })}>
        <Story />
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
