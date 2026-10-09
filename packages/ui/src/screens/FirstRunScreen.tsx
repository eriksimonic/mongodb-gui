import { Alert, Button, Group, PasswordInput, Stack, Text } from '@mantine/core';
import { toAppError } from '@mongo-gui/core';
import { useState, type FormEvent } from 'react';
import { useAppStore } from '../state/app-store-context';
import { CenteredScreen } from './CenteredScreen';
import { invalidInputStyles } from './field-state';
import { PasswordStrengthMeter } from './PasswordStrengthMeter';
import { validateNewPassword } from './password-rules';

export function FirstRunScreen() {
  const initialise = useAppStore((state) => state.initialise);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const errors = validateNewPassword(password, confirmation);
  const shownPassword = submitted ? errors.password : undefined;
  const shownConfirmation = submitted ? errors.confirmation : undefined;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (errors.password !== undefined || errors.confirmation !== undefined) {
      return;
    }
    setBusy(true);
    setFailure(undefined);
    try {
      await initialise(password);
    } catch (error) {
      setFailure(toAppError(error).message);
      setBusy(false);
    }
  }

  return (
    <CenteredScreen title="Create master password">
      <Text size="sm" c="dimmed">
        Saved connections are encrypted with this password, and nobody can recover it for you if you
        forget it.
      </Text>
      <form onSubmit={(event) => void handleSubmit(event)} noValidate>
        <Stack gap="sm">
          <PasswordInput
            label="Master password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            styles={invalidInputStyles(shownPassword)}
            aria-invalid={shownPassword !== undefined}
            autoFocus
          />
          {shownPassword === undefined ? null : <Text size="xs">{shownPassword}</Text>}
          <PasswordStrengthMeter password={password} />
          <PasswordInput
            label="Confirm master password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.currentTarget.value)}
            styles={invalidInputStyles(shownConfirmation)}
            aria-invalid={shownConfirmation !== undefined}
          />
          {shownConfirmation === undefined ? null : <Text size="xs">{shownConfirmation}</Text>}
          {failure === undefined ? null : (
            <Alert color="red" variant="light">
              {failure}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button type="submit" loading={busy}>
              Create vault
            </Button>
          </Group>
        </Stack>
      </form>
    </CenteredScreen>
  );
}
