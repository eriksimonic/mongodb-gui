import {
  Accordion,
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  assessBackup,
  defaultBackupName,
  unresolvedFindings,
  type BackupServerInfo,
  type FindingCode,
  type ReadPreferenceMode,
  type SavedBackup,
  type ToolsListOutput,
  type ToolsVersion,
  type WireCompressor,
} from '@mongo-gui/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { TipLabel } from '../InfoTip';
import { useUiApi } from '../../api/ui-api';
import { useAppStore } from '../../state/app-store-context';
import { errorText, runReported } from '../notify-error';
import { ToolsVersionSelect } from '../tools/ToolsVersionSelect';
import { BackupProgressView } from './BackupProgressView';
import { CompatibilityFindings } from './CompatibilityFindings';
import {
  backupProblemsOf,
  backupStartInput,
  defaultReadPreference,
  draftForTarget,
  draftFromSaved,
  outputPreview,
  savedBackupInput,
  scopeOf,
  type BackupDraft,
  type BackupProblem,
} from './backup-model';
import { useBackupDialogs, type BackupDialogRequest } from './backup-dialog-store';
import { useBackupJob } from './use-backup-job';

export interface BackupDialogProps {
  readonly request: Extract<BackupDialogRequest, { kind: 'backup' }>;
}

export interface BackupDialogBodyProps {
  readonly connectionId: string;
  readonly database?: string | undefined;
  readonly collection?: string | undefined;
  readonly onClose: () => void;
  /** Tells the modal when a job runs, so it can refuse to close. */
  readonly onRunningChange?: (running: boolean) => void;
}

const READ_PREFERENCES: readonly ReadPreferenceMode[] = [
  'primary',
  'primaryPreferred',
  'secondary',
  'secondaryPreferred',
  'nearest',
];
const COMPRESSORS: readonly WireCompressor[] = ['snappy', 'zstd', 'zlib'];

/** Modal that backs up a server, some databases or one collection with mongodump. */
export function BackupDialog({ request }: BackupDialogProps) {
  const close = useBackupDialogs((state) => state.close);
  const [running, setRunning] = useState(false);
  const target = request.collection ?? request.database ?? 'connection';
  return (
    <Modal
      opened
      onClose={close}
      title={`Back up ${target}`}
      size="xl"
      centered
      closeOnClickOutside={!running}
      closeOnEscape={!running}
      withCloseButton={!running}
    >
      <BackupDialogBody
        connectionId={request.connectionId}
        database={request.database}
        collection={request.collection}
        onClose={close}
        onRunningChange={setRunning}
      />
    </Modal>
  );
}

interface Answer {
  readonly key: string;
  readonly info: BackupServerInfo;
}

interface Failure {
  readonly key: string;
  readonly message: string;
}

