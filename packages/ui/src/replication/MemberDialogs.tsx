import {
  Alert,
  Button,
  Code,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { AddMemberInputSchema, type ReconfigChange, type ReplicaSetMember } from '@mongo-gui/core';
import { errorText } from '../kit/notify-error';
import type { ReplicationStore } from './replication-store';
import { ActionModal, Callout } from './ReplicationDialogs';
import { TagsEditor } from './TagsEditor';
import {
  configDiff,
  duplicateTagKey,
  rowsToTags,
  tagsToRows,
  type DiffToken,
  type TagRow,
} from './replication-model';

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
 * Adds, edits or removes one member. The dialog plans the change as the user fills it in, and
 * Apply stays off until the plan of the current form comes back without a refusal. The plan is the
 * adapter's dry run.
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
  // The key of the form the last plan, or its failure, came from. A newer form shows neither.
  const [plannedKey, setPlannedKey] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<{ key: string; text: string } | undefined>(undefined);
  // Plans run one after another, so the store's pending plan is always the last one made.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(0);

  useEffect(() => () => clearPlan(), [clearPlan]);

  const change = buildChange();
  const key = change === undefined ? undefined : JSON.stringify(change);
  const unchanged = mode.kind === 'edit' && key === JSON.stringify(seedChange());

  useEffect(() => {
    latest.current += 1;
    const ticket = latest.current;
    clearPlan();
    if (change === undefined || key === undefined || unchanged) {
      return undefined;
    }
    const timer = setTimeout(
      () => {
        chain.current = chain.current.then(async () => {
          if (ticket !== latest.current) {
            return;
          }
          try {
            await planChange(change);
            if (ticket === latest.current) {
              setPlannedKey(key);
            }
          } catch (error) {
            if (ticket === latest.current) {
              setFailure({ key, text: errorText(error) });
            }
          }
        });
      },
      mode.kind === 'remove' ? 0 : PLAN_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
    // The key stands for the change, so a new object with the same content does not replan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, unchanged]);

  function seedChange(): ReconfigChange | undefined {
    return changeFor(mode, seed);
  }

  function buildChange(): ReconfigChange | undefined {
    return changeFor(mode, { host, priority, votes, hidden, arbiter, buildIndexes, delay, tags });
  }

  const planned = key !== undefined && plannedKey === key;
  const planError = failure !== undefined && failure.key === key ? failure.text : undefined;
  const plan = pending?.plan;
  const refused = planned ? plan?.refused : undefined;
  const canApply = planned && plan !== undefined && refused === undefined && !stale;
  const title = mode.kind === 'add' ? 'Add member' : TITLES[mode.kind];
  const subtitle = mode.kind === 'add' ? `Replica set ${setName}` : mode.member.name;

  const notice = (
    <Stack gap="xs">
      {planError === undefined ? null : (
        <Alert color="red" variant="light" role="alert">
          {planError}
        </Alert>
      )}
      {refused === undefined ? null : (
        <Callout color="red" title="This change is refused">
          {refused}
        </Callout>
      )}
      {planned && plan !== undefined && refused === undefined
        ? plan.warnings.map((warning) => <Callout key={warning}>{warning}</Callout>)
        : null}
      {planned && plan !== undefined && refused === undefined && mode.kind !== 'remove' ? (
        <Stack gap={4} aria-label="Change preview">
          <Text size="sm" fw={500}>
            Change preview
          </Text>
          <Code block aria-label="Config diff">
            {configDiff(plan.current, plan.next).map((line, row) => (
              <div key={row}>
                {line.map((token, index) => (
                  <span key={index} style={TOKEN_STYLE[token.kind]}>
                    {token.text}
                  </span>
                ))}
              </div>
            ))}
          </Code>
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
                setPlannedKey(undefined);
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
      subtitle={subtitle}
      confirmLabel={mode.kind === 'remove' ? 'Remove member' : 'Apply'}
      {...(mode.kind === 'remove'
        ? { confirmColor: 'red', confirmVariant: 'outline' as const }
        : {})}
      {...(mode.kind === 'remove'
        ? {}
        : {
            footerHint: `${mode.kind === 'add' ? 'Adding' : 'Editing'} changes the set configuration.`,
          })}
      confirmDisabled={!canApply}
      typedConfirmation={setName}
      notice={notice}
      onConfirm={() => applyPlan()}
      onClose={onClose}
    >
      {mode.kind === 'remove' ? (
        <Callout color="red">
          Remove {mode.member.name} from {setName}? It stops replicating and no longer votes. Data
          on the node is not deleted. A primary cannot be removed until it steps down.
        </Callout>
      ) : (
        <>
          <TextInput
            label="Host"
            placeholder="db4.example.net:27017"
            value={host}
            readOnly={mode.kind === 'edit'}
            onChange={(event) => setHost(event.currentTarget.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <SimpleGrid cols={2} verticalSpacing="sm">
            <Switch
              label="Arbiter"
              description="Votes but holds no data. Its priority is 0."
              checked={arbiter}
              disabled={mode.kind === 'edit'}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setArbiter(checked);
                if (checked) {
                  setPriority(0);
                }
              }}
            />
            <Switch
              label="Build indexes"
              description="Turn off only for a pure backup member."
              checked={buildIndexes}
              disabled={mode.kind === 'edit'}
              onChange={(event) => setBuildIndexes(event.currentTarget.checked)}
            />
            <Switch
              label="Hidden"
              description="Takes no client reads and must have priority 0."
              checked={hidden}
              onChange={(event) => setHidden(event.currentTarget.checked)}
            />
          </SimpleGrid>
          <SimpleGrid cols={3} style={{ alignItems: 'start' }}>
            <NumberInput
              label="Priority"
              inputWrapperOrder={INPUT_FIRST}
              description="0 to 1000. Zero never becomes primary."
              min={0}
              max={1000}
              allowDecimal={false}
              value={priority}
              onChange={(value) => setPriority(Number(value) || 0)}
            />
            <Select
              label="Votes"
              inputWrapperOrder={INPUT_FIRST}
              allowDeselect={false}
              data={[
                { value: '1', label: '1' },
                { value: '0', label: '0' },
              ]}
              value={String(votes)}
              onChange={(value) => setVotes(value === '0' ? 0 : 1)}
            />
            <NumberInput
              label="Delay in seconds"
              inputWrapperOrder={INPUT_FIRST}
              description="A delayed member never becomes primary."
              min={0}
              allowDecimal={false}
              value={delay}
              onChange={(value) => setDelay(Number(value) || 0)}
            />
          </SimpleGrid>
          <TagsEditor rows={tags} onChange={setTags} />
        </>
      )}
    </ActionModal>
  );
}

const PLAN_DEBOUNCE_MS = 300;

const TOKEN_STYLE: Readonly<Record<DiffToken['kind'], CSSProperties>> = {
  plain: {},
  key: { color: 'var(--mg-code-key)' },
  string: { color: 'var(--mg-code-string)' },
  number: { color: 'var(--mg-code-number)' },
};

/** Puts a field's description under its input, so inputs in one row line up. */
const INPUT_FIRST: ('label' | 'input' | 'description' | 'error')[] = [
  'label',
  'input',
  'description',
  'error',
];

/** The change a form stands for, or undefined while it cannot be planned yet. */
function changeFor(mode: MemberDialogMode, form: FormSeed): ReconfigChange | undefined {
  if (mode.kind === 'remove') {
    return { kind: 'remove', memberId: mode.member.id };
  }
  if (duplicateTagKey(form.tags) !== undefined) {
    return undefined;
  }
  if (mode.kind === 'edit') {
    return {
      kind: 'update',
      memberId: mode.member.id,
      patch: {
        priority: form.priority,
        votes: form.votes,
        hidden: form.hidden,
        secondaryDelaySecs: form.delay,
        tags: rowsToTags(form.tags),
      },
    };
  }
  if (!AddMemberInputSchema.shape.host.safeParse(form.host.trim()).success) {
    return undefined;
  }
  return {
    kind: 'add',
    member: {
      host: form.host.trim(),
      priority: form.priority,
      votes: form.votes,
      hidden: form.hidden,
      arbiterOnly: form.arbiter,
      buildIndexes: form.buildIndexes,
      secondaryDelaySecs: form.delay,
      tags: rowsToTags(form.tags),
    },
  };
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
