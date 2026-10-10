import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppRoot } from '../../AppRoot';
import { createMockUiApi } from '../../api/mock-rpc-client';
import type { MockToolsMode } from '../../api/mock-tools';
import { SettingsModal } from '../settings/SettingsModal';
import { DownloadToolsModal } from './DownloadToolsModal';

function settingsDecorator(tools: MockToolsMode) {
  return () => (
    <AppRoot
      api={createMockUiApi({ preset: 'unlocked', tools })}
      initialState={{ settingsOpen: true }}
    >
      <SettingsModal />
    </AppRoot>
  );
}

function scrollToTools() {
  document.getElementById('settings-tools')?.scrollIntoView({ block: 'start' });
}

const meta: Meta = { title: 'Tools/Settings section' };
export default meta;

type Story = StoryObj;

export const ToolsSection: Story = {
  render: settingsDecorator('ok'),
  play: scrollToTools,
};

/** The bundled install fails its check, so its row shows the reason. */
export const BrokenInstall: Story = {
  render: settingsDecorator('broken'),
  play: scrollToTools,
};

/** The download dialog with a version chosen. Press Download to watch the progress. */
export const DownloadInProgress: Story = {
  render: () => (
    <AppRoot api={createMockUiApi({ preset: 'unlocked' })}>
      <DownloadToolsModal
        opened
        onClose={() => undefined}
        onDone={() => undefined}
        presetVersion="100.15.0"
      />
    </AppRoot>
  ),
};
