import { Alert, Button, Group, Modal, Progress, Select, Stack, Text } from '@mantine/core';
import type { ToolsAvailableOutput, ToolsVersion } from '@mongo-gui/core';
import { useEffect, useRef, useState } from 'react';
import { useUiApi } from '../api/ui-api';
import { formatBytes } from '../diagnostics';
import { errorText, runReported } from '../kit/notify-error';
import { useMongoTools } from './use-mongo-tools';

interface DownloadToolsModalProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  /** Selected when the modal opens, for example the version a compatibility finding asks for. */
  readonly presetVersion?: ToolsVersion | undefined;
  /** Called once the version is installed and checked. */
  readonly onDone: (version: ToolsVersion) => void;
}

const PHASE_LABEL = {
  downloading: 'Downloading',
  verifying: 'Verifying the download',
  extracting: 'Extracting',
  checking: 'Checking the tools run',
} as const;

/** Picks a version from the MongoDB feed and downloads it, with progress and cancel. */
export function DownloadToolsModal(props: DownloadToolsModalProps) {
  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      title="Download MongoDB Database Tools"
      centered
    >
      {props.opened ? <DownloadBody {...props} /> : null}
    </Modal>
  );
}

function DownloadBody({ onClose, presetVersion, onDone }: DownloadToolsModalProps) {
  const { rpc } = useUiApi();
  const { downloads } = useMongoTools();
  const [feed, setFeed] = useState<ToolsAvailableOutput | undefined>(undefined);
  const [version, setVersion] = useState<string | null>(presetVersion ?? null);
  const [downloadId, setDownloadId] = useState<string | undefined>(undefined);
  const [startError, setStartError] = useState<string | undefined>(undefined);
  const reported = useRef(false);

  useEffect(() => {
    let active = true;
    void rpc.tools.available({ refresh: false }).then(
      (loaded) => {
        if (active) {
          setFeed(loaded);
        }
      },
      (failure: unknown) => {
        if (active) {
          setStartError(errorText(failure));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [rpc]);

  const state = downloadId === undefined ? undefined : downloads[downloadId];
  const progress = state?.progress;
  const finished =
    progress?.phase === 'done' || progress?.phase === 'cancelled' || progress?.phase === 'error';
  const busy = downloadId !== undefined && !finished;

  useEffect(() => {
    if (progress?.phase === 'done' && state !== undefined && !reported.current) {
      reported.current = true;
      onDone(state.version);
      onClose();
    }
  }, [progress?.phase, state, onDone, onClose]);

  async function start() {
    if (version === null) {
      return;
    }
    setStartError(undefined);
    try {
      const started = await rpc.tools.download({ version });
      setDownloadId(started.downloadId);
    } catch (failure) {
      setStartError(errorText(failure));
    }
  }

  const entry = feed?.versions.find((item) => item.version === version);
  const total = progress?.total ?? entry?.sizeBytes;
  const percent =
    progress === undefined || total === undefined || total === 0
      ? 0
      : Math.min(100, (progress.transferred / total) * 100);
  const error = startError ?? (progress?.phase === 'error' ? errorText(progress.error) : undefined);

  return (
    <Stack gap="sm">
      <Select
        label="Version"
        placeholder={feed === undefined ? 'Loading versions' : 'Choose a version'}
        data={(feed?.versions ?? []).map((item) => ({
          value: item.version,
          label: item.installed ? `${item.version} (installed)` : item.version,
          disabled: item.installed,
        }))}
        value={version}
        onChange={setVersion}
        disabled={busy}
        allowDeselect={false}
      />
      {entry?.sizeBytes === undefined ? null : (
        <Text size="sm" c="dimmed">
          Download size {formatBytes(entry.sizeBytes)}
        </Text>
      )}
      {busy || progress?.phase === 'cancelled' ? (
        <Stack gap={4}>
          <Progress value={percent} animated={busy} aria-label="Download progress" />
          <Text size="xs" c="dimmed">
            {progress === undefined || progress.phase === 'cancelled'
              ? progress === undefined
                ? 'Starting'
                : 'Cancelled'
              : PHASE_LABEL[progress.phase as keyof typeof PHASE_LABEL]}
            {progress?.phase === 'downloading' && progress.bytesPerSecond !== undefined
              ? `, ${formatBytes(progress.bytesPerSecond)}/s`
              : ''}
          </Text>
        </Stack>
      ) : null}
      {error === undefined ? null : (
        <Alert color="red" title="Download failed">
          {error}
        </Alert>
      )}
      <Group justify="flex-end" gap="xs">
        {busy ? (
          <Button
            variant="default"
            onClick={() => void runReported(() => rpc.tools.cancelDownload({ downloadId }))}
          >
            Cancel
          </Button>
        ) : (
          <Button variant="default" onClick={onClose}>
            Close
          </Button>
        )}
        <Button disabled={version === null || busy} onClick={() => void start()}>
          Download
        </Button>
      </Group>
    </Stack>
  );
}
