import {
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  MultiSelect,
  PasswordInput,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { EXTERNAL_DATABASE, type ScramMechanism } from '@mongo-gui/core';
import { useState } from 'react';
import { useStore } from 'zustand';
import { errorText } from '../notify-error';
import { passwordError } from '../../security/password-rules';
import { roleGroups, roleRefFromValue } from '../../security/privilege-model';
import type { SecurityStore } from '../../security/security-store';

export interface CreateUserDialogProps {
  readonly store: SecurityStore;
  /** The database the user is created in. `$external` users have no password. */
  readonly database: string;
  readonly onClose: () => void;
}

const MECHANISMS: readonly { readonly value: ScramMechanism; readonly label: string }[] = [
  { value: 'SCRAM-SHA-256', label: 'SCRAM-SHA-256' },
  { value: 'SCRAM-SHA-1', label: 'SCRAM-SHA-1' },
];

/** Creates a user with a password, the roles it holds and the mechanisms it may log in with. */
export function CreateUserDialog({ store, database, onClose }: CreateUserDialogProps) {
  const roleCatalog = useStore(store, (state) => state.roleCatalog);
  const external = database === EXTERNAL_DATABASE;
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const [mechanisms, setMechanisms] = useState<ScramMechanism[]>(['SCRAM-SHA-256']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const passwordProblem = external ? undefined : passwordError(password, confirm);
  const valid =
    user.trim() !== '' &&
    (external || passwordProblem === undefined) &&
    (external || mechanisms.length > 0);

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      await store.getState().createUser({
        db: database,
        user,
        roles: roles.map(roleRefFromValue),
        ...(external ? {} : { password, mechanisms }),
      });
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title={`New user in ${database}`} centered size="md">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) {
            void submit();
          }
        }}
      >
        <Stack gap="sm">
          <TextInput
            label="User name"
            value={user}
            onChange={(event) => setUser(event.currentTarget.value)}
            autoFocus
            autoComplete="off"
          />
          {external ? (
            <Text size="sm" c="dimmed">
              Users in $external authenticate outside MongoDB, so no password is set.
            </Text>
          ) : (
            <>
              <PasswordInput
                label="Password"
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                autoComplete="new-password"
              />
              <PasswordInput
                label="Confirm password"
                value={confirm}
                onChange={(event) => setConfirm(event.currentTarget.value)}
                error={confirm === '' ? undefined : passwordProblem}
                autoComplete="new-password"
              />
              <Checkbox.Group
                label="Mechanisms"
                description="The password mechanisms the user may log in with."
                value={mechanisms}
                onChange={(value) => setMechanisms(value as ScramMechanism[])}
              >
                <Group mt={4}>
                  {MECHANISMS.map((mechanism) => (
                    <Checkbox
                      key={mechanism.value}
                      value={mechanism.value}
                      label={mechanism.label}
                    />
                  ))}
                </Group>
              </Checkbox.Group>
              {mechanisms.length === 0 ? (
                <Text size="xs" c="red">
                  Choose at least one mechanism.
                </Text>
              ) : null}
            </>
          )}
          <MultiSelect
            label="Roles"
            description="Built-in and custom roles, grouped by the database they live in."
            data={roleGroups(roleCatalog)}
            value={roles}
            onChange={setRoles}
            searchable
            clearable
            hidePickedOptions
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
            <Button disabled={!valid} loading={busy} type="submit">
              Create user
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
