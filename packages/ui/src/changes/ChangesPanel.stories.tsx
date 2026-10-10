import type { Meta, StoryObj } from '@storybook/react-vite';
import { fireEvent, within } from '@testing-library/react';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import { AppRoot } from '../AppRoot';
import { ChangesPanel } from './ChangesPanel';

const meta: Meta<typeof ChangesPanel> = {
  title: 'Changes/ChangesPanel',
  component: ChangesPanel,
  args: {
    panelId: 'changes:story',
    connectionId: localConnectionId,
    target: { kind: 'collection', database: 'shop', collection: 'orders' },
  },
  decorators: [
    (Story) => (
      <div style={{ height: 640, width: 1100, padding: 8 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

/** Waits for the first event rows after Start. The mock sends one event every half second. */
async function startAndWait(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  fireEvent.click(await canvas.findByRole('button', { name: 'Start' }));
  await canvas.findByRole('option', {}, { timeout: 4000 });
}

const liveApi = createMockUiApi({ preset: 'unlocked' });

/** shop.orders with a watch running. Events fill the list, newest first. */
export const Live: Story = {
  loaders: [
    async () => {
      await liveApi.rpc.connections.connect({ id: localConnectionId });
      return {};
    },
  ],
  decorators: [
    (Story) => (
      <AppRoot api={liveApi}>
        <Story />
      </AppRoot>
    ),
  ],
  play: async ({ canvasElement }) => {
    await startAndWait(canvasElement);
  },
};

const pausedApi = createMockUiApi({ preset: 'unlocked' });

/** The same watch paused. Events keep arriving in the pause buffer until Resume. */
export const Paused: Story = {
  loaders: [
    async () => {
      await pausedApi.rpc.connections.connect({ id: localConnectionId });
      return {};
    },
  ],
  decorators: [
    (Story) => (
      <AppRoot api={pausedApi}>
        <Story />
      </AppRoot>
    ),
  ],
  play: async ({ canvasElement }) => {
    await startAndWait(canvasElement);
    fireEvent.click(within(canvasElement).getByRole('button', { name: 'Pause' }));
  },
};

const errorApi = createMockUiApi({ preset: 'unlocked' });

/** A pipeline that writes to another collection. The server refuses it and the panel shows why. */
export const Error: Story = {
  args: {
    panelId: 'changes:story-error',
    target: { kind: 'database', database: 'shop' },
  },
  loaders: [
    async () => {
      await errorApi.rpc.connections.connect({ id: localConnectionId });
      return {};
    },
  ],
  decorators: [
    (Story) => (
      <AppRoot api={errorApi}>
        <Story />
      </AppRoot>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pipeline = await canvas.findByRole('textbox', { name: 'Change stream pipeline' });
    fireEvent.change(pipeline, { target: { value: '[{"$out": "archive"}]' } });
    fireEvent.click(canvas.getByRole('button', { name: 'Start' }));
    await canvas.findByText('$out is not allowed in a change stream pipeline');
  },
};
