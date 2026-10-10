import { Badge, Button, Group, Loader, Stack, Table, Text } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { EXTERNAL_DATABASE, type UserInfo } from '@mongo-gui/core';
import { useState } from 'react';
import { useStore } from 'zustand';
import type { SecurityStore } from '../../security/security-store';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { CreateUserDialog } from './CreateUserDialog';
import { DestructiveDialog } from '../management/DestructiveDialog';
import { RoleBadges } from './RoleBadges';
import { RolesOfUserDialog } from './RolesOfUserDialog';

export interface UsersTabProps {
  readonly store: SecurityStore;
  readonly database: string;
}

/** The users of one database, with the actions the signed-in user may use. */
export function UsersTab({ store, database }: UsersTabProps) {
  const users = useStore(store, (state) => state.users);
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
        <Button
          leftSection={<IconPlus size={14} />}
          disabled={!canCreate}
          onClick={() => setCreating(true)}
        >
          Create user
        </Button>
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
              <Table.Tr key={user.id}>
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
                    <Button
                      size="xs"
                      variant="default"
                      disabled={!canGrant}
                      onClick={() => setRolesOf(user)}
                    >
                      Roles
                    </Button>
                    <Button
                      size="xs"
                      color="red"
                      variant="light"
                      disabled={!canCreate}
                      onClick={() => setDropping(user)}
                    >
                      Drop
                    </Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
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
