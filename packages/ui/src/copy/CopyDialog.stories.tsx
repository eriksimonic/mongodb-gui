import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AppRoot } from '../AppRoot';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import { CopyDialog } from './CopyDialog';

const meta: Meta<typeof CopyDialog> = {
  title: 'Copy/CopyDialog',
  component: CopyDialog,
  args: {
    sourceConnectionId: localConnectionId,
    sourceDatabase: 'shop',
    variant: 'one',
    collections: ['orders'],
    onStarted: fn(),
    onClose: fn(),
  },
  decorators: [
    (Story) => {
      const api = createMockUiApi({ preset: 'unlocked' });
      void api.rpc.connections.connect({ id: localConnectionId });
      return (
        <AppRoot api={api}>
          <div style={{ width: 900, padding: 16 }}>
            <Story />
          </div>
        </AppRoot>
      );
    },
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

/** One collection. The target name defaults to the source name. */
export const OneCollection: Story = {};

/** Several collections, each with a checkbox. All start checked. */
export const SeveralCollections: Story = {
  args: { variant: 'many', collections: ['orders', 'users', 'products'] },
};

/** A whole database. Every collection in it is offered. */
export const WholeDatabase: Story = {
  args: { variant: 'database', collections: ['orders', 'users', 'products', 'carts'] },
};
