import { Button, Group, Modal, PasswordInput, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useState, type FormEvent } from 'react';
import { errorText } from '../kit/notify-error';
import { invalidInputStyles } from '../screens/field-state';
import { PasswordStrengthMeter } from '../screens/PasswordStrengthMeter';
import { validateNewPassword } from '../screens/password-rules';
import { useAppStore } from '../state/app-store-context';

export interface SetPasswordModalProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  /** Runs after the master password is set. */
  readonly onDone: () => void;
}

/** Sets a master password on a vault that uses machine encryption. */
export function SetPasswordModal({ opened, onClose, onDone }: SetPasswordModalProps) {
  return (
    <Modal opened={opened} onClose={onClose} title="Set master password" size="sm" centered>
      {opened ? <SetPasswordForm onClose={onClose} onDone={onDone} /> : null}
    </Modal>
  );
}

interface FormProps {
  readonly onClose: () => void;
  readonly onDone: () => void;
}

function SetPasswordForm({ onClose, onDone }: FormProps) {
  const setPassword = useAppStore((state) => state.setPassword);
  const [password, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const errors = validateNewPassword(password, confirmation);
  const shown = submitted ? errors : { password: undefined, confirmation: undefined };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (busy || errors.password !== undefined || errors.confirmation !== undefined) {
      return;
    }
    setBusy(true);
    setFailure(undefined);
    try {
      await setPassword(password);
      notifications.show({
        title: 'Master password set',
        message: 'The app asks for it from the next start.',
      });
      onDone();
      onClose();
    } catch (error) {
      // The server gives the reason, as in ChangePasswordModal.
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate>
      <Stack gap="sm">
        <Text size="sm">
          The app will ask for this password when it starts and after the idle lock. The data folder
          can then be moved to another computer.
        </Text>
        <PasswordInput
          label="New master password"
          description="At least 4 characters."
          autoComplete="new-password"
          value={password}
          onChange={(event) => setNewPassword(event.currentTarget.value)}
          error={shown.password}
          styles={invalidInputStyles(shown.password)}
          autoFocus
        />
        <PasswordStrengthMeter password={password} />
        <PasswordInput
          label="Confirm new password"
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
            Set password
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
