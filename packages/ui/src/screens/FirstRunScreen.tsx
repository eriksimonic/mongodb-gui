import { Alert, Button, Group, PasswordInput, Progress, Stack, Text } from '@mantine/core';
import { toAppError } from '@mongo-gui/core';
import { useState, type FormEvent } from 'react';
import { useAppStore } from '../state/app-store-context';
import { CenteredScreen } from './CenteredScreen';
import { passwordStrength, validateNewPassword } from './password-rules';

const STRENGTH_COLORS = ['red', 'red', 'orange', 'yellow', 'green'] as const;

export function FirstRunScreen() {
  const initialise = useAppStore((state) => state.initialise);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const errors = validateNewPassword(password, confirmation);
  const strength = passwordStrength(password);

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
            error={submitted ? errors.password : undefined}
            autoFocus
          />
          <Stack gap={4}>
            <Progress
              value={(strength.score / 4) * 100}
              color={STRENGTH_COLORS[strength.score] ?? 'red'}
              size="xs"
            />
            <Text size="xs" c="dimmed">
              Strength: {strength.label}. Use 10 or more characters with upper and lower case,
              digits and symbols.
            </Text>
          </Stack>
          <PasswordInput
            label="Confirm master password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.currentTarget.value)}
            error={submitted ? errors.confirmation : undefined}
          />
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
