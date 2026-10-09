import { Box, Button, Group, Popover, Progress, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { UpdateState } from '@mongo-gui/core';
import { useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { runReported } from '../notify-error';
import { useAppStore } from '../../state/app-store-context';

/** Below this window width the release notes button is hidden to keep the toolbar on one line. */
const COMPACT_QUERY = '(max-width: 1099px)';

/**
 * A slim notice in the toolbar. It shows nothing unless an update is available, downloading,
 * ready to install, or a check failed.
 */
export function UpdateBanner() {
  const updates = useAppStore((state) => state.updates);
  const checkForUpdates = useAppStore((state) => state.checkForUpdates);
  const downloadUpdate = useAppStore((state) => state.downloadUpdate);
  const installUpdate = useAppStore((state) => state.installUpdate);
  const dismissUpdate = useAppStore((state) => state.dismissUpdate);
  const { rpc } = useUiApi();
  const compact = useMediaQuery(COMPACT_QUERY) === true;

  const openLink = (url: string) => runReported(() => rpc.app.openExternal({ url }));

  switch (updates.phase) {
    case 'available': {
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
          {compact ? null : (
            <ReleaseNotesButton url={available.downloadUrl} notes={available.notes} />
          )}
          <Button variant="light" onClick={() => void runReported(() => downloadUpdate())}>
            Download
          </Button>
          <Button variant="subtle" onClick={() => void runReported(() => dismissUpdate(version))}>
            Dismiss
          </Button>
        </Group>
      );
    }
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
          <Button variant="light" onClick={() => void openLink(available.downloadUrl)}>
            Download from GitHub
          </Button>
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
    case 'error': {
      // A failed download keeps its offer, so Retry downloads again. A failed check retries the check.
      const retryDownload = updates.available !== undefined && updates.canInstall;
      return (
        <Group gap={6} wrap="nowrap" role="alert">
          <Text size="sm" c="red">
            {errorMessage(updates)}
          </Text>
          <Button
            variant="subtle"
            onClick={() =>
              void runReported(() => (retryDownload ? downloadUpdate() : checkForUpdates()))
            }
          >
            Retry
          </Button>
        </Group>
      );
    }
    default:
      return null;
  }
}

interface ReleaseNotesButtonProps {
  readonly url: string;
  readonly notes: string | undefined;
}

/**
 * Shows the release notes as plain text in a popover. Without notes, the button opens the
 * release page instead.
 */
function ReleaseNotesButton({ url, notes }: ReleaseNotesButtonProps) {
  const { rpc } = useUiApi();
  const [opened, setOpened] = useState(false);
  const openPage = () => runReported(() => rpc.app.openExternal({ url }));

  if (notes === undefined || notes.trim() === '') {
    return (
      <Button variant="subtle" onClick={() => void openPage()}>
        Release notes
      </Button>
    );
  }

  return (
    <Popover opened={opened} onChange={setOpened} width={360} position="bottom-start" shadow="md">
      <Popover.Target>
        <Button variant="subtle" onClick={() => setOpened((current) => !current)}>
          Release notes
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Box mah={320} style={{ overflowY: 'auto' }}>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {notes}
          </Text>
        </Box>
        <Button variant="subtle" mt={8} onClick={() => void openPage()}>
          Open on GitHub
        </Button>
      </Popover.Dropdown>
    </Popover>
  );
}

function errorMessage(updates: UpdateState): string {
  return updates.error?.message ?? 'Could not check for updates.';
}
