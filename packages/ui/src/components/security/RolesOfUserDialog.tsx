import { Alert, Button, Checkbox, Group, Modal, MultiSelect, Stack, Text } from '@mantine/core';
import type { UserInfo } from '@mongo-gui/core';
import { useState } from 'react';
import { useStore } from 'zustand';
import { errorText } from '../notify-error';
import { roleGroups, roleRefFromValue, roleValue } from '../../security/privilege-model';
import { isSelfRevokeOfUserAdmin } from '../../security/self-revoke';
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
  const signedIn = useStore(store, (state) => state.signedIn);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const selfRevoke = isSelfRevokeOfUserAdmin(
    signedIn,
    { user: user.user, db: user.db },
    revoke.map(roleRefFromValue),
  );
  const changes = grant.length > 0 || revoke.length > 0;
  const ready = changes && (!selfRevoke || acknowledged);

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
          if (ready) {
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
          {selfRevoke ? (
            <>
              <Alert color="yellow" variant="light" title="This account is signed in">
                You are taking a user admin role from the account this connection signed in with.
                Once it is gone, this connection may no longer manage users, and only another
                administrator can give the role back.
              </Alert>
              <Checkbox
                label="I understand that I may lose the right to manage users"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.currentTarget.checked)}
              />
            </>
          ) : null}
          {error === undefined ? null : (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!ready} loading={busy} type="submit">
              Apply
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
