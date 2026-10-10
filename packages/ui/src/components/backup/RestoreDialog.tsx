import {
  Accordion,
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  assessRestore,
  unresolvedFindings,
  type BackupInspection,
  type BackupServerInfo,
  type FindingCode,
  type ToolsListOutput,
  type ToolsVersion,
} from '@mongo-gui/core';
import { useEffect, useMemo, useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { useAppStore } from '../../state/app-store-context';
import { errorText, runReported } from '../notify-error';
import { ToolsVersionSelect } from '../tools/ToolsVersionSelect';
import { BackupProgressView } from './BackupProgressView';
import { CompatibilityFindings } from './CompatibilityFindings';
import { useBackupDialogs, type BackupDialogRequest } from './backup-dialog-store';
import type { BackupProblem } from './backup-model';
import { RestoreContentsTree } from './RestoreContentsTree';
import { RestoreSourceSummary } from './RestoreSourceSummary';
import {
  defaultRestoreTools,
  draftFromInspection,
  includeFrom,
  isCollectionChecked,
  renameRows,
  renamesOf,
  restoreProblemsOf,
  restoreStartInput,
  setRename,
  type RestoreDraft,
} from './restore-model';
import { useBackupJob } from './use-backup-job';

export interface RestoreDialogProps {
  readonly request: Extract<BackupDialogRequest, { kind: 'restore' }>;
}

export interface RestoreDialogBodyProps {
  readonly connectionId: string;
  /** Set when the dialog was opened from a database menu. */
  readonly database?: string | undefined;
  readonly onClose: () => void;
  /** Tells the modal when a job runs, so it can refuse to close. */
  readonly onRunningChange?: (running: boolean) => void;
}

// The dialog schema accepts letters and digits only as extensions, so there is no "All files"
// entry. A backup with another extension can still be restored from its folder or sidecar.
const ARCHIVE_FILTERS = [{ name: 'Backups', extensions: ['archive', 'gz', 'agz', 'json'] }];

/** Modal that restores a backup into a connection with mongorestore. */
export function RestoreDialog({ request }: RestoreDialogProps) {
  const close = useBackupDialogs((state) => state.close);
  const [running, setRunning] = useState(false);
  const connections = useAppStore((state) => state.connections);
  const name =
    connections.state === 'ready'
      ? connections.data.find((item) => item.id === request.connectionId)?.name
      : undefined;
  return (
    <Modal
      opened
      onClose={close}
      title={`Restore into ${name ?? 'connection'}`}
      size="xl"
      centered
      closeOnClickOutside={!running}
      closeOnEscape={!running}
      withCloseButton={!running}
    >
      <RestoreDialogBody
        connectionId={request.connectionId}
        database={request.database}
        onClose={close}
        onRunningChange={setRunning}
      />
    </Modal>
  );
}

function fieldError(problems: readonly BackupProblem[], field: string): string | undefined {
  return problems.find((problem) => problem.field === field)?.message;
}

/** The dialog without its modal, so the form and the progress can be shown on their own. */
export function RestoreDialogBody({
  connectionId,
  database,
  onClose,
  onRunningChange,
}: RestoreDialogBodyProps) {
  const { rpc } = useUiApi();
  const job = useBackupJob();
  const connections = useAppStore((state) => state.connections);
  const profile =
    connections.state === 'ready'
      ? connections.data.find((item) => item.id === connectionId)
      : undefined;
  const connectionName = profile?.name ?? 'connection';

  const [tools, setTools] = useState<ToolsListOutput | undefined>(undefined);
  const [available, setAvailable] = useState<readonly string[]>([]);
  const [target, setTarget] = useState<BackupServerInfo | undefined>(undefined);
  const [inspection, setInspection] = useState<BackupInspection | undefined>(undefined);
  const [draft, setDraft] = useState<RestoreDraft | undefined>(undefined);
  const [inspecting, setInspecting] = useState(false);
  const [acknowledged, setAcknowledged] = useState<readonly FindingCode[]>([]);
  const [confirmation, setConfirmation] = useState('');
  const [loadProblem, setLoadProblem] = useState<string | undefined>(undefined);

  useEffect(() => {
    onRunningChange?.(job.running);
  }, [job.running, onRunningChange]);

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
      setTarget(info);
      setAvailable(feed?.versions.map((item) => item.version) ?? []);
    })().catch((failure: unknown) => {
      setLoadProblem(errorText(failure));
    });
    return () => {
      active = false;
    };
  }, [rpc, connectionId]);

  const installed = useMemo(
    () =>
      (tools?.installs ?? [])
        .filter((install) => install.health.state === 'ok')
        .map((install) => install.version),
    [tools],
  );

  async function choose(directory: boolean) {
    await runReported(async () => {
      const picked = await rpc.app.showOpenDialog({
        title: directory ? 'Choose the backup folder' : 'Choose the backup archive',
        directory,
        filters: directory ? [] : ARCHIVE_FILTERS,
      });
      if (picked.path === undefined) {
        return;
      }
      setInspecting(true);
      try {
        const found = await rpc.backup.inspect({ path: picked.path });
        setInspection(found);
        setDraft(
          draftFromInspection(found, {
            targetDatabase: database,
            installedVersions: installed,
            preference: tools?.resolved,
          }),
        );
        setAcknowledged([]);
        setConfirmation('');
      } finally {
        setInspecting(false);
      }
    });
  }

  const filtered = draft !== undefined && includeFrom(draft) !== undefined;
  const renaming = draft !== undefined && renamesOf(draft).length > 0;
  const oplogReason =
    inspection === undefined || !inspection.hasOplog
      ? 'The backup holds no oplog.'
      : renaming || filtered
        ? 'An oplog replay needs the whole backup without renames.'
        : undefined;
  const usersReason =
    inspection?.hasUsersAndRoles === true ? undefined : 'The backup holds no users or roles.';

  // Options the form disables are dropped from what is checked and sent.
  const effective = useMemo<RestoreDraft | undefined>(
    () =>
      draft === undefined || inspection === undefined
        ? undefined
        : {
            ...draft,
            // A backup can be picked before the tools list arrives, so the default is applied
            // here again once the list is known.
            toolsVersion:
              draft.toolsVersion === ''
                ? defaultRestoreTools(inspection, installed, tools?.resolved)
                : draft.toolsVersion,
            oplogReplay: draft.oplogReplay && oplogReason === undefined,
            oplogLimit: draft.oplogReplay && oplogReason === undefined ? draft.oplogLimit : '',
            restoreDbUsersAndRoles: draft.restoreDbUsersAndRoles && usersReason === undefined,
            preserveUUID: draft.preserveUUID && draft.drop,
          },
    [draft, inspection, installed, tools, oplogReason, usersReason],
  );

  const problems = useMemo(
    () =>
      effective === undefined || inspection === undefined
        ? []
        : restoreProblemsOf(effective, inspection),
    [effective, inspection],
  );

  const findings = useMemo(() => {
    if (effective === undefined || inspection === undefined || target === undefined) {
      return [];
    }
    if (effective.toolsVersion === '') {
      return [];
    }
    const { sidecar, prelude } = inspection;
    const serverVersion = sidecar?.source.serverVersion ?? prelude?.serverVersion;
    const fcv = sidecar?.source.fcv;
    const toolsVersion = sidecar?.tools.version ?? prelude?.toolsVersion;
    const include = includeFrom(effective);
    return assessRestore({
      dump: {
        sidecar: sidecar !== undefined,
        sidecarNewerFormat:
          sidecar === undefined && inspection.sidecarProblem === 'Made by a newer Mongo GUI',
        ...(serverVersion === undefined ? {} : { serverVersion }),
        ...(fcv === undefined ? {} : { fcv }),
        ...(toolsVersion === undefined ? {} : { toolsVersion }),
        namespaces: inspection.namespaces.filter((item) =>
          isCollectionChecked(effective, item.database, item.collection),
        ),
      },
      target,
      tools: { selected: effective.toolsVersion, installed, available },
      options: {
        ...(include === undefined ? {} : { include }),
        drop: effective.drop,
        oplogReplay: effective.oplogReplay,
        preserveUUID: effective.preserveUUID,
      },
    });
  }, [effective, inspection, target, installed, available]);

  const unresolved = unresolvedFindings(findings, acknowledged, confirmation, connectionName);
  const blocker = problems[0]?.message ?? unresolved[0]?.message;

  function patch(next: Partial<RestoreDraft>) {
    setDraft((current) => (current === undefined ? current : { ...current, ...next }));
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

  function start() {
    if (effective === undefined || inspection === undefined) {
      return;
    }
    void job.start(
      'restore',
      restoreStartInput(effective, {
        connectionId,
        source: inspection.path,
        acknowledged,
        confirmation,
      }),
    );
  }

  if (job.starting || job.view !== undefined) {
    return (
      <Stack gap="md">
        <BackupProgressView
          view={job.view}
          kind="restore"
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

  const rows = effective === undefined ? [] : renameRows(effective, target?.databases ?? []);

  return (
    <Stack gap="md">
      <Group>
        <Button
          variant="default"
          loading={inspecting}
          onClick={() => {
            void choose(false);
          }}
        >
          Choose archive…
        </Button>
        <Button
          variant="default"
          loading={inspecting}
          onClick={() => {
            void choose(true);
          }}
        >
          Choose folder…
        </Button>
        <Text size="sm" c="dimmed" style={{ flex: 1 }} truncate>
          {inspection?.path ?? 'Choose the backup to restore.'}
        </Text>
      </Group>
      {inspection === undefined || draft === undefined || effective === undefined ? null : (
        <>
          <RestoreSourceSummary inspection={inspection} />
          <Text fw={500} size="sm">
            Contents
          </Text>
          {/* The tree gets the raw draft. Given `effective`, it would write the options the
              form forces off back into the draft, and they would stay off. */}
          <RestoreContentsTree
            draft={draft}
            namespaces={inspection.namespaces}
            onChange={setDraft}
          />
          {fieldError(problems, 'include') === undefined ? null : (
            <Text size="xs" c="red">
              {fieldError(problems, 'include')}
            </Text>
          )}
          <Text fw={500} size="sm">
            Restore as
          </Text>
          <Stack gap="xs" data-testid="rename-rows">
            {rows.map((row) => (
              <Group key={row.from} gap="sm" wrap="nowrap" align="flex-start">
                <Text size="sm" w={140} pt={6} truncate>
                  {row.from}
                </Text>
                <Text size="sm" pt={6}>
                  →
                </Text>
                <TextInput
                  aria-label={`Restore ${row.from} as`}
                  value={row.to}
                  style={{ flex: 1 }}
                  onChange={(event) => {
                    // Read the value now. React clears currentTarget before the updater runs.
                    const to = event.currentTarget.value;
                    setDraft((current) =>
                      current === undefined ? current : setRename(current, row.from, to),
                    );
                  }}
                />
                {row.exists ? (
                  <Tooltip label="Collections are merged unless Drop is on.">
                    <Text size="xs" c="orange" pt={8}>
                      exists
                    </Text>
                  </Tooltip>
                ) : null}
              </Group>
            ))}
            {fieldError(problems, 'renames') === undefined ? null : (
              <Text size="xs" c="red">
                {fieldError(problems, 'renames')}
              </Text>
            )}
          </Stack>
          <Checkbox
            label="Drop collections before restoring"
            styles={{ label: { color: 'var(--mantine-color-red-text)' } }}
            checked={draft?.drop ?? false}
            onChange={(event) => {
              patch({ drop: event.currentTarget.checked });
            }}
          />
          <Checkbox
            label="Dry run"
            checked={draft?.dryRun ?? false}
            onChange={(event) => {
              patch({ dryRun: event.currentTarget.checked });
            }}
          />
          {inspection.hasOplog ? (
            <Tooltip label={oplogReason} disabled={oplogReason === undefined}>
              <Checkbox
                label="Replay oplog"
                checked={effective.oplogReplay}
                disabled={oplogReason !== undefined}
                error={fieldError(problems, 'oplogReplay')}
                onChange={(event) => {
                  patch({ oplogReplay: event.currentTarget.checked });
                }}
              />
            </Tooltip>
          ) : null}
          {inspection.hasUsersAndRoles ? (
            <Checkbox
              label="Restore users and roles"
              checked={effective.restoreDbUsersAndRoles}
              error={fieldError(problems, 'restoreDbUsersAndRoles')}
              onChange={(event) => {
                patch({ restoreDbUsersAndRoles: event.currentTarget.checked });
              }}
            />
          ) : null}
          <Tooltip label="Preserving UUIDs needs Drop." disabled={effective.drop}>
            <Checkbox
              label="Preserve UUIDs"
              checked={effective.preserveUUID}
              disabled={!effective.drop}
              onChange={(event) => {
                patch({ preserveUUID: event.currentTarget.checked });
              }}
            />
          </Tooltip>
          {inspection.sidecar === undefined ? null : (
            <Checkbox
              label="Verify checksum"
              checked={effective.verifyChecksum}
              onChange={(event) => {
                patch({ verifyChecksum: event.currentTarget.checked });
              }}
            />
          )}
          <Accordion variant="contained">
            <Accordion.Item value="advanced">
              <Accordion.Control>Advanced options</Accordion.Control>
              <Accordion.Panel>
                <Stack gap="sm">
                  <Checkbox
                    label="Skip indexes"
                    checked={effective.noIndexRestore}
                    onChange={(event) => {
                      patch({ noIndexRestore: event.currentTarget.checked });
                    }}
                  />
                  <Checkbox
                    label="Skip collection options"
                    checked={effective.noOptionsRestore}
                    onChange={(event) => {
                      patch({ noOptionsRestore: event.currentTarget.checked });
                    }}
                  />
                  <Checkbox
                    label="Convert legacy indexes"
                    checked={effective.convertLegacyIndexes}
                    onChange={(event) => {
                      patch({ convertLegacyIndexes: event.currentTarget.checked });
                    }}
                  />
                  <Checkbox
                    label="Maintain insertion order"
                    checked={effective.maintainInsertionOrder}
                    onChange={(event) => {
                      patch({ maintainInsertionOrder: event.currentTarget.checked });
                    }}
                  />
                  <Checkbox
                    label="Stop on first error"
                    checked={effective.stopOnError}
                    onChange={(event) => {
                      patch({ stopOnError: event.currentTarget.checked });
                    }}
                  />
                  <Checkbox
                    label="Bypass document validation"
                    checked={effective.bypassDocumentValidation}
                    onChange={(event) => {
                      patch({ bypassDocumentValidation: event.currentTarget.checked });
                    }}
                  />
                  <Checkbox
                    label="Validate objects"
                    checked={effective.objcheck}
                    onChange={(event) => {
                      patch({ objcheck: event.currentTarget.checked });
                    }}
                  />
                  <Select
                    label="Write concern"
                    data={['majority', '1', '0']}
                    value={effective.writeConcern}
                    allowDeselect={false}
                    onChange={(value) => {
                      if (value === 'majority' || value === '1' || value === '0') {
                        patch({ writeConcern: value });
                      }
                    }}
                  />
                  <NumberInput
                    label="Parallel collections"
                    min={1}
                    max={16}
                    allowDecimal={false}
                    value={effective.numParallelCollections}
                    onChange={(value) => {
                      patch({ numParallelCollections: typeof value === 'number' ? value : 0 });
                    }}
                  />
                  <NumberInput
                    label="Insertion workers"
                    min={1}
                    max={16}
                    allowDecimal={false}
                    value={effective.numInsertionWorkersPerCollection}
                    onChange={(value) => {
                      patch({
                        numInsertionWorkersPerCollection: typeof value === 'number' ? value : 0,
                      });
                    }}
                  />
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
          <ToolsVersionSelect
            installs={tools?.installs ?? []}
            value={effective.toolsVersion === '' ? null : effective.toolsVersion}
            onChange={(version) => {
              patch({ toolsVersion: version });
            }}
            onDownloaded={toolsDownloaded}
          />
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
        </>
      )}
      {loadProblem === undefined ? null : (
        <Alert color="red" role="alert">
          {loadProblem}
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
        <Tooltip
          label={inspection === undefined ? 'Choose a backup first' : blocker}
          disabled={inspection !== undefined && blocker === undefined}
        >
          <Button
            disabled={inspection === undefined || blocker !== undefined}
            loading={job.starting}
            onClick={start}
          >
            {draft?.dryRun === true ? 'Run dry run' : 'Restore'}
          </Button>
        </Tooltip>
      </Group>
    </Stack>
  );
}
