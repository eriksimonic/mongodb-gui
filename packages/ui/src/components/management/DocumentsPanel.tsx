import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { IconCopy, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { errorText } from '../notify-error';
import { useEffect, useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { useAppStore } from '../../state/app-store-context';
import {
  columnsOf,
  duplicateText,
  toDocumentRow,
  type DocumentRow,
} from '../../management/document-rows';
import { parseJsonObject } from '../../management/input-rules';
import { DestructiveDialog } from './DestructiveDialog';
import { DocumentEditorDialog } from './DocumentEditorDialog';
import type { CollectionPanelProps } from './IndexesPanel';

const FIRST_PAGE = 20;
const MAX_PAGE = 200;

type Editor =
  { readonly mode: 'edit' | 'duplicate'; readonly row: DocumentRow } | { readonly mode: 'insert' };

type Pending =
  | { readonly kind: 'deleteRow'; readonly row: DocumentRow }
  | { readonly kind: 'deleteShown' }
  | { readonly kind: 'deleteMatching'; readonly count: number; readonly filter: string };

/** Lists the first documents of a collection, with edit, duplicate, insert and delete actions. */
export function DocumentsPanel({ connectionId, database, collection }: CollectionPanelProps) {
  const { rpc } = useUiApi();
  const revision = useAppStore((state) => state.catalogRevision);
  const [limit, setLimit] = useState(FIRST_PAGE);
  const [rows, setRows] = useState<DocumentRow[] | undefined>(undefined);
  const [fetched, setFetched] = useState(0);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState('');
  const [matchCount, setMatchCount] = useState<number | undefined>(undefined);
  const [filterError, setFilterError] = useState<string | undefined>(undefined);
  const [editor, setEditor] = useState<Editor | undefined>(undefined);
  const [pending, setPending] = useState<Pending | undefined>(undefined);

  useEffect(() => {
    let active = true;
    rpc.management.sampleDocuments({ connectionId, database, collection, limit }).then(
      (documents) => {
        if (active) {
          setRows(
            documents.map(toDocumentRow).filter((row): row is DocumentRow => row !== undefined),
          );
          setFetched(documents.length);
          setLoadError(undefined);
        }
      },
      (failure: unknown) => {
        if (active) {
          setLoadError(errorText(failure));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, connectionId, database, collection, limit, revision]);

  if (loadError !== undefined) {
    return (
      <Alert color="red" variant="light" m="sm">
        {loadError}
      </Alert>
    );
  }
  if (rows === undefined) {
    return <Loader size="xs" m="sm" aria-label="Loading documents" />;
  }

  const columns = columnsOf(rows);
  const canLoadMore = fetched === limit && limit < MAX_PAGE;
  const filterText = filter.trim() === '' ? '{}' : filter.trim();

  async function countMatches() {
    const parsed = parseJsonObject(filterText);
    if (!parsed.ok) {
      setFilterError(parsed.message);
      return;
    }
    setFilterError(undefined);
    try {
      const count = await rpc.management.countDocuments({
        connectionId,
        database,
        collection,
        filterEjson: filterText,
      });
      setMatchCount(count);
    } catch (failure) {
      setFilterError(errorText(failure));
    }
  }

  return (
    <Stack gap="sm" p="sm">
      <Group justify="space-between" wrap="wrap">
        <Text size="sm" c="dimmed">
          Showing {rows.length} of the first {limit} documents
        </Text>
        <Group gap="xs">
          <Button
            size="xs"
            leftSection={<IconPlus size={14} />}
            onClick={() => setEditor({ mode: 'insert' })}
          >
            Insert document
          </Button>
          <Button
            size="xs"
            variant="light"
            color="red"
            disabled={rows.length === 0}
            onClick={() => setPending({ kind: 'deleteShown' })}
          >
            Delete all shown
          </Button>
        </Group>
      </Group>

      <Group align="flex-start" gap="xs" wrap="wrap">
        <TextInput
          label="Filter"
          placeholder='{"status": "paid"}'
          value={filter}
          onChange={(event) => {
            setFilter(event.currentTarget.value);
            setMatchCount(undefined);
          }}
          error={filterError}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          w={320}
          autoComplete="off"
          spellCheck={false}
        />
        <Button variant="default" onClick={() => void countMatches()}>
          Count matches
        </Button>
        <Button
          color="red"
          variant="light"
          disabled={matchCount === undefined || matchCount === 0}
          onClick={() =>
            matchCount === undefined
              ? undefined
              : setPending({ kind: 'deleteMatching', count: matchCount, filter: filterText })
          }
        >
          {matchCount === undefined ? 'Delete matching' : `Delete ${matchCount} matching`}
        </Button>
      </Group>

      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          The collection has no documents yet.
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={480}>
          <Table striped highlightOnHover withTableBorder verticalSpacing="xs" fz="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>_id</Table.Th>
                {columns.map((column) => (
                  <Table.Th key={column}>{column}</Table.Th>
                ))}
                <Table.Th>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <Table.Tr key={row.idEjson}>
                  <Table.Td>
                    <Text size="xs" ff="monospace">
                      {row.idEjson}
                    </Text>
                  </Table.Td>
                  {columns.map((column) => (
                    <Table.Td key={column}>{row.fields[column] ?? ''}</Table.Td>
                  ))}
                  <Table.Td>
                    <Group gap={2} wrap="nowrap">
                      <ActionIcon
                        aria-label="Edit document"
                        onClick={() => setEditor({ mode: 'edit', row })}
                      >
                        <IconPencil size={14} />
                      </ActionIcon>
                      <ActionIcon
                        aria-label="Duplicate document"
                        onClick={() => setEditor({ mode: 'duplicate', row })}
                      >
                        <IconCopy size={14} />
                      </ActionIcon>
                      <ActionIcon
                        aria-label="Delete document"
                        color="red"
                        onClick={() => setPending({ kind: 'deleteRow', row })}
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      {canLoadMore ? (
        <Button variant="default" size="xs" w="fit-content" onClick={() => setLimit(MAX_PAGE)}>
          Load more
        </Button>
      ) : null}

      {editor === undefined ? null : (
        <DocumentEditorDialog
          connectionId={connectionId}
          database={database}
          collection={collection}
          mode={editor.mode}
          initialText={
            editor.mode === 'insert'
              ? '{}\n'
              : editor.mode === 'duplicate'
                ? duplicateText(editor.row)
                : editor.row.text
          }
          idEjson={editor.mode === 'edit' ? editor.row.idEjson : undefined}
          onClose={() => setEditor(undefined)}
        />
      )}
      {pending === undefined ? null : (
        <PendingDelete
          connectionId={connectionId}
          database={database}
          collection={collection}
          pending={pending}
          shownIds={rows.map((row) => row.idEjson)}
          limit={limit}
          onDone={() => {
            setPending(undefined);
            setMatchCount(undefined);
          }}
        />
      )}
    </Stack>
  );
}

interface PendingDeleteProps {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
  readonly pending: Pending;
  readonly shownIds: readonly string[];
  readonly limit: number;
  readonly onDone: () => void;
}

/** The confirmation for each delete. Every path names the count it will delete before it runs. */
function PendingDelete({
  connectionId,
  database,
  collection,
  pending,
  shownIds,
  limit,
  onDone,
}: PendingDeleteProps) {
  const { rpc } = useUiApi();
  const target = { connectionId, database, collection };
  switch (pending.kind) {
    case 'deleteRow':
      return (
        <DestructiveDialog
          title="Delete document"
          description={`Delete the document with _id ${pending.row.idEjson}? This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={() =>
            rpc.management
              .deleteDocuments({ ...target, idsEjson: [pending.row.idEjson] })
              .then(() => undefined)
          }
          onClose={onDone}
        />
      );
    case 'deleteShown':
      return (
        <DestructiveDialog
          title="Delete shown documents"
          description={`Delete the ${shownIds.length} documents shown? Documents past the first ${limit} stay. This cannot be undone.`}
          confirmLabel={`Delete ${shownIds.length} documents`}
          onConfirm={() =>
            rpc.management
              .deleteDocuments({ ...target, idsEjson: [...shownIds] })
              .then(() => undefined)
          }
          onClose={onDone}
        />
      );
    case 'deleteMatching':
      return (
        <DestructiveDialog
          title="Delete matching documents"
          description={`Delete ${pending.count} documents that match ${pending.filter}? The server checks the count again before it deletes. This cannot be undone.`}
          confirmLabel={`Delete ${pending.count} documents`}
          onConfirm={() =>
            rpc.management
              .deleteByFilter({
                ...target,
                filterEjson: pending.filter,
                expectedCount: pending.count,
              })
              .then(() => undefined)
          }
          onClose={onDone}
        />
      );
  }
}
