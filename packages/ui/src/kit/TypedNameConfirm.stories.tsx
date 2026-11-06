import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn, userEvent, within } from 'storybook/test';
import { AppRoot } from '../AppRoot';
import { createMockUiApi } from '../api/mock-rpc-client';
import { TypedNameConfirm } from './TypedNameConfirm';

const meta: Meta<typeof TypedNameConfirm> = {
  title: 'Kit/TypedNameConfirm',
  component: TypedNameConfirm,
  args: { expected: 'shop', onMatchChange: fn() },
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'unlocked' })}>
        <div style={{ width: 440, padding: 16 }}>
          <Story />
        </div>
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

/** The expected name typed in full, so the host reports a match. */
export const NameTyped: Story = {
  name: 'Name typed',
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText('Type shop to confirm'), args.expected);
  },
};