function fieldError(problems: readonly BackupProblem[], field: string): string | undefined {
  return problems.find((problem) => problem.field === field)?.message;
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

/** The dialog without its modal, so the form and the progress can be shown on their own. */
export function BackupDialogBody({
  connectionId,
  database,
  collection,
  onClose,
  onRunningChange,
}: BackupDialogBodyProps) {
  const { rpc } = useUiApi();
  const job = useBackupJob();
  const connections = useAppStore((state) => state.connections);
  const status = useAppStore((state) => state.statuses[connectionId]);
  const profile =
    connections.state === 'ready'
      ? connections.data.find((item) => item.id === connectionId)
      : undefined;
  const connectionName = profile?.name ?? 'connection';

  const [now] = useState(() => new Date());
  const [draft, setDraft] = useState<BackupDraft>(() => ({
    ...draftForTarget({ connectionName, database, collection, now }),
    readPreference: defaultReadPreference(status, profile?.readPreference),
  }));
  const nameTouched = useRef(false);
  const [tools, setTools] = useState<ToolsListOutput | undefined>(undefined);
  const [available, setAvailable] = useState<readonly string[]>([]);
  const [base, setBase] = useState<BackupServerInfo | undefined>(undefined);
  // Each answer is kept with the key it was asked for, so a stale one is ignored.
  const [scopedAnswer, setScopedAnswer] = useState<Answer | undefined>(undefined);
  const [scopedFailure, setScopedFailure] = useState<Failure | undefined>(undefined);
  const [firstAnswer, setFirstAnswer] = useState<Answer | undefined>(undefined);
  const [acknowledged, setAcknowledged] = useState<readonly FindingCode[]>([]);
  const [confirmation, setConfirmation] = useState('');
  const [loadProblem, setLoadProblem] = useState<string | undefined>(undefined);
  const [savedList, setSavedList] = useState<readonly SavedBackup[]>([]);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savedLabel, setSavedLabel] = useState('');

  useEffect(() => {
    onRunningChange?.(job.running);
  }, [job.running, onRunningChange]);

  useEffect(() => {
    let active = true;
    rpc.savedBackups.list().then(
      (list) => {
        if (active) {
          setSavedList(list.filter((item) => item.connectionId === connectionId));
        }
      },
      (failure: unknown) => {
        if (active) {
          setLoadProblem(errorText(failure));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, connectionId]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [list, info, feed] = await Promise.all([
        rpc.tools.list(),
        rpc.backup.describeServer({ connectionId }),
        rpc.tools.available({ refresh: false }).catch(() => undefined),
      ]);
      if (!active) {
        return;
      }
      setTools(list);
      setBase(info);
      setAvailable(feed?.versions.map((item) => item.version) ?? []);
      setDraft((current) =>
        current.toolsVersion === '' && list.resolved !== undefined
          ? { ...current, toolsVersion: list.resolved }
          : current,
      );
    })().catch((failure: unknown) => {
      setLoadProblem(errorText(failure));
    });
    return () => {
      active = false;
    };
  }, [rpc, connectionId]);

  const scope = scopeOf(draft);
  const scopeKey = JSON.stringify(scope ?? null);
  useEffect(() => {
    if (scope === undefined) {
      return undefined;
    }
    let active = true;
    rpc.backup.describeServer({ connectionId, scope }).then(
      (info) => {
        if (active) {
          setScopedAnswer({ key: scopeKey, info });
        }
      },
      (failure: unknown) => {
        if (active) {
          setScopedFailure({ key: scopeKey, message: errorText(failure) });
        }
      },
    );
    return () => {
      active = false;
    };
    // The scope is read through its key, so an equal scope does not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, connectionId, scopeKey]);

  const firstName = draft.databases[0];
  useEffect(() => {
    if (firstName === undefined) {
      return undefined;
    }
    let active = true;
    rpc.backup
      .describeServer({ connectionId, scope: { kind: 'database', database: firstName } })
      .then(
        (info) => {
          if (active) {
            setFirstAnswer({ key: firstName, info });
          }
        },
        () => undefined,
      );
    return () => {
      active = false;
    };
  }, [rpc, connectionId, firstName]);

  const scoped =
    scopedAnswer !== undefined && scopedAnswer.key === scopeKey ? scopedAnswer.info : undefined;
  const scopeFailure = scopedFailure?.key === scopeKey ? scopedFailure.message : undefined;
  // The unscoped answer lists no collections, so findings about them wait for the scoped one.
  const scopePending =
    scope !== undefined && scoped === undefined
      ? (scopeFailure ?? 'Checking the selected databases and collections…')
      : undefined;
  const firstDatabase =
    firstAnswer !== undefined && firstAnswer.key === firstName ? firstAnswer.info : undefined;
  const server = scoped ?? base;
  const databases = base?.databases ?? [];
  const collections = (firstDatabase?.namespaces ?? [])
    .filter((item) => item.database === firstName)
    .map((item) => item.collection);

  // Oplog and users-and-roles are allowed only for some scopes. The draft drops them otherwise.
  const oplogReason =
    scope?.kind !== 'server'
      ? 'The oplog can be included only for a whole server.'
      : server !== undefined && server.topology !== 'replicaSet'
        ? 'The oplog needs a replica set.'
        : undefined;
  const databaseScope = scope?.kind === 'database' || scope?.kind === 'databases';
  const usersReason = !databaseScope
    ? 'Users and roles can be included only when backing up databases.'
    : draft.databases.includes('admin')
      ? 'Users and roles of the admin database cannot be backed up this way.'
      : undefined;
  const noOplog = oplogReason !== undefined;
  const noUsers = usersReason !== undefined;
  // The exclude fields and the query are hidden for other scopes. The draft keeps their values
  // in case the user switches back, but they are not sent.
  const collectionTarget = draft.target === 'collection';
  const effective = useMemo<BackupDraft>(
    () => ({
      ...draft,
      oplog: draft.oplog && !noOplog,
      dumpDbUsersAndRoles: draft.dumpDbUsersAndRoles && !noUsers,
      excludeCollections: databaseScope ? draft.excludeCollections : [],
      excludePrefixes: databaseScope ? draft.excludePrefixes : [],
      query: collectionTarget ? draft.query : '',
    }),
    [draft, noOplog, noUsers, databaseScope, collectionTarget],
  );

  const problems = useMemo(() => {
    const found = backupProblemsOf(effective, server);
    if (effective.toolsVersion === '') {
      found.push({ field: 'toolsVersion', message: 'Choose a tools version' });
    }
    return found;
  }, [effective, server]);

  const findings = useMemo(
    () =>
      server === undefined || draft.toolsVersion === ''
        ? []
        : assessBackup({
            server,
            namespaces: scoped?.namespaces ?? [],
            tools: {
              selected: draft.toolsVersion,
              installed: (tools?.installs ?? [])
                .filter((install) => install.health.state === 'ok')
                .map((install) => install.version),
              available,
            },
          }),
    [server, scoped, draft.toolsVersion, tools, available],
  );
  const unresolved = unresolvedFindings(findings, acknowledged, confirmation, connectionName);
  const blocker = problems[0]?.message ?? scopePending ?? unresolved[0]?.message;

  function patch(next: Partial<BackupDraft>) {
    setDraft((current) => {
      let merged = { ...current, ...next };
      if (merged.target === 'connection' && merged.databases.length > 1) {
        merged = { ...merged, output: 'directory' };
      }
      const changedScope =
        next.target !== undefined || next.databases !== undefined || next.collection !== undefined;
      if (changedScope && !nameTouched.current) {
        const named = scopeOf(merged) ?? { kind: 'server' as const };
        merged = { ...merged, name: defaultBackupName(connectionName, named, now) };
      }
      return merged;
    });
  }

  // A finished download is missing from the list loaded on open. Reload it before selecting the
  // version, so the picker has an item for it and the findings count it as installed.
  function toolsDownloaded(version: ToolsVersion) {
    void runReported(async () => {
      try {
        setTools(await rpc.tools.list());
      } finally {
        patch({ toolsVersion: version });
      }
    });
  }

  async function chooseFolder() {
    await runReported(async () => {
      const picked = await rpc.app.showOpenDialog({
        title: 'Choose the backup folder',
        directory: true,
        filters: [],
      });
      if (picked.path !== undefined) {
        patch({ folder: picked.path });
      }
    });
  }

  function chooseSaved(id: string | null) {
    setSavedId(id);
    const saved = savedList.find((item) => item.id === id);
    if (saved === undefined) {
      return;
    }
    setSavedLabel(saved.label);
    setDraft((current) => {
      const next = draftFromSaved(current, saved);
      return nameTouched.current
        ? next
        : {
            ...next,
            name: defaultBackupName(connectionName, scopeOf(next) ?? { kind: 'server' }, now),
          };
    });
  }

  function saveSettings() {
    void runReported(async () => {
      const saved = await rpc.savedBackups.save(
        savedBackupInput(effective, connectionId, savedLabel),
      );
      setSavedList((current) => [...current, saved]);
      setSavedId(saved.id);
    });
  }

  function renameSaved() {
    if (savedId === null) {
      return;
    }
    void runReported(async () => {
      const renamed = await rpc.savedBackups.rename({ id: savedId, label: savedLabel.trim() });
      setSavedList((current) => current.map((item) => (item.id === renamed.id ? renamed : item)));
    });
  }

  function removeSaved() {
    if (savedId === null) {
      return;
    }
    void runReported(async () => {
      await rpc.savedBackups.remove({ id: savedId });
      setSavedList((current) => current.filter((item) => item.id !== savedId));
      setSavedId(null);
      setSavedLabel('');
    });
  }

  function start() {
    void job.start('dump', backupStartInput(effective, connectionId, acknowledged));
  }

  if (job.starting || job.view !== undefined) {
    return (
      <Stack gap="md">
        <BackupProgressView
          view={job.view}
          kind="dump"
          {...(job.running ? { onCancel: job.cancel } : {})}
        />
        {job.problem === undefined ? null : (
          <Alert color="red" role="alert">
            {job.problem}
          </Alert>
        )}
        {job.running ? null : (
          <Group justify="flex-end">
            <Button onClick={onClose}>Close</Button>
          </Group>
        )}
      </Stack>
    );
  }

  const preview = outputPreview(effective);
  const namespaces = scoped?.namespaces ?? [];
  const documents = namespaces.reduce((sum, item) => sum + (item.documents ?? 0), 0);
  const startAction = (
    <Tooltip label={blocker} disabled={blocker === undefined}>
      <Button disabled={blocker !== undefined} loading={job.starting} onClick={start}>
        Start backup
      </Button>
    </Tooltip>
  );

  const labelReady = savedLabel.trim() !== '';
  return (
    <Stack gap="md">
      <Group align="flex-end" wrap="nowrap">
        <Select
          label="Saved backups"
          placeholder={savedList.length === 0 ? 'None saved' : 'Load saved settings'}
          data={savedList.map((item) => ({ value: item.id, label: item.label }))}
          value={savedId}
          disabled={savedList.length === 0}
          allowDeselect={false}
          onChange={chooseSaved}
          style={{ flex: 1 }}
        />
        <TextInput
          aria-label="Saved backup name"
          placeholder="Name for these settings"
          value={savedLabel}
          onChange={(event) => {
            setSavedLabel(event.currentTarget.value);
          }}
          style={{ flex: 1 }}
        />
        <Button variant="default" disabled={!labelReady} onClick={saveSettings}>
          Save
        </Button>
        <Button variant="default" disabled={savedId === null || !labelReady} onClick={renameSaved}>
          Rename
        </Button>
        <Button variant="default" color="red" disabled={savedId === null} onClick={removeSaved}>
          Delete
        </Button>
      </Group>
      <SegmentedControl
        aria-label="What to back up"
        data={[
          { value: 'connection', label: 'Server or databases' },
          { value: 'collection', label: 'Collection' },
        ]}
        value={draft.target}
        onChange={(value) => {
          const target = value as BackupDraft['target'];
          patch({
            target,
            databases: target === 'collection' ? draft.databases.slice(0, 1) : draft.databases,
          });
        }}
      />
      {draft.target === 'connection' ? (
        <MultiSelect
          label="Databases"
          description="Leave empty to back up the whole server."
          placeholder={draft.databases.length === 0 ? 'Whole server' : undefined}
          data={databases}
          value={[...draft.databases]}
          searchable
          clearable
          error={fieldError(problems, 'scope')}
          onChange={(value) => {
            patch({ databases: value });
          }}
        />
      ) : (
        <Group grow align="flex-start">
          <Select
            label="Database"
            data={databases}
            value={draft.databases[0] ?? null}
            searchable
            allowDeselect={false}
            onChange={(value) => {
              patch({ databases: value === null ? [] : [value], collection: '' });
            }}
          />
          <Select
            label="Collection"
            data={collections}
            value={draft.collection === '' ? null : draft.collection}
            searchable
            allowDeselect={false}
            error={fieldError(problems, 'scope')}
            onChange={(value) => {
              patch({ collection: value ?? '' });
            }}
          />
        </Group>
      )}
      {draft.target === 'connection' && draft.databases.length > 0 ? (
        <>
          {draft.databases.length === 1 ? (
            <MultiSelect
              label={
                <TipLabel
                  label="Exclude collections"
                  tip="Skips these collections (mongodump --excludeCollection)."
                />
              }
              data={collections}
              value={[...draft.excludeCollections]}
              searchable
              clearable
              onChange={(value) => {
                patch({ excludeCollections: value });
              }}
            />
          ) : (
            <TagsInput
              label={
                <TipLabel
                  label="Exclude collections"
                  tip="Skips these collections (mongodump --excludeCollection)."
                />
              }
              placeholder="Add a collection name"
              value={[...draft.excludeCollections]}
              onChange={(value) => {
                patch({ excludeCollections: value });
              }}
            />
          )}
          <TagsInput
            label={
              <TipLabel
                label="Exclude prefixes"
                tip="Skips collections whose names start with any of these (--excludeCollectionsWithPrefix)."
              />
            }
            description="Collections whose names start with one of these are skipped."
            placeholder="Add a prefix"
            value={[...draft.excludePrefixes]}
            onChange={(value) => {
              patch({ excludePrefixes: value });
            }}
          />
        </>
      ) : null}
      {draft.target === 'collection' ? (
        <Textarea
          label={
            <TipLabel
              label="Query"
              tip="Dumps only documents matching this Extended JSON filter (--query)."
            />
          }
          description="Extended JSON. Empty backs up every document."
          placeholder='{"status": "paid"}'
          autosize
          minRows={2}
          value={draft.query}
          error={fieldError(problems, 'query')}
          onChange={(event) => {
            patch({ query: event.currentTarget.value });
          }}
        />
      ) : null}
      <Group align="flex-end" wrap="nowrap">
        <TextInput
          label="Folder"
          placeholder="Choose a folder"
          readOnly
          value={draft.folder}
          error={fieldError(problems, 'folder')}
          style={{ flex: 1 }}
        />
        <Button
          variant="default"
          onClick={() => {
            void chooseFolder();
          }}
        >
          Choose folder…
        </Button>
      </Group>
      <TextInput
        label="Name"
        value={draft.name}
        error={fieldError(problems, 'name')}
        onChange={(event) => {
          nameTouched.current = true;
          patch({ name: event.currentTarget.value });
        }}
      />
      <SegmentedControl
        aria-label="Format"
        data={[
          {
            value: 'archive',
            label: 'Single archive file',
            disabled: draft.target === 'connection' && draft.databases.length > 1,
          },
          { value: 'directory', label: 'Folder of BSON files' },
        ]}
        value={draft.output}
        onChange={(value) => {
          patch({ output: value as BackupDraft['output'] });
        }}
      />
      {draft.target === 'connection' && draft.databases.length > 1 ? (
        <Text size="xs" c="dimmed">
          Several databases need the folder format.
        </Text>
      ) : null}
      <Checkbox
        label={
          <TipLabel
            label="Compress with gzip"
            tip="Compresses the output (--gzip). Smaller backup, a little slower."
          />
        }
        checked={draft.gzip}
        onChange={(event) => {
          patch({ gzip: event.currentTarget.checked });
        }}
      />
      <Text size="sm" c="dimmed" data-testid="output-preview">
        {preview === undefined
          ? 'Choose a folder to see where the backup is written.'
          : `Writes ${preview.outputPath} and ${preview.sidecarPath}`}
      </Text>
      <Select
        label={
          <TipLabel
            label="Read preference"
            tip="Which replica set member is read from (--readPreference). Empty keeps the connection setting."
          />
        }
        data={[...READ_PREFERENCES]}
        value={effective.readPreference ?? null}
        allowDeselect={false}
        onChange={(value) => {
          patch({ readPreference: (value ?? undefined) as ReadPreferenceMode | undefined });
        }}
      />
      <Tooltip label={oplogReason} disabled={oplogReason === undefined}>
        <Checkbox
          label={
            <TipLabel
              label="Point-in-time (oplog)"
              tip="Also records oplog entries written during the dump so a restore can replay to a consistent point (--oplog). Replica sets, whole server only."
            />
          }
          checked={effective.oplog}
          disabled={oplogReason !== undefined}
          onChange={(event) => {
            patch({ oplog: event.currentTarget.checked });
          }}
        />
      </Tooltip>
      <Tooltip label={usersReason} disabled={usersReason === undefined}>
        <Checkbox
          label={
            <TipLabel
              label="Users and roles"
              tip="Includes the database users and custom roles (--dumpDbUsersAndRoles). Not for the admin database."
            />
          }
          checked={effective.dumpDbUsersAndRoles}
          disabled={usersReason !== undefined}
          onChange={(event) => {
            patch({ dumpDbUsersAndRoles: event.currentTarget.checked });
          }}
        />
      </Tooltip>
      <Checkbox
        label={
          <TipLabel
            label="Views as collections"
            tip="Dumps each view as a regular collection of its results instead of its definition (--viewsAsCollections)."
          />
        }
        checked={draft.viewsAsCollections}
        onChange={(event) => {
          patch({ viewsAsCollections: event.currentTarget.checked });
        }}
      />
      <Accordion variant="contained">
        <Accordion.Item value="advanced">
          <Accordion.Control>Advanced options</Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              <Checkbox
                label={
                  <TipLabel
                    label="Force table scan"
                    tip="Reads documents in natural order instead of through the _id index (--forceTableScan). Can help when the _id index is damaged."
                  />
                }
                checked={draft.forceTableScan}
                onChange={(event) => {
                  patch({ forceTableScan: event.currentTarget.checked });
                }}
              />
              <NumberInput
                label={
                  <TipLabel
                    label="Parallel collections"
                    tip="How many collections are dumped at the same time (--numParallelCollections)."
                  />
                }
                min={1}
                max={16}
                allowDecimal={false}
                value={draft.numParallelCollections}
                error={fieldError(problems, 'numParallelCollections')}
                onChange={(value) => {
                  patch({ numParallelCollections: typeof value === 'number' ? value : 0 });
                }}
              />
              <MultiSelect
                label={
                  <TipLabel
                    label="Network compression"
                    tip="Compresses traffic between the tool and the server (--compressors). The server must support the chosen algorithm."
                  />
                }
                data={[...COMPRESSORS]}
                value={[...draft.compressors]}
                clearable
                onChange={(value) => {
                  patch({ compressors: value as WireCompressor[] });
                }}
              />
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
      <ToolsVersionSelect
        installs={tools?.installs ?? []}
        value={draft.toolsVersion === '' ? null : draft.toolsVersion}
        onChange={(version) => {
          patch({ toolsVersion: version });
        }}
        onDownloaded={toolsDownloaded}
      />
      {namespaces.length === 0 ? null : (
        <Text size="sm" c="dimmed" data-testid="estimate">
          About {count(documents)} documents in {count(namespaces.length)} collections
        </Text>
      )}
      <CompatibilityFindings
        findings={findings}
        acknowledged={acknowledged}
        onAcknowledge={(code, checked) => {
          setAcknowledged((current) =>
            checked ? [...current, code] : current.filter((item) => item !== code),
          );
        }}
        connectionName={connectionName}
        confirmation={confirmation}
        onConfirmationChange={setConfirmation}
        onUseTools={(version) => {
          patch({ toolsVersion: version });
        }}
        onDownloaded={toolsDownloaded}
      />
      {loadProblem === undefined ? null : (
        <Alert color="red" role="alert">
          {loadProblem}
        </Alert>
      )}
      {scopeFailure === undefined ? null : (
        <Alert color="red" role="alert">
          {scopeFailure}
        </Alert>
      )}
      {job.problem === undefined ? null : (
        <Alert color="red" role="alert">
          {job.problem}
        </Alert>
      )}
      <Group justify="space-between">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        {startAction}
      </Group>
    </Stack>
  );
}
