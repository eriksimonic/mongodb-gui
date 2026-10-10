import { Alert, Button, Group, Modal, NumberInput, Stack, Text, TextInput } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import {
  AddMemberInputSchema,
  MAX_STEP_DOWN_SECONDS,
  MIN_STEP_DOWN_SECONDS,
  type InitiateMemberInput,
} from '@mongo-gui/core';
import { errorText } from '../components/notify-error';

export interface ActionModalProps {
  readonly title: string;
  readonly confirmLabel: string;
  readonly confirmColor?: string;
  readonly confirmDisabled?: boolean;
  /** When set, Apply stays disabled until the user types this text exactly. */
  readonly typedConfirmation?: string | undefined;
  /** Shown above the buttons, such as a refusal or a refresh offer. */
  readonly notice?: ReactNode;
  readonly onConfirm: () => Promise<void>;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/**
 * A dialog with one confirm action. The action's failure stays in the dialog, so the user can
 * correct the input and try again. A success closes the dialog.
 */
export function ActionModal({
  title,
  confirmLabel,
  confirmColor = 'blue',
  confirmDisabled = false,
  typedConfirmation,
  notice,
  onConfirm,
  onClose,
  children,
}: ActionModalProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const typedMatches = typedConfirmation === undefined || typed === typedConfirmation;
  const disabled = confirmDisabled || !typedMatches || busy;

  async function confirm() {
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title={title} centered size="md">
      <Stack gap="sm">
        {children}
        {typedConfirmation === undefined ? null : (
          <TextInput
            label={`Type ${typedConfirmation} to confirm`}
            aria-label={`Type ${typedConfirmation} to confirm`}
            value={typed}
            onChange={(event) => setTyped(event.currentTarget.value)}
            autoComplete="off"
            spellCheck={false}
          />
        )}
        {notice}
        {error === undefined ? null : (
          <Alert color="red" variant="light" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            color={confirmColor}
            disabled={disabled}
            loading={busy}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export interface StepDownDialogProps {
  readonly primary: string;
  readonly onStepDown: (seconds: number) => Promise<string>;
  readonly onClose: () => void;
}

/** Steps the primary down for a number of seconds. The set elects a new primary meanwhile. */
export function StepDownDialog({ primary, onStepDown, onClose }: StepDownDialogProps) {
  const [seconds, setSeconds] = useState<number>(60);
  return (
    <ActionModal
      title="Step down primary"
      confirmLabel="Step down"
      confirmColor="orange"
      confirmDisabled={!inRange(seconds, MIN_STEP_DOWN_SECONDS, MAX_STEP_DOWN_SECONDS)}
      onConfirm={async () => {
        await onStepDown(seconds);
      }}
      onClose={onClose}
    >
      <Text size="sm">
        {primary} gives up the primary and will not seek election again for the time below. The
        connection to this server drops while the new primary takes over.
      </Text>
      <NumberInput
        label="Seconds"
        description={`At least ${MIN_STEP_DOWN_SECONDS}: the server needs longer than its 10 second catch-up.`}
        value={seconds}
        min={MIN_STEP_DOWN_SECONDS}
        max={MAX_STEP_DOWN_SECONDS}
        onChange={(value) => setSeconds(Number(value))}
        allowDecimal={false}
      />
    </ActionModal>
  );
}

export interface FreezeDialogProps {
  readonly member: string;
  readonly onFreeze: (seconds: number) => Promise<void>;
  readonly onClose: () => void;
}

/** Freezes the connected member, so it does not seek election for the time below. */
export function FreezeDialog({ member, onFreeze, onClose }: FreezeDialogProps) {
  const [seconds, setSeconds] = useState<number>(60);
  return (
    <ActionModal
      title="Freeze member"
      confirmLabel="Freeze"
      confirmColor="orange"
      confirmDisabled={!inRange(seconds, 0, MAX_STEP_DOWN_SECONDS)}
      onConfirm={() => onFreeze(seconds)}
      onClose={onClose}
    >
      <Text size="sm">
        {member} will not seek election for the time below. Zero unfreezes it. A freeze acts only on
        the member this connection points at.
      </Text>
      <NumberInput
        label="Seconds"
        value={seconds}
        min={0}
        allowDecimal={false}
        onChange={(value) => setSeconds(Number(value))}
      />
    </ActionModal>
  );
}

export interface InitiateDialogProps {
  /** The node's own host from its hello reply. Undefined while it is unknown. */
  readonly defaultHost: string | undefined;
  readonly onInitiate: (input: {
    setName: string;
    members: InitiateMemberInput[];
  }) => Promise<void>;
  readonly onClose: () => void;
}

/**
 * Starts a set on a standalone node started with --replSet. The set begins with the one member,
 * the node the connection points at. More members are added after the set is up.
 */
export function InitiateDialog({ defaultHost, onInitiate, onClose }: InitiateDialogProps) {
  const [setName, setSetName] = useState('rs0');
  // The node's own address arrives after the dialog opens. It shows until the user types a host.
  const [typedHost, setTypedHost] = useState<string | undefined>(undefined);
  const host = typedHost ?? defaultHost ?? '';
  const setNameValid = /^[A-Za-z0-9_-]+$/.test(setName);
  const hostCheck = AddMemberInputSchema.shape.host.safeParse(host);
  const hostError = hostCheck.success ? undefined : hostCheck.error.issues[0]?.message;
  return (
    <ActionModal
      title="Initiate replica set"
      confirmLabel="Initiate"
      confirmDisabled={!setNameValid || !hostCheck.success}
      typedConfirmation={setName}
      onConfirm={() => onInitiate({ setName, members: [{ host: host.trim() }] })}
      onClose={onClose}
    >
      <Text size="sm">
        Start the set {setName || '(unnamed)'} with {host || 'the node'} as its only member. The
        node elects itself primary. This writes the configuration to the node and cannot be undone
        from this panel. Add the other members after the set is up.
      </Text>
      <TextInput
        label="Set name"
        value={setName}
        error={setNameValid ? undefined : 'Use letters, digits, dashes and underscores'}
        onChange={(event) => setSetName(event.currentTarget.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <TextInput
        label="Host"
        description="The address other members use to reach this node."
        value={host}
        error={host === '' ? undefined : hostError}
        onChange={(event) => {
          setTypedHost(event.currentTarget.value);
        }}
        autoComplete="off"
        spellCheck={false}
      />
    </ActionModal>
  );
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}
