import type { Meta, StoryObj } from '@storybook/react-vite';
import type { IDockviewPanelProps } from 'dockview-react';
import { AppRoot } from '../AppRoot';
import { createMockUiApi } from '../api/mock-rpc-client';
import { WelcomePanel } from './ShellPanels';

/** The dock props the panel reads. Only containerApi is used, for the Docker action. */
const DOCK_PROPS = {
  containerApi: { getPanel: () => undefined },
} as unknown as IDockviewPanelProps;

const meta: Meta<typeof WelcomePanel> = {
  title: 'Screens/WelcomePanel',
  component: WelcomePanel,
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'unlocked' })}>
        <div style={{ height: 620 }}>
          <Story />
        </div>
      </AppRoot>
    ),
  ],
  render: () => <WelcomePanel {...DOCK_PROPS} />,
};

export default meta;

type Story = StoryObj<typeof meta>;

export const WithConnections: Story = {};
