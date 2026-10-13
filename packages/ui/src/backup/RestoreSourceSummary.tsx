import { Alert, Badge, Button, Code, Collapse, Group, Stack, Text } from '@mantine/core';
import type { BackupInspection } from '@mongo-gui/core';
import { useState } from 'react';
import { formatBytes } from '../kit/input-rules';
import { runReported } from '../kit/notify-error';

const SHORT_HASH_LENGTH = 12;

export interface RestoreSourceSummaryProps {
  readonly inspection: BackupInspection;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function Fact({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <Group gap="xs" wrap="nowrap" align="baseline">
      <Text size="sm" c="dimmed" w={130} style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <Text size="sm" component="div">
        {children}
      </Text>
    </Group>
  );
}

/** What is known about the backup: the sidecar facts, or the archive header without one. */
export function RestoreSourceSummary({ inspection }: RestoreSourceSummaryProps) {
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { sidecar, prelude } = inspection;
  const format = `${inspection.kind === 'archive' ? 'Archive' : 'Folder'}${inspection.gzip ? ', gzip' : ''}`;

  if (sidecar === undefined) {
    return (
      <Stack gap="xs" data-testid="restore-summary">
        <Alert color="yellow" role="status">
          {inspection.sidecarProblem ??
            'No description file was found. Only what the backup itself records is shown.'}
        </Alert>
        <Fact label="Format">{format}</Fact>
        <Fact label="Size">{formatBytes(inspection.bytes)}</Fact>
        {prelude?.serverVersion === undefined ? null : (
          <Fact label="Server version">{prelude.serverVersion}</Fact>
        )}
        {prelude?.toolsVersion === undefined ? null : (
          <Fact label="Tools version">{prelude.toolsVersion}</Fact>
        )}
      </Stack>
    );
  }

  const { source, tools, options } = sidecar;
  const hash = sidecar.output.kind === 'archive' ? sidecar.output.sha256 : undefined;
  const topology =
    source.setName === undefined ? source.topology : `${source.topology}, ${source.setName}`;
  return (
    <Stack gap="xs" data-testid="restore-summary">
      <Fact label="Connection">{source.connectionName}</Fact>
      <Fact label="Hosts">{source.hosts.join(', ')}</Fact>
      <Fact label="Topology">{topology}</Fact>
      <Fact label="Server">
        {source.serverVersion}
        {source.fcv === undefined ? '' : `, FCV ${source.fcv}`}
      </Fact>
      <Fact label="Backed up">
        {new Date(sidecar.startedAt).toLocaleString()} ({formatDuration(sidecar.durationMs)})
      </Fact>
      <Fact label="Tools">
        {tools.version} <Badge variant="light">{tools.source}</Badge>
      </Fact>
      <Fact label="Format">{format}</Fact>
      <Fact label="Size">{formatBytes(inspection.bytes)}</Fact>
      {hash === undefined ? null : (
        <Fact label="SHA-256">
          <Group gap="xs">
            <Code title={hash}>{hash.slice(0, SHORT_HASH_LENGTH)}</Code>
            <Button
              size="compact-xs"
              variant="default"
              onClick={() => {
                void runReported(async () => {
                  await navigator.clipboard.writeText(hash);
                  setCopied(true);
                });
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </Group>
        </Fact>
      )}
      <Button
        size="compact-sm"
        variant="subtle"
        style={{ alignSelf: 'flex-start' }}
        aria-expanded={optionsOpen}
        onClick={() => {
          setOptionsOpen((open) => !open);
        }}
      >
        {optionsOpen ? 'Hide options used' : 'Show options used'}
      </Button>
      <Collapse in={optionsOpen}>
        <Stack gap={2} data-testid="options-used">
          {Object.entries(options).map(([name, value]) => (
            <Text key={name} size="xs" ff="monospace">
              {name}: {Array.isArray(value) ? value.join(', ') || 'none' : String(value)}
            </Text>
          ))}
        </Stack>
      </Collapse>
    </Stack>
  );
}
