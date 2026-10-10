import { Alert, Button, Group, Modal, PasswordInput, Stack } from '@mantine/core';
import type { UserInfo } from '@mongo-gui/core';
import { useState } from 'react';
import { errorText } from '../notify-error';
import { passwordError } from '../../security/password-rules';
import type { SecurityStore } from '../../security/security-store';

export interface ChangePasswordDialogProps {
  readonly store: SecurityStore;
  readonly user: UserInfo;
  readonly onClose: () => void;
}

/** Sets a new password for a user. The password is sent once and never shown again. */
export function ChangePasswordDialog({ store, user, onClose }: ChangePasswordDialogProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const problem = passwordError(password, confirm);

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      await store.getState().changePassword({ db: user.db, user: user.user, password });
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title={`Password of ${user.user}`} centered size="sm">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (problem === undefined) {
            void submit();
          }
        }}
      >
        <Stack gap="sm">
          <PasswordInput
            label="New password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            autoFocus
            autoComplete="new-password"
          />
          <PasswordInput
            label="Confirm password"
            value={confirm}
            onChange={(event) => setConfirm(event.currentTarget.value)}
            error={confirm === '' ? undefined : problem}
            autoComplete="new-password"
          />
          {error === undefined ? null : (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={problem !== undefined} loading={busy} type="submit">
              Change password
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
