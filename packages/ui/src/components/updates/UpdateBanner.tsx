import { Button, Group, Progress, Text } from '@mantine/core';
import type { UpdateState } from '@mongo-gui/core';
import { useUiApi } from '../../api/ui-api';
import { runReported } from '../notify-error';
import { useAppStore } from '../../state/app-store-context';

/**
 * A slim notice in the toolbar. It shows nothing unless an update is available, downloading,
 * ready to install, or a check failed with a manual check.
 */
export function UpdateBanner() {
  const updates = useAppStore((state) => state.updates);
  const checkForUpdates = useAppStore((state) => state.checkForUpdates);
  const downloadUpdate = useAppStore((state) => state.downloadUpdate);
  const installUpdate = useAppStore((state) => state.installUpdate);
  const dismissUpdate = useAppStore((state) => state.dismissUpdate);
  const { rpc } = useUiApi();

  const openLink = (url: string) => runReported(() => rpc.app.openExternal({ url }));

  switch (updates.phase) {
    case 'available':
    case 'notify-only': {
      const available = updates.available;
      if (available === undefined) {
        return null;
      }
      const version = available.version;
      return (
        <Group gap={6} wrap="nowrap" role="status" aria-live="polite">
          <Text size="sm" fw={500}>
            {`Version ${version} is available`}
          </Text>
          <Button variant="subtle" onClick={() => void openLink(available.downloadUrl)}>
            Release notes
          </Button>
          {updates.phase === 'available' ? (
            <Button variant="light" onClick={() => void runReported(() => downloadUpdate())}>
              Download
            </Button>
          ) : (
            <Button variant="light" onClick={() => void openLink(available.downloadUrl)}>
              Download from GitHub
            </Button>
          )}
          <Button variant="subtle" onClick={() => void runReported(() => dismissUpdate(version))}>
            Dismiss
          </Button>
        </Group>
      );
    }
    case 'downloading': {
      const percent = Math.round(updates.progress?.percent ?? 0);
      return (
        <Group gap={8} wrap="nowrap" role="status" aria-live="polite">
          <Text size="sm">{`Downloading version ${updates.available?.version ?? ''}, ${percent}%`}</Text>
          <Progress value={percent} w={160} size="sm" aria-label="Download progress" />
        </Group>
      );
    }
    case 'downloaded': {
      const version = updates.available?.version ?? '';
      return (
        <Group gap={6} wrap="nowrap" role="status" aria-live="polite">
          <Text size="sm" fw={500}>
            {`Version ${version} is ready to install`}
          </Text>
          <Button variant="light" onClick={() => void runReported(() => installUpdate())}>
            Restart to update
          </Button>
          <Button variant="subtle" onClick={() => void runReported(() => dismissUpdate(version))}>
            Later
          </Button>
        </Group>
      );
    }
    case 'error':
      return (
        <Group gap={6} wrap="nowrap" role="alert">
          <Text size="sm" c="red">
            {errorMessage(updates)}
          </Text>
          <Button variant="subtle" onClick={() => void runReported(() => checkForUpdates())}>
            Retry
          </Button>
        </Group>
      );
    default:
      return null;
  }
}

function errorMessage(updates: UpdateState): string {
  return updates.error?.message ?? 'Could not check for updates.';
}
