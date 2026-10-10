import { Button, Group, Modal, PasswordInput, Stack, Text } from '@mantine/core';
import { useState, type FormEvent } from 'react';
import { useUiApi } from '../../api/ui-api';
import { invalidInputStyles } from '../../screens/field-state';
import { PasswordStrengthMeter } from '../../screens/PasswordStrengthMeter';
import { errorText } from '../notify-error';
import { isChangePasswordValid, validateChangePassword } from './change-password';

export interface ChangePasswordModalProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  /** Runs after the password changed. The settings screen shows its confirmation. */
  readonly onChanged: () => void;
}

/**
 * Changes the master password. Errors show after the first submit. The vault re-wraps its key
 * with the new password, so the stored data is not rewritten.
 */
export function ChangePasswordModal({ opened, onClose, onChanged }: ChangePasswordModalProps) {
  return (
    <Modal opened={opened} onClose={onClose} title="Change master password" size="sm" centered>
      {opened ? <ChangePasswordForm onClose={onClose} onChanged={onChanged} /> : null}
    </Modal>
  );
}

interface FormProps {
  readonly onClose: () => void;
  readonly onChanged: () => void;
}

function ChangePasswordForm({ onClose, onChanged }: FormProps) {
  const { rpc } = useUiApi();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const errors = validateChangePassword({ current, next, confirmation });
  const shown = submitted
    ? errors
    : { current: undefined, password: undefined, confirmation: undefined };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (busy || !isChangePasswordValid(errors)) {
      return;
    }
    setBusy(true);
    setFailure(undefined);
    try {
      await rpc.vault.changePassword({ current, next });
      onChanged();
      onClose();
    } catch (error) {
      // The server gives the reason, for example a wrong current password.
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate>
      <Stack gap="sm">
        <PasswordInput
          label="Current master password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.currentTarget.value)}
          error={shown.current}
          styles={invalidInputStyles(shown.current)}
          autoFocus
        />
        <PasswordInput
          label="New master password"
          description="At least 10 characters."
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.currentTarget.value)}
          error={shown.password}
          styles={invalidInputStyles(shown.password)}
        />
        <PasswordStrengthMeter password={next} />
        <PasswordInput
          label="Confirm new master password"
          autoComplete="new-password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.currentTarget.value)}
          error={shown.confirmation}
          styles={invalidInputStyles(shown.confirmation)}
        />
        {failure === undefined ? null : (
          <Text size="sm" c="red" role="alert">
            {failure}
          </Text>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Change password
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
