import { Alert, Anchor, Button, PasswordInput, Stack, Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { toAppError } from '@mongo-gui/core';
import { useState, type FormEvent } from 'react';
import { useAppStore } from '../state/app-store-context';
import { CenteredScreen } from './CenteredScreen';
import { invalidInputStyles } from './field-state';
import { ResetStoreModal } from './ResetStoreModal';

const WRONG_PASSWORD = 'Wrong master password. Try again.';

export function UnlockScreen() {
  const unlock = useAppStore((state) => state.unlock);
  const lockReason = useAppStore((state) => state.lockReason);
  const idleLockMinutes = useAppStore((state) => state.idleLockMinutes);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [wrongPassword, setWrongPassword] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [resetOpen, setResetOpen] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setWrongPassword(false);
    setFailure(undefined);
    try {
      await unlock(password);
    } catch (error) {
      const appError = toAppError(error);
      setWrongPassword(appError.code === 'VAULT_BAD_PASSWORD');
      setFailure(appError.code === 'VAULT_BAD_PASSWORD' ? undefined : appError.message);
      setBusy(false);
    }
  }

  return (
    <CenteredScreen title="Unlock Mongo GUI">
      <form onSubmit={(event) => void handleSubmit(event)}>
        <Stack gap="sm">
          <PasswordInput
            label="Master password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            styles={invalidInputStyles(wrongPassword ? WRONG_PASSWORD : undefined)}
            aria-invalid={wrongPassword}
            autoFocus
          />
          {lockReason === 'idle' ? (
            <Text size="sm" c="dimmed" role="status">
              {`Locked after ${idleLockMinutes} ${idleLockMinutes === 1 ? 'minute' : 'minutes'} without activity`}
            </Text>
          ) : null}
          {wrongPassword ? <Text size="xs">{WRONG_PASSWORD}</Text> : null}
          {failure === undefined ? null : (
            <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>
              {failure}
            </Alert>
          )}
          <Stack gap="sm">
            <Anchor component="button" type="button" size="sm" c="var(--mg-link)" onClick={() => setResetOpen(true)}>
              Reset store
            </Anchor>
            <Text size="xs" c="dimmed">
              No recovery. Resetting erases saved connections.
            </Text>
            <Button type="submit" loading={busy} fullWidth>
              Unlock
            </Button>
          </Stack>
        </Stack>
      </form>
      <ResetStoreModal opened={resetOpen} onClose={() => setResetOpen(false)} />
    </CenteredScreen>
  );
}
