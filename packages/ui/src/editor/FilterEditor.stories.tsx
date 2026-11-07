import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AppRoot } from '../AppRoot';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import { FilterEditor } from './FilterEditor';

const meta: Meta<typeof FilterEditor> = {
  title: 'Editor/FilterEditor',
  component: FilterEditor,
  args: {
    ariaLabel: 'Filter',
    value: '{"status": "paid"}',
    fields: { connectionId: localConnectionId, database: 'shop', collection: 'orders' },
    onChange: fn(),
  },
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'unlocked' })}>
        <div style={{ width: 480, padding: 16 }}>
          <Story />
        </div>
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

/** The caller's error under the editor, with the field names of the orders collection offered. */
export const Invalid: Story = {
  name: 'Invalid',
  args: { value: '{"status": ', error: 'The filter is not valid extended JSON.' },
};
