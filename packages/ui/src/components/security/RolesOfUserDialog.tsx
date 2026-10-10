import { Alert, Button, Group, Modal, MultiSelect, Stack, Text } from '@mantine/core';
import type { UserInfo } from '@mongo-gui/core';
import { useState } from 'react';
import { useStore } from 'zustand';
import { errorText } from '../notify-error';
import { roleGroups, roleRefFromValue, roleValue } from '../../security/privilege-model';
import type { SecurityStore } from '../../security/security-store';

export interface RolesOfUserDialogProps {
  readonly store: SecurityStore;
  readonly user: UserInfo;
  readonly onClose: () => void;
}

/**
 * Grants and revokes roles of one user. Each list is a multi-select. The grant list offers the
 * roles the user does not hold yet, and the revoke list offers the roles it does hold.
 */
export function RolesOfUserDialog({ store, user, onClose }: RolesOfUserDialogProps) {
  const roleCatalog = useStore(store, (state) => state.roleCatalog);
  const held = new Set(user.roles.map((ref) => roleValue(ref)));
  const grantable = roleCatalog.filter((role) => !held.has(roleValue(role)));
  const [grant, setGrant] = useState<string[]>([]);
  const [revoke, setRevoke] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const changes = grant.length > 0 || revoke.length > 0;

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      if (grant.length > 0) {
        await store.getState().grantRoles({
          db: user.db,
          user: user.user,
          roles: grant.map(roleRefFromValue),
        });
      }
      if (revoke.length > 0) {
        await store.getState().revokeRoles({
          db: user.db,
          user: user.user,
          roles: revoke.map(roleRefFromValue),
        });
      }
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title={`Roles of ${user.user}`} centered size="md">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (changes) {
            void submit();
          }
        }}
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Holds{' '}
            {user.roles.length === 0
              ? 'no roles'
              : user.roles.map((ref) => `${ref.role}@${ref.db}`).join(', ')}
            .
          </Text>
          <MultiSelect
            label="Grant roles"
            data={roleGroups(grantable)}
            value={grant}
            onChange={setGrant}
            searchable
            clearable
            hidePickedOptions
          />
          <MultiSelect
            label="Revoke roles"
            data={user.roles.map((ref) => ({
              value: roleValue(ref),
              label: `${ref.role}@${ref.db}`,
            }))}
            value={revoke}
            onChange={setRevoke}
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
            <Button disabled={!changes} loading={busy} type="submit">
              Apply
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
