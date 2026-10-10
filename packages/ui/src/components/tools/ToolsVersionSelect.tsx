import { Select, type SelectProps } from '@mantine/core';
import type { ToolsInstall, ToolsVersion } from '@mongo-gui/core';
import { useState } from 'react';
import { DownloadToolsModal } from './DownloadToolsModal';

const DOWNLOAD_VALUE = '__download__';

interface ToolsVersionSelectProps {
  readonly installs: readonly ToolsInstall[];
  readonly value: string | null;
  readonly onChange: (version: ToolsVersion) => void;
  readonly label?: SelectProps['label'];
  readonly disabled?: boolean | undefined;
}

/** The healthy installed versions, plus an item that opens the download dialog. */
export function ToolsVersionSelect({
  installs,
  value,
  onChange,
  label = 'Tools version',
  disabled,
}: ToolsVersionSelectProps) {
  const [downloading, setDownloading] = useState(false);
  // One entry per version. The bundled install wins when both exist.
  const byVersion = new Map<string, ToolsInstall>();
  for (const install of installs) {
    const known = byVersion.get(install.version);
    if (install.health.state === 'ok' && (known === undefined || install.source === 'bundled')) {
      byVersion.set(install.version, install);
    }
  }
  const data = [
    ...[...byVersion.values()].map((install) => ({
      value: install.version,
      label: `${install.version} (${install.source === 'bundled' ? 'Bundled' : 'Downloaded'})`,
    })),
    { value: DOWNLOAD_VALUE, label: 'Download another version…' },
  ];
  return (
    <>
      <Select
        label={label}
        data={data}
        value={value}
        disabled={disabled === true}
        allowDeselect={false}
        onChange={(next) => {
          if (next === DOWNLOAD_VALUE) {
            setDownloading(true);
          } else if (next !== null) {
            onChange(next);
          }
        }}
      />
      <DownloadToolsModal
        opened={downloading}
        onClose={() => setDownloading(false)}
        onDone={onChange}
      />
    </>
  );
}
