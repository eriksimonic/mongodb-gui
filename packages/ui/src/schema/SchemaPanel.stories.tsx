import type { Meta, StoryObj } from '@storybook/react-vite';
import { fireEvent, within } from '@testing-library/react';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import { AppRoot } from '../AppRoot';
import { SchemaPanel } from './SchemaPanel';
import { MESSY_COLLECTION, MESSY_DATABASE, seedMessyCollection } from './schema-fixtures';

const meta: Meta<typeof SchemaPanel> = {
  title: 'Schema/SchemaPanel',
  component: SchemaPanel,
  args: { connectionId: localConnectionId, database: 'shop', collection: 'orders' },
  decorators: [
    (Story) => (
      <div style={{ height: 720, width: 1100, padding: 8 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

/** Presses Analyse once the panel is on screen. */
async function analyseOnOpen(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  fireEvent.click(await canvas.findByRole('button', { name: 'Analyse' }));
  await canvas.findByRole('table', { name: 'Fields' });
}

/** shop.orders: flat documents with a validator and one index, the usual shape of a collection. */
const typicalApi = createMockUiApi({ preset: 'unlocked' });

export const TypicalCollection: Story = {
  loaders: [
    async () => {
      await typicalApi.rpc.connections.connect({ id: localConnectionId });
      return {};
    },
  ],
  decorators: [
    (Story) => (
      <AppRoot api={typicalApi}>
        <Story />
      </AppRoot>
    ),
  ],
  play: async ({ canvasElement }) => {
    await analyseOnOpen(canvasElement);
  },
};

/** logs.app_logs: one level of fields and no nesting. */
const flatApi = createMockUiApi({ preset: 'unlocked' });

export const FlatCollection: Story = {
  args: { database: 'logs', collection: 'app_logs' },
  loaders: [
    async () => {
      await flatApi.rpc.connections.connect({ id: localConnectionId });
      return {};
    },
  ],
  decorators: [
    (Story) => (
      <AppRoot api={flatApi}>
        <Story />
      </AppRoot>
    ),
  ],
  play: async ({ canvasElement }) => {
    await analyseOnOpen(canvasElement);
  },
};

/** A collection with optional fields, mixed types and nested documents, with user opened. */
const messyApi = createMockUiApi({ preset: 'unlocked' });

export const SparseMessyCollection: Story = {
  args: { database: MESSY_DATABASE, collection: MESSY_COLLECTION },
  loaders: [
    async () => {
      await messyApi.rpc.connections.connect({ id: localConnectionId });
      await seedMessyCollection(messyApi);
      return {};
    },
  ],
  decorators: [
    (Story) => (
      <AppRoot api={messyApi}>
        <Story />
      </AppRoot>
    ),
  ],
  play: async ({ canvasElement }) => {
    await analyseOnOpen(canvasElement);
    fireEvent.click(within(canvasElement).getByRole('button', { name: 'Expand user' }));
  },
};
