import type { Meta, StoryObj } from '@storybook/react-vite';
import type { UpdateState } from '@mongo-gui/core';
import { AppRoot } from '../../AppRoot';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { UpdateBanner } from './UpdateBanner';

const RELEASE_URL = 'https://github.com/eriksimonic/mongodb-mager/releases/tag/v0.2.0';
const BASE = { current: '0.1.0', canInstall: true };
const AVAILABLE = { version: '0.2.0', downloadUrl: RELEASE_URL };

/** Starts the mock updater on the given states, so each story shows one phase. */
function scripted(states: readonly UpdateState[]): Story {
  return {
    decorators: [
      (Story) => (
        <AppRoot api={createMockUiApi({ preset: 'unlocked', updates: { states } })}>
          <Story />
        </AppRoot>
      ),
    ],
  };
}

const meta: Meta<typeof UpdateBanner> = {
  title: 'Updates/UpdateBanner',
  component: UpdateBanner,
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Available: Story = scripted([{ ...BASE, phase: 'available', available: AVAILABLE }]);

export const NotifyOnly: Story = scripted([
  { ...BASE, canInstall: false, phase: 'notify-only', available: AVAILABLE },
]);

export const Downloading: Story = scripted([
  { ...BASE, phase: 'downloading', available: AVAILABLE, progress: { percent: 62 } },
]);

export const Downloaded: Story = scripted([{ ...BASE, phase: 'downloaded', available: AVAILABLE }]);

export const CheckFailed: Story = scripted([
  {
    ...BASE,
    phase: 'error',
    error: { code: 'INTERNAL', message: 'Could not check for updates.' },
  },
]);

export const Idle: Story = scripted([{ ...BASE, phase: 'idle' }]);
