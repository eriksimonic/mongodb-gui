import { Alert, Anchor, Button, Group, PasswordInput, Stack } from '@mantine/core';
import { toAppError } from '@mongo-gui/core';
import { useState, type FormEvent } from 'react';
import { useAppStore } from '../state/app-store-context';
import { CenteredScreen } from './CenteredScreen';
import { ResetStoreModal } from './ResetStoreModal';

const WRONG_PASSWORD = 'Wrong master password. Try again.';

export function UnlockScreen() {
  const unlock = useAppStore((state) => state.unlock);
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
            error={wrongPassword ? WRONG_PASSWORD : undefined}
            autoFocus
          />
          {failure === undefined ? null : (
            <Alert color="red" variant="light">
              {failure}
            </Alert>
          )}
          <Group justify="space-between">
            <Anchor component="button" type="button" size="sm" onClick={() => setResetOpen(true)}>
              Reset store
            </Anchor>
            <Button type="submit" loading={busy}>
              Unlock
            </Button>
          </Group>
        </Stack>
      </form>
      <ResetStoreModal opened={resetOpen} onClose={() => setResetOpen(false)} />
    </CenteredScreen>
  );
}
