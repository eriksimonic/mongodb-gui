import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../AppRoot';
import { connectedMockApi } from '../api/connected-mock';
import { localConnectionId } from '../api/mock-fixtures';
import type { UiApi } from '../api/ui-api';
import { DiagnosticsPanel } from './DiagnosticsPanel';

const meta: Meta<typeof DiagnosticsPanel> = {
  title: 'Diagnostics/DiagnosticsPanel',
  component: DiagnosticsPanel,
  args: { connectionId: localConnectionId, initialTab: 'logs' },
  loaders: [async () => ({ api: await connectedMockApi() })],
  decorators: [
    (Story, context) => (
      <AppRoot api={context.loaded.api as UiApi}>
        <Story />
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Logs: Story = {};

export const StartupWarnings: Story = { args: { initialTab: 'warnings' } };

export const Parameters: Story = { args: { initialTab: 'parameters' } };

export const ServerStatus: Story = { args: { initialTab: 'status' } };

export const HostAndBuild: Story = { args: { initialTab: 'host' } };

export const Top: Story = { args: { initialTab: 'top' } };

export const ConnectionPools: Story = { args: { initialTab: 'pools' } };

export const Sessions: Story = { args: { initialTab: 'sessions' } };
