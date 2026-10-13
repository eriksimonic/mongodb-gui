import { Alert, Badge, Button, Group, Radio, Select, Stack, Text } from '@mantine/core';
import type { Settings, SettingsPatch, ToolsInstall } from '@mongo-gui/core';
import { useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { formatBytes } from '../../diagnostics';
import { DownloadToolsModal } from '../tools/DownloadToolsModal';
import { ToolsLicenceModal } from '../tools/ToolsLicenceModal';
import { useMongoTools } from '../tools/use-mongo-tools';
import { errorText, runReported } from '../../kit/notify-error';

interface ToolsSectionProps {
  readonly settings: Settings;
  readonly save: (patch: SettingsPatch) => Promise<void>;
}

const AUTO = 'auto';

/** The installed MongoDB Database Tools, the default version and the download dialog. */
export function ToolsSection({ settings, save }: ToolsSectionProps) {
  const { rpc } = useUiApi();
  const { list, reload } = useMongoTools();
  const [downloading, setDownloading] = useState(false);
  const [licenceId, setLicenceId] = useState<ToolsInstall['id'] | undefined>(undefined);

  if (list === undefined) {
    return (
      <Text size="sm" c="dimmed">
        Loading tools
      </Text>
    );
  }
  const healthy = list.installs.filter((install) => install.health.state === 'ok');
  const versions = [...new Set(healthy.map((install) => install.version))];
  const preference = settings.mongoToolsVersion;

  return (
    <Stack gap="sm">
      {list.bundledSupported ? null : (
        <Text size="sm" c="dimmed">
          No tools are bundled for this platform. Download a version to enable backup and restore.
        </Text>
      )}
      {list.installs.map((install) => (
        <Stack key={install.id} gap={4} data-testid={`tools-row-${install.id}`}>
          <Group gap="xs" wrap="nowrap">
            <Radio
              aria-label={`Default ${install.version} ${install.source}`}
              checked={preference === install.version}
              disabled={install.health.state !== 'ok'}
              onChange={() => void save({ mongoToolsVersion: install.version })}
            />
            <Text size="sm" fw={600}>
              {install.version}
            </Text>
            <Badge variant="light" color={install.source === 'bundled' ? 'blue' : 'gray'}>
              {install.source === 'bundled' ? 'Bundled' : 'Downloaded'}
            </Badge>
            <Text size="xs" c="dimmed" style={{ flex: 1 }}>
              {[install.target, formatBytes(install.sizeBytes)].filter(Boolean).join(', ')}
            </Text>
            <Button size="compact-sm" variant="default" onClick={() => setLicenceId(install.id)}>
              Licence
            </Button>
            {install.source === 'downloaded' ? (
              <Button
                size="compact-sm"
                variant="default"
                color="red"
                disabled={install.inUse}
                title={install.inUse ? 'A running job uses these tools.' : undefined}
                onClick={() =>
                  void runReported(async () => {
                    await rpc.tools.remove({ id: install.id });
                    await reload();
                  })
                }
              >
                Remove
              </Button>
            ) : null}
          </Group>
          {install.health.state === 'broken' ? (
            <Text size="xs" c="red">
              {errorText(install.health.error)}
            </Text>
          ) : null}
        </Stack>
      ))}
      {list.installs.length === 0 ? <Alert color="yellow">No tools are installed.</Alert> : null}
      <Select
        label="Default version"
        data={[
          { value: AUTO, label: 'Automatic (bundled, else newest)' },
          ...versions.map((version) => ({ value: version, label: version })),
        ]}
        value={preference}
        allowDeselect={false}
        onChange={(next) => {
          if (next !== null) {
            void save({ mongoToolsVersion: next });
          }
        }}
      />
      <Group>
        <Button variant="default" onClick={() => setDownloading(true)}>
          Download another version…
        </Button>
      </Group>
      <DownloadToolsModal
        opened={downloading}
        onClose={() => setDownloading(false)}
        onDone={() => void runReported(reload)}
      />
      <ToolsLicenceModal installId={licenceId} onClose={() => setLicenceId(undefined)} />
    </Stack>
  );
}
