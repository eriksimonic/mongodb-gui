import { Alert, Stack, Text } from '@mantine/core';
import type { CopyFinding } from '@mongo-gui/core';

export interface CopyFindingsProps {
  readonly findings: readonly CopyFinding[];
}

function FindingText({ finding }: { readonly finding: CopyFinding }) {
  return (
    <Stack gap={2}>
      <Text size="sm">{finding.message}</Text>
      {finding.detail === undefined ? null : (
        <Text size="xs" c="dimmed">
          {finding.detail}
        </Text>
      )}
    </Stack>
  );
}

/**
 * The findings of a copy. A block stops the copy in a red panel. The strong findings form one calm
 * note, and the start button agrees to them. Warnings and info stay as notes of their own.
 */
export function CopyFindings({ findings }: CopyFindingsProps) {
  const stops = findings.filter((item) => item.severity === 'block');
  const notes = findings.filter((item) => item.severity === 'strong');
  const others = findings.filter((item) => item.severity === 'warning' || item.severity === 'info');
  return (
    <Stack gap="xs">
      {stops.length === 0 ? null : (
        <Alert color="red" role="alert" title="Copy cannot start">
          <Stack gap="xs">
            {stops.map((item, index) => (
              <FindingText key={`${item.code}-${index}`} finding={item} />
            ))}
          </Stack>
        </Alert>
      )}
      {notes.length === 0 ? null : (
        <Alert color="blue" role="status">
          <Stack gap="xs">
            {notes.map((item, index) => (
              <FindingText key={`${item.code}-${index}`} finding={item} />
            ))}
          </Stack>
        </Alert>
      )}
      {others.map((item, index) => (
        <Alert
          key={`${item.code}-${index}`}
          color={item.severity === 'warning' ? 'yellow' : 'blue'}
          role="status"
        >
          <FindingText finding={item} />
        </Alert>
      ))}
    </Stack>
  );
}
