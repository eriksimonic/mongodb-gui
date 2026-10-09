import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../../AppRoot';
import { createMockUiApi } from '../../api/mock-rpc-client';
import type { AppData } from '../../state/app-store';
import { ConnectionManager } from './ConnectionManager';

const meta: Meta<typeof ConnectionManager> = {
  title: 'Connections/ConnectionManager',
  component: ConnectionManager,
  decorators: [
    (Story) => (
      <AppRoot
        api={createMockUiApi({ preset: 'unlocked' })}
        initialState={{ managerOpen: true } satisfies Partial<AppData>}
      >
        <Story />
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

/** The saved connections with their redacted URIs, edit and delete buttons. */
export const Open: Story = {};
