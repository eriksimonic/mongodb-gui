import {
  Alert,
  Button,
  Group,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  assessCopy,
  DatabaseNameSchema,
  newestFittingTools,
  sameServer,
  unresolvedCopyFindings,
  type BackupServerInfo,
  type CopyFacts,
  type CopyFinding,
  type CopyMode,
  type ToolsListOutput,
} from '@mongo-gui/core';
import { useEffect, useState } from 'react';
import { useUiApi } from '../api/ui-api';
import { TypedNameConfirm } from '../kit/TypedNameConfirm';
import { errorText } from '../kit/notify-error';
import { useAppStore } from '../state/app-store-context';
import { CopyFindings } from './CopyFindings';
import { CopyItemsEditor } from './CopyItemsEditor';
import {
  copyItemsOf,
  copyStartInput,
  COPY_MODES,
  filterErrors,
  MODE_HELP,
  MODE_LABELS,
  rowsFor,
  targetNameErrors,
  type CopyRow,
  type CopyVariant,
} from './copy-model';

export interface CopyDialogProps {
  /** The connection the source collections live on. */
  readonly sourceConnectionId: string;
  readonly sourceDatabase: string;
  readonly variant: CopyVariant;
  /** The source collections offered. For `database`, every collection in the database. */
  readonly collections: readonly string[];
  /** Called with the job id once the server accepts the start. `onClose` runs right after. */
  readonly onStarted: (jobId: string) => void;
  readonly onClose: () => void;
}

interface ServerFacts {
  readonly info: BackupServerInfo | undefined;
  readonly problem: string | undefined;
}

const NO_FACTS: ServerFacts = { info: undefined, problem: undefined };

