import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { AppRoot } from '../AppRoot';
import { createMockUiApi } from '../api/mock-rpc-client';
import { UnlockScreen } from './UnlockScreen';

const meta: Meta<typeof UnlockScreen> = {
  title: 'Screens/UnlockScreen',
  component: UnlockScreen,
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

export const Default: Story = {};

export const WrongPassword: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Master password'), 'not the password');
    await userEvent.click(canvas.getByRole('button', { name: 'Unlock' }));
    await expect(await canvas.findByText('Wrong master password. Try again.')).toBeInTheDocument();
  },
};
