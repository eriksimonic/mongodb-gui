import { Badge, Button, Group, Loader, Stack, Table, Text } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { EXTERNAL_DATABASE, type UserInfo } from '@mongo-gui/core';
import { useState } from 'react';
import { useStore } from 'zustand';
import type { SecurityStore } from '../../security/security-store';
import { copyText } from '../../diagnostics/copy';
import { useAppStore } from '../../state/app-store-context';
import { TreeMenu, type TreeMenuEntry } from '../connections/TreeMenu';
import { userConnectionString } from './connection-string';
import {
  capabilityReason,
  CREATE_USERS_REASON,
  GRANT_ROLES_REASON,
} from '../../security/capability-reasons';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { GatedButton } from './GatedButton';
import { CreateUserDialog } from './CreateUserDialog';
import { DestructiveDialog } from '../management/DestructiveDialog';
import { RoleBadges } from './RoleBadges';
import { RolesOfUserDialog } from './RolesOfUserDialog';

export interface UsersTabProps {
  readonly store: SecurityStore;
  readonly connectionId: string;
  readonly database: string;
}

/** The users of one database, with the actions the signed-in user may use. */
export function UsersTab({ store, connectionId, database }: UsersTabProps) {
  const users = useStore(store, (state) => state.users);
  const status = useAppStore((state) => state.statuses[connectionId]);
  const [menu, setMenu] = useState<
    { readonly user: UserInfo; readonly x: number; readonly y: number } | undefined
  >(undefined);
  const capabilities = useStore(store, (state) => state.capabilities);
  const [creating, setCreating] = useState(false);
  const [passwordOf, setPasswordOf] = useState<UserInfo | undefined>(undefined);
  const [rolesOf, setRolesOf] = useState<UserInfo | undefined>(undefined);
  const [dropping, setDropping] = useState<UserInfo | undefined>(undefined);

  if (users === undefined) {
    return <Loader size="xs" m="sm" aria-label="Loading users" />;
  }
  // Dropping a user needs the same admin rights as creating one, so both follow canCreateUsers.
  const canCreate = capabilities?.canCreateUsers === true;
  const canGrant = capabilities?.canGrantRoles === true;

  return (
    <Stack gap="sm" pt="sm">
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {users.length} {users.length === 1 ? 'user' : 'users'} in {database}
        </Text>
        <GatedButton
          allowed={canCreate}
          reason={capabilityReason(capabilities, CREATE_USERS_REASON)}
          leftSection={<IconPlus size={14} />}
          onClick={() => setCreating(true)}
        >
          Create user
        </GatedButton>
      </Group>
      {capabilities !== undefined && !canCreate ? (
        <Text size="xs" c="dimmed">
          The signed-in user cannot create users on this database.
        </Text>
      ) : null}
      {users.length === 0 ? (
        <Text size="sm" c="dimmed">
          No users in {database}.
        </Text>
      ) : (
        <Table striped highlightOnHover withTableBorder verticalSpacing="xs" fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>User</Table.Th>
              <Table.Th>Roles</Table.Th>
              <Table.Th>Mechanisms</Table.Th>
              <Table.Th>Restrictions</Table.Th>
              <Table.Th>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {users.map((user) => (
              <Table.Tr
                key={user.id}
                title="Right-click for more actions"
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ user, x: event.clientX, y: event.clientY });
                }}
              >
                <Table.Td>{user.user}</Table.Td>
                <Table.Td>
                  <RoleBadges roles={user.roles} />
                </Table.Td>
                <Table.Td>
                  {user.mechanisms.length === 0 ? (
                    <Text size="xs" c="dimmed">
                      None
                    </Text>
                  ) : (
                    <Group gap={4}>
                      {user.mechanisms.map((mechanism) => (
                        <Badge key={mechanism} variant="outline" color="gray" size="sm" tt="none">
                          {mechanism}
                        </Badge>
                      ))}
                    </Group>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="xs">{restrictionText(user)}</Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    <Button
                      size="xs"
                      variant="default"
                      disabled={user.db === EXTERNAL_DATABASE}
                      onClick={() => setPasswordOf(user)}
                    >
                      Password
                    </Button>
                    <GatedButton
                      size="xs"
                      variant="default"
                      allowed={canGrant}
                      reason={capabilityReason(capabilities, GRANT_ROLES_REASON)}
                      onClick={() => setRolesOf(user)}
                    >
                      Roles
                    </GatedButton>
                    <GatedButton
                      size="xs"
                      color="red"
                      variant="light"
                      allowed={canCreate}
                      reason={capabilityReason(capabilities, CREATE_USERS_REASON)}
                      onClick={() => setDropping(user)}
                    >
                      Drop
                    </GatedButton>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {menu === undefined ? null : (
        <TreeMenu
          entries={userMenuEntries(menu.user, () =>
            copyText(userConnectionString(menu.user, status), 'Connection string copied'),
          )}
          position={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(undefined)}
        />
      )}

      {creating ? (
        <CreateUserDialog store={store} database={database} onClose={() => setCreating(false)} />
      ) : null}
      {passwordOf === undefined ? null : (
        <ChangePasswordDialog
          store={store}
          user={passwordOf}
          onClose={() => setPasswordOf(undefined)}
        />
      )}
      {rolesOf === undefined ? null : (
        <RolesOfUserDialog store={store} user={rolesOf} onClose={() => setRolesOf(undefined)} />
      )}
      {dropping === undefined ? null : (
        <DestructiveDialog
          title={`Drop user ${dropping.user}`}
          description={`Drop the user ${dropping.user} from ${dropping.db}? It can no longer log in. This cannot be undone.`}
          confirmLabel="Drop user"
          typedConfirmation={dropping.user}
          onConfirm={() => store.getState().dropUser({ db: dropping.db, user: dropping.user })}
          onClose={() => setDropping(undefined)}
        />
      )}
    </Stack>
  );
}

function restrictionText(user: UserInfo): string {
  const count = user.authenticationRestrictions.length;
  if (count === 0) {
    return 'None';
  }
  return count === 1 ? '1 restriction' : `${count} restrictions`;
}

/** The right-click menu of a user row. The connection string carries a placeholder password. */
function userMenuEntries(
  user: UserInfo,
  copyConnectionString: () => Promise<void>,
): TreeMenuEntry[] {
  return [
    {
      kind: 'item',
      label: 'Copy as connection string',
      onSelect: () => void copyConnectionString(),
    },
    {
      kind: 'item',
      label: 'Copy user name',
      onSelect: () => void copyText(`${user.user}@${user.db}`, 'User copied'),
    },
  ];
}
