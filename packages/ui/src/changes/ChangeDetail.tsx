import { Badge, Box, Button, Code, Group, Stack, Table, Text } from '@mantine/core';
import { useMemo, useState } from 'react';
import { notifyError } from '../components/notify-error';
import { isPlainObject, parseEjson, type JsonObject } from '../results/result-model';
import { TreeView } from '../results/TreeView';
import {
  keySummaryOf,
  namespaceText,
  operationColor,
  wallTimeText,
  type ChangeRow,
} from './changes-model';

const TREE_HEIGHT_PX = 240;

export interface ChangeDetailProps {
  readonly row: ChangeRow | undefined;
  /** Restarts the watch after this row. */
  readonly onResumeFrom: (key: string) => void;
}

/** The selected event: its facts, its document in a tree, and its resume token. */
export function ChangeDetail({ row, onResumeFrom }: ChangeDetailProps) {
  if (row === undefined) {
    return (
      <Text size="sm" c="dimmed" p={8}>
        Select an event to see its document and resume token.
      </Text>
    );
  }
  return <EventDetail row={row} onResumeFrom={onResumeFrom} />;
}

function EventDetail({
  row,
  onResumeFrom,
}: Omit<ChangeDetailProps, 'row'> & { readonly row: ChangeRow }) {
  const { event } = row;
  const documents = useMemo<JsonObject[]>(() => {
    const parsed = parseEjson(event.rawEjson);
    return [isPlainObject(parsed) ? parsed : {}];
  }, [event.rawEjson]);
  const noop = useMemo(() => async () => undefined, []);

  return (
    <Stack gap={8} p={8} style={{ minHeight: 0, overflow: 'auto' }}>
      <Group gap={6} wrap="nowrap">
        <Badge color={operationColor(event.operationType)} variant="light">
          {event.operationType}
        </Badge>
        <Text size="sm" ff="monospace" truncate>
          {namespaceText(event) || 'no namespace'}
        </Text>
      </Group>
      <Table withRowBorders={false} verticalSpacing={2}>
        <Table.Tbody>
          <FactRow label="Document key" value={keySummaryOf(event.documentKeyEjson) || '-'} />
          <FactRow label="Cluster time" value={event.clusterTimeEjson ?? '-'} />
          <FactRow label="Wall time" value={wallTimeText(event.wallTime)} />
          <FactRow label="Truncated" value={event.truncated === true ? 'Yes' : 'No'} />
        </Table.Tbody>
      </Table>
      <Group justify="space-between" gap={6}>
        <Text size="xs" fw={600}>
          Event document
        </Text>
        <CopyText label="Copy event" text={event.rawEjson} />
      </Group>
      <Box style={{ height: TREE_HEIGHT_PX, minHeight: 0 }}>
        <TreeView
          documents={documents}
          editable={false}
          editabilityNote="The event is read only."
          onSetField={noop}
          onUnsetField={noop}
        />
      </Box>
      <Group justify="space-between" gap={6}>
        <Text size="xs" fw={600}>
          Resume token
        </Text>
        <Group gap={6}>
          <CopyText label="Copy token" text={event.resumeTokenEjson} />
          <Button size="xs" variant="light" onClick={() => onResumeFrom(row.key)}>
            Resume from here
          </Button>
        </Group>
      </Group>
      <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {event.resumeTokenEjson}
      </Code>
    </Stack>
  );
}

function FactRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <Table.Tr>
      <Table.Td style={{ width: 110, paddingLeft: 0 }}>
        <Text size="xs" c="dimmed">
          {label}
        </Text>
      </Table.Td>
      <Table.Td style={{ paddingRight: 0 }}>
        <Text size="xs" ff="monospace" style={{ wordBreak: 'break-all' }}>
          {value}
        </Text>
      </Table.Td>
    </Table.Tr>
  );
}

interface CopyTextProps {
  readonly label: string;
  readonly text: string;
}

/** A button that copies the text and reads Copied for that text until the text changes. */
function CopyText({ label, text }: CopyTextProps) {
  const [copiedText, setCopiedText] = useState<string | undefined>(undefined);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedText(text);
    } catch (error) {
      notifyError(error, 'The text could not be copied');
    }
  }

  return (
    <Button size="xs" variant="default" onClick={() => void copy()}>
      {copiedText === text ? 'Copied' : label}
    </Button>
  );
}
