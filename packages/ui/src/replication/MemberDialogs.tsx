import {
  Alert,
  Button,
  Group,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import type { ReconfigChange, ReplicaSetMember } from '@mongo-gui/core';
import { errorText } from '../components/notify-error';
import type { ReplicationStore } from './replication-store';
import { ActionModal } from './ReplicationDialogs';
import { TagsEditor } from './TagsEditor';
import { rowsToTags, tagsToRows, type TagRow } from './replication-model';

export type MemberDialogMode =
  | { readonly kind: 'add' }
  | { readonly kind: 'edit'; readonly member: ReplicaSetMember }
  | { readonly kind: 'remove'; readonly member: ReplicaSetMember };

export interface MemberDialogProps {
  readonly mode: MemberDialogMode;
  readonly setName: string;
  readonly store: ReplicationStore;
  readonly onClose: () => void;
}

const TITLES: Readonly<Record<MemberDialogMode['kind'], string>> = {
  add: 'Add member',
  edit: 'Edit member',
  remove: 'Remove member',
};

/**
 * Adds, edits or removes one member. The user fills in the change, previews it, and only then can
 * apply it. The preview is the adapter's dry run. A refused preview names the reason and keeps
 * Apply disabled.
 */
export function MemberDialog({ mode, setName, store, onClose }: MemberDialogProps) {
  const pending = useStore(store, (state) => state.pending);
  const stale = useStore(store, (state) => state.stale);
  const planChange = useStore(store, (state) => state.planChange);
  const applyPlan = useStore(store, (state) => state.applyPlan);
  const refresh = useStore(store, (state) => state.refresh);
  const clearPlan = useStore(store, (state) => state.clearPlan);
  const seed = seedFor(mode);
  const [host, setHost] = useState(seed.host);
  const [priority, setPriority] = useState(seed.priority);
  const [votes, setVotes] = useState<number>(seed.votes);
  const [hidden, setHidden] = useState(seed.hidden);
  const [arbiter, setArbiter] = useState(seed.arbiter);
  const [buildIndexes, setBuildIndexes] = useState(seed.buildIndexes);
  const [delay, setDelay] = useState(seed.delay);
  const [tags, setTags] = useState<TagRow[]>(seed.tags);
  const [previewError, setPreviewError] = useState<string | undefined>(undefined);
  // The preview is valid only for the form it was made from. Any edit clears it.
  const [previewed, setPreviewed] = useState(false);

  useEffect(() => () => clearPlan(), [clearPlan]);

  function edited() {
    setPreviewed(false);
    setPreviewError(undefined);
    clearPlan();
  }

  function buildChange(): ReconfigChange | undefined {
    if (mode.kind === 'remove') {
      return { kind: 'remove', memberId: mode.member.id };
    }
    if (mode.kind === 'edit') {
      return {
        kind: 'update',
        memberId: mode.member.id,
        patch: { priority, votes, hidden, secondaryDelaySecs: delay, tags: rowsToTags(tags) },
      };
    }
    if (host.trim() === '') {
      return undefined;
    }
    return {
      kind: 'add',
      member: {
        host: host.trim(),
        priority,
        votes,
        hidden,
        arbiterOnly: arbiter,
        buildIndexes,
        secondaryDelaySecs: delay,
        tags: rowsToTags(tags),
      },
    };
  }

  async function preview() {
    setPreviewError(undefined);
    const change = buildChange();
    if (change === undefined) {
      setPreviewError('Enter the host name of the member, such as db4.example.net:27017');
      return;
    }
    try {
      await planChange(change);
      setPreviewed(true);
    } catch (failure) {
      setPreviewError(errorText(failure));
    }
  }

  const plan = pending?.plan;
  const refused = plan?.refused;
  const canApply = previewed && plan !== undefined && refused === undefined && !stale;
  const title = `${TITLES[mode.kind]}${mode.kind === 'add' ? '' : ` ${mode.member.name}`}`;

  const notice = (
    <Stack gap="xs">
      {previewError === undefined ? null : (
        <Alert color="red" variant="light" role="alert">
          {previewError}
        </Alert>
      )}
      {previewed && refused !== undefined ? (
        <Alert color="red" variant="light" title="This change is refused" role="alert">
          {refused}
        </Alert>
      ) : null}
      {previewed && plan !== undefined && refused === undefined ? (
        <Stack gap={4} aria-label="Dry run">
          <Text size="sm" fw={500}>
            Dry run
          </Text>
          {plan.changes.map((change) => (
            <Text key={change} size="sm">
              {change}
            </Text>
          ))}
          {plan.warnings.map((warning) => (
            <Text key={warning} size="sm" c="orange">
              {warning}
            </Text>
          ))}
        </Stack>
      ) : null}
      {stale ? (
        <Alert color="orange" variant="light" title="The configuration changed" role="alert">
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm">Someone else changed the set after this plan was made.</Text>
            <Button
              size="xs"
              variant="default"
              onClick={() => {
                void refresh();
                setPreviewed(false);
              }}
            >
              Refresh
            </Button>
          </Group>
        </Alert>
      ) : null}
    </Stack>
  );

  return (
    <ActionModal
      title={title}
      confirmLabel="Apply"
      confirmColor={mode.kind === 'remove' ? 'red' : 'blue'}
      confirmDisabled={!canApply}
      typedConfirmation={setName}
      notice={notice}
      onConfirm={() => applyPlan()}
      onClose={onClose}
    >
      {mode.kind === 'remove' ? (
        <Text size="sm">
          Remove {mode.member.name} from {setName}. The member stops replicating and its vote goes
          with it. A primary cannot be removed until it steps down.
        </Text>
      ) : null}
      {mode.kind === 'add' ? (
        <>
          <TextInput
            label="Host"
            placeholder="db4.example.net:27017"
            value={host}
            onChange={(event) => {
              setHost(event.currentTarget.value);
              edited();
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <Switch
            label="Arbiter"
            description="Votes but holds no data. Its priority is 0."
            checked={arbiter}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              setArbiter(checked);
              if (checked) {
                setPriority(0);
              }
              edited();
            }}
          />
          <Switch
            label="Build indexes"
            checked={buildIndexes}
            onChange={(event) => {
              setBuildIndexes(event.currentTarget.checked);
              edited();
            }}
          />
        </>
      ) : null}
      {mode.kind === 'edit' ? (
        <Text size="sm" c="dimmed">
          {mode.member.name}: arbiter and build-index settings stay as they are. Change those by
          removing the member and adding it again.
        </Text>
      ) : null}
      {mode.kind === 'remove' ? null : (
        <>
          <NumberInput
            label="Priority"
            description="0 to 1000. Zero never becomes primary."
            min={0}
            max={1000}
            allowDecimal={false}
            value={priority}
            onChange={(value) => {
              setPriority(Number(value) || 0);
              edited();
            }}
          />
          <Select
            label="Votes"
            allowDeselect={false}
            data={[
              { value: '1', label: '1' },
              { value: '0', label: '0' },
            ]}
            value={String(votes)}
            onChange={(value) => {
              setVotes(value === '0' ? 0 : 1);
              edited();
            }}
          />
          <Switch
            label="Hidden"
            description="Hidden members take no client reads and must have priority 0."
            checked={hidden}
            onChange={(event) => {
              setHidden(event.currentTarget.checked);
              edited();
            }}
          />
          <NumberInput
            label="Delay in seconds"
            description="A delayed member never becomes primary."
            min={0}
            allowDecimal={false}
            value={delay}
            onChange={(value) => {
              setDelay(Number(value) || 0);
              edited();
            }}
          />
          <TagsEditor
            rows={tags}
            onChange={(rows) => {
              setTags(rows);
              edited();
            }}
          />
        </>
      )}
      <Group justify="flex-end">
        <Button variant="default" size="xs" onClick={() => void preview()}>
          Preview change
        </Button>
      </Group>
    </ActionModal>
  );
}

interface FormSeed {
  readonly host: string;
  readonly priority: number;
  readonly votes: number;
  readonly hidden: boolean;
  readonly arbiter: boolean;
  readonly buildIndexes: boolean;
  readonly delay: number;
  readonly tags: TagRow[];
}

function seedFor(mode: MemberDialogMode): FormSeed {
  if (mode.kind === 'edit' || mode.kind === 'remove') {
    const member = mode.member;
    return {
      host: member.name,
      priority: member.priority,
      votes: member.votes,
      hidden: member.hidden,
      arbiter: member.arbiterOnly,
      buildIndexes: member.buildIndexes,
      delay: member.secondaryDelaySecs,
      tags: tagsToRows(member.tags),
    };
  }
  return {
    host: '',
    priority: 1,
    votes: 1,
    hidden: false,
    arbiter: false,
    buildIndexes: true,
    delay: 0,
    tags: [],
  };
}