/** Describes a server for one database. An answer for an earlier key is ignored. */
function useServerFacts(connectionId: string, database: string | undefined): ServerFacts {
  const { rpc } = useUiApi();
  const key = `${connectionId}/${database ?? ''}`;
  const [answer, setAnswer] = useState<
    { readonly key: string; readonly facts: ServerFacts } | undefined
  >(undefined);

  useEffect(() => {
    if (database === undefined) {
      return undefined;
    }
    let active = true;
    rpc.backup.describeServer({ connectionId, scope: { kind: 'database', database } }).then(
      (info) => {
        if (active) {
          setAnswer({ key, facts: { info, problem: undefined } });
        }
      },
      (failure: unknown) => {
        if (active) {
          setAnswer({ key, facts: { info: undefined, problem: errorText(failure) } });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, connectionId, database, key]);

  return answer?.key === key ? answer.facts : NO_FACTS;
}

function titleOf(variant: CopyVariant, sourceDatabase: string, count: number): string {
  if (variant === 'database') {
    return `Copy database ${sourceDatabase}`;
  }
  return variant === 'one' ? 'Copy collection' : `Copy ${count} collections`;
}

/** Modal that copies one collection, several collections or a whole database to a connection. */
export function CopyDialog(props: CopyDialogProps) {
  return (
    <Modal
      opened
      onClose={props.onClose}
      title={titleOf(props.variant, props.sourceDatabase, props.collections.length)}
      size="xl"
      centered
    >
      <CopyForm {...props} />
    </Modal>
  );
}

function CopyForm({
  sourceConnectionId,
  sourceDatabase,
  variant,
  collections,
  onStarted,
  onClose,
}: CopyDialogProps) {
  const { rpc } = useUiApi();
  const copies = useAppStore((state) => state.copies);
  const connections = useAppStore((state) => state.connections);
  const statuses = useAppStore((state) => state.statuses);
  const profiles = connections.state === 'ready' ? connections.data : [];
  const sourceName = profiles.find((item) => item.id === sourceConnectionId)?.name ?? 'connection';

  const [targetConnectionId, setTargetConnectionId] = useState(sourceConnectionId);
  const [targetDatabase, setTargetDatabase] = useState(sourceDatabase);
  const [rows, setRows] = useState<readonly CopyRow[]>(() => rowsFor(collections));
  const [mode, setMode] = useState<CopyMode>('replace');
  const [typedMatch, setTypedMatch] = useState(false);
  const [tools, setTools] = useState<ToolsListOutput | undefined>(undefined);
  const [available, setAvailable] = useState<readonly string[]>([]);
  const [toolsProblem, setToolsProblem] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [startProblem, setStartProblem] = useState<string | undefined>(undefined);

  const source = useServerFacts(sourceConnectionId, sourceDatabase);
  const validTargetDatabase = DatabaseNameSchema.safeParse(targetDatabase).success
    ? targetDatabase
    : undefined;
  const target = useServerFacts(targetConnectionId, validTargetDatabase);

  useEffect(() => {
    let active = true;
    void Promise.all([
      rpc.tools.list(),
      rpc.tools.available({ refresh: false }).catch(() => undefined),
    ]).then(
      ([list, feed]) => {
        if (active) {
          setTools(list);
          setAvailable(feed?.versions.map((item) => item.version) ?? []);
        }
      },
      (failure: unknown) => {
        if (active) {
          setToolsProblem(errorText(failure));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [rpc]);

  const connected = profiles.filter((item) => statuses[item.id]?.state === 'connected');
  const targetProfile = profiles.find((item) => item.id === targetConnectionId);
  const targetName = targetProfile?.name ?? 'connection';
  const production = targetProfile?.production === true;

  const installed = (tools?.installs ?? [])
    .filter((install) => install.health.state === 'ok')
    .map((install) => install.version);
  const serverVersions = [source.info?.serverVersion, target.info?.serverVersion].filter(
    (version): version is string => version !== undefined,
  );
  // Without an installed version that fits, the preferred version is used, as the copy service does.
  const selected =
    tools === undefined
      ? undefined
      : (newestFittingTools(installed, serverVersions) ?? tools.resolved);
  const items = copyItemsOf(rows);
  const facts: CopyFacts | undefined =
    source.info === undefined || target.info === undefined || selected === undefined
      ? undefined
      : {
          source: source.info,
          target: target.info,
          tools: { selected, installed, available: [...available] },
          sameServer: sameServer(source.info.identity, target.info.identity),
          options: { sourceDatabase, targetDatabase, items, mode },
          sourceNamespaces: source.info.namespaces.filter(
            (item) => item.database === sourceDatabase,
          ),
          targetNamespaces: target.info.namespaces.filter(
            (item) => item.database === targetDatabase,
          ),
        };
  const found: CopyFinding[] = facts === undefined ? [] : assessCopy(facts);
  // The strong findings are the notes. Start agrees to every note on screen, so all of them are
  // acknowledged. Only the blocks stay unresolved.
  const noteCodes = found.filter((item) => item.severity === 'strong').map((item) => item.code);
  const unresolved = unresolvedCopyFindings(found, noteCodes);

  const nameErrors = targetNameErrors(rows);
  const rowFilterErrors = filterErrors(rows);
  const loadProblem = source.problem ?? target.problem ?? toolsProblem;
  const targetDatabaseError =
    validTargetDatabase === undefined ? 'Enter a database name' : undefined;
  const waiting =
    loadProblem !== undefined
      ? 'The servers could not be described'
      : tools === undefined
        ? 'Checking the tools…'
        : selected === undefined
          ? 'No tools version is available'
          : 'Checking the servers…';
  const blockers: readonly (string | undefined)[] = [
    targetDatabaseError,
    items.length === 0 ? 'Select at least one collection' : undefined,
    nameErrors.find((message) => message !== undefined),
    rowFilterErrors.find((message) => message !== undefined),
    facts === undefined ? waiting : undefined,
    production && !typedMatch
      ? `Type ${targetDatabase} to copy into a production connection`
      : undefined,
    unresolved[0]?.message,
  ];
  const blocker = blockers.find((message) => message !== undefined);

  function patchRow(index: number, patch: Partial<CopyRow>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function start() {
    setStarting(true);
    setStartProblem(undefined);
    try {
      const jobId = await copies.getState().start(
        copyStartInput({
          sourceConnectionId,
          targetConnectionId,
          sourceDatabase,
          targetDatabase,
          rows,
          mode,
          acknowledged: noteCodes,
          confirmation: production && typedMatch ? targetDatabase : undefined,
        }),
      );
      onStarted(jobId);
      onClose();
    } catch (failure: unknown) {
      setStartProblem(errorText(failure));
      setStarting(false);
    }
  }

  return (
    <Stack gap="md">
      <Group grow align="flex-start">
        <TextInput label="Source connection" value={sourceName} readOnly />
        <TextInput label="Source database" value={sourceDatabase} readOnly />
      </Group>
      <Group grow align="flex-start">
        <Select
          label="Target connection"
          data={connected.map((item) => ({ value: item.id, label: item.name }))}
          value={targetConnectionId}
          allowDeselect={false}
          searchable
          onChange={(value) => {
            if (value !== null) {
              setTargetConnectionId(value);
            }
          }}
        />
        <TextInput
          label="Target database"
          value={targetDatabase}
          error={targetDatabaseError}
          onChange={(event) => {
            setTargetDatabase(event.currentTarget.value);
          }}
        />
      </Group>
      {production && validTargetDatabase !== undefined ? (
        <Stack gap="xs">
          <Text size="sm">
            {targetName} is a production connection. Type the database name to copy into it.
          </Text>
          <TypedNameConfirm
            key={targetConnectionId}
            expected={targetDatabase}
            onMatchChange={setTypedMatch}
          />
        </Stack>
      ) : null}
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          This database has no collections to copy.
        </Text>
      ) : null}
      <CopyItemsEditor
        variant={variant}
        rows={rows}
        sourceConnectionId={sourceConnectionId}
        sourceDatabase={sourceDatabase}
        nameErrors={nameErrors}
        filterErrors={rowFilterErrors}
        onChange={patchRow}
      />
      <Stack gap="xs">
        <SegmentedControl
          aria-label="Copy mode"
          data={COPY_MODES.map((item) => ({ value: item, label: MODE_LABELS[item] }))}
          value={mode}
          onChange={(value) => {
            setMode(value as CopyMode);
          }}
        />
        <Text size="sm" c="dimmed">
          {MODE_HELP[mode]}
        </Text>
      </Stack>
      {facts === undefined && loadProblem === undefined ? (
        <Text size="sm" c="dimmed">
          {waiting}
        </Text>
      ) : null}
      <CopyFindings findings={found} />
      {loadProblem === undefined ? null : (
        <Alert color="red" role="alert">
          {loadProblem}
        </Alert>
      )}
      {startProblem === undefined ? null : (
        <Alert color="red" role="alert">
          {startProblem}
        </Alert>
      )}
      <Group justify="space-between">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Tooltip label={blocker} disabled={blocker === undefined}>
          <Button
            disabled={blocker !== undefined}
            loading={starting}
            onClick={() => {
              void start();
            }}
          >
            {noteCodes.length > 0 ? 'Agree and copy' : 'Start copy'}
          </Button>
        </Tooltip>
      </Group>
    </Stack>
  );
}
