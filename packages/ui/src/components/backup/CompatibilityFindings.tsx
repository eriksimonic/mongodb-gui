import { Alert, Button, Checkbox, Group, Stack, Text, TextInput } from '@mantine/core';
import type { Finding, FindingCode, FindingSeverity, ToolsVersion } from '@mongo-gui/core';
import { useState } from 'react';
import { DownloadToolsModal } from '../tools/DownloadToolsModal';

const SEVERITY_COLOR: Record<FindingSeverity, string> = {
  block: 'red',
  strong: 'orange',
  warning: 'yellow',
  info: 'blue',
};

const SEVERITY_ORDER: readonly FindingSeverity[] = ['block', 'strong', 'warning', 'info'];

export interface CompatibilityFindingsProps {
  readonly findings: readonly Finding[];
  /** Codes of the strong findings the user has accepted. */
  readonly acknowledged: readonly FindingCode[];
  readonly onAcknowledge: (code: FindingCode, checked: boolean) => void;
  /** The connection name the user must type to go ahead past a confirmable block. */
  readonly connectionName: string;
  readonly confirmation: string;
  readonly onConfirmationChange: (value: string) => void;
  /** Called for the "Use X" action, and once a download started from "Download X" is done. */
  readonly onUseTools: (version: ToolsVersion) => void;
  /** Called instead of onUseTools once a download is done, so the caller can reload its list. */
  readonly onDownloaded?: ((version: ToolsVersion) => void) | undefined;
  /** The end of the confirmation label. Backup has no confirmable block, so restore sets it. */
  readonly confirmAction?: string;
}

/** The compatibility findings of a backup or restore, most serious first. */
export function CompatibilityFindings({
  findings,
  acknowledged,
  onAcknowledge,
  connectionName,
  confirmation,
  onConfirmationChange,
  onUseTools,
  onDownloaded,
  confirmAction = 'restore anyway',
}: CompatibilityFindingsProps) {
  const [downloadVersion, setDownloadVersion] = useState<ToolsVersion | undefined>(undefined);
  if (findings.length === 0) {
    return null;
  }
  const ordered = [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  return (
    <Stack gap="xs" aria-label="Compatibility findings">
      {ordered.map((finding) => (
        <Alert
          key={finding.code}
          color={SEVERITY_COLOR[finding.severity]}
          role={finding.severity === 'block' ? 'alert' : 'status'}
          data-severity={finding.severity}
        >
          <Stack gap="xs">
            <Text size="sm">{finding.message}</Text>
            {finding.detail === undefined ? null : (
              <Text size="xs" c="dimmed">
                {finding.detail}
              </Text>
            )}
            {finding.action === undefined ? null : (
              <Group>
                <Button
                  size="compact-sm"
                  variant="default"
                  onClick={() => {
                    const { action } = finding;
                    if (action?.kind === 'use-tools') {
                      onUseTools(action.version);
                    } else if (action !== undefined) {
                      setDownloadVersion(action.version);
                    }
                  }}
                >
                  {finding.action.kind === 'use-tools' ? 'Use' : 'Download'}{' '}
                  {finding.action.version}
                </Button>
              </Group>
            )}
            {finding.severity === 'strong' ? (
              <Checkbox
                label="I understand"
                checked={acknowledged.includes(finding.code)}
                onChange={(event) => {
                  onAcknowledge(finding.code, event.currentTarget.checked);
                }}
              />
            ) : null}
            {finding.severity === 'block' && finding.confirmable ? (
              <TextInput
                label={`Type ${connectionName} to ${confirmAction}`}
                value={confirmation}
                onChange={(event) => {
                  onConfirmationChange(event.currentTarget.value);
                }}
              />
            ) : null}
          </Stack>
        </Alert>
      ))}
      <DownloadToolsModal
        opened={downloadVersion !== undefined}
        presetVersion={downloadVersion}
        onClose={() => {
          setDownloadVersion(undefined);
        }}
        onDone={(version) => {
          setDownloadVersion(undefined);
          (onDownloaded ?? onUseTools)(version);
        }}
      />
    </Stack>
  );
}
