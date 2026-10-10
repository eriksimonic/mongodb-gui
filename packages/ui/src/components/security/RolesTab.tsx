import { Badge, Button, Group, Loader, Stack, Table, Text } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import type { RoleInfo } from '@mongo-gui/core';
import { useState } from 'react';
import { useStore } from 'zustand';
import type { SecurityStore } from '../../security/security-store';
import { DestructiveDialog } from '../management/DestructiveDialog';
import { RoleBadges } from './RoleBadges';
import { RoleEditorDialog } from './RoleEditorDialog';

export interface RolesTabProps {
  readonly store: SecurityStore;
  readonly database: string;
}

type EditorState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly role: RoleInfo };

/** The roles of one database. Custom roles come first, then the built-in roles, which are read only. */
export function RolesTab({ store, database }: RolesTabProps) {
  const roles = useStore(store, (state) => state.roles);
  const capabilities = useStore(store, (state) => state.capabilities);
  const [editor, setEditor] = useState<EditorState>({ kind: 'closed' });
  const [dropping, setDropping] = useState<RoleInfo | undefined>(undefined);

  if (roles === undefined) {
    return <Loader size="xs" m="sm" aria-label="Loading roles" />;
  }
  const canManage = capabilities?.canManageRoles === true;
  const sorted = [...roles].sort((left, right) => {
    if (left.isBuiltin !== right.isBuiltin) {
      return left.isBuiltin ? 1 : -1;
    }
    return left.role.localeCompare(right.role);
  });

  return (
    <Stack gap="sm" pt="sm">
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {roles.filter((role) => !role.isBuiltin).length} custom roles in {database}
        </Text>
        <Button
          leftSection={<IconPlus size={14} />}
          disabled={!canManage}
          onClick={() => setEditor({ kind: 'create' })}
        >
          Create role
        </Button>
      </Group>
      {capabilities !== undefined && !canManage ? (
        <Text size="xs" c="dimmed">
          The signed-in user cannot manage roles on this database.
        </Text>
      ) : null}
      <Table striped highlightOnHover withTableBorder verticalSpacing="xs" fz="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Role</Table.Th>
            <Table.Th>Type</Table.Th>
            <Table.Th>Inherited roles</Table.Th>
            <Table.Th>Privileges</Table.Th>
            <Table.Th>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {sorted.map((role) => (
            <Table.Tr key={role.id}>
              <Table.Td>{role.role}</Table.Td>
              <Table.Td>
                <Badge variant="light" color={role.isBuiltin ? 'gray' : 'blue'} size="sm" tt="none">
                  {role.isBuiltin ? 'Built-in' : 'Custom'}
                </Badge>
              </Table.Td>
              <Table.Td>
                <RoleBadges roles={role.roles} />
              </Table.Td>
              <Table.Td>{role.privileges.length}</Table.Td>
              <Table.Td>
                <Group gap={4} wrap="nowrap">
                  {role.isBuiltin ? (
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() => setEditor({ kind: 'edit', role })}
                    >
                      View
                    </Button>
                  ) : (
                    <>
                      <Button
                        size="xs"
                        variant="default"
                        disabled={!canManage}
                        onClick={() => setEditor({ kind: 'edit', role })}
                      >
                        Edit
                      </Button>
                      <Button
                        size="xs"
                        color="red"
                        variant="light"
                        disabled={!canManage}
                        onClick={() => setDropping(role)}
                      >
                        Drop
                      </Button>
                    </>
                  )}
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      {editor.kind === 'closed' ? null : (
        <RoleEditorDialog
          store={store}
          database={editor.kind === 'edit' ? editor.role.db : database}
          role={editor.kind === 'edit' ? editor.role : undefined}
          onClose={() => setEditor({ kind: 'closed' })}
        />
      )}
      {dropping === undefined ? null : (
        <DestructiveDialog
          title={`Drop role ${dropping.role}`}
          description={`Drop the role ${dropping.role} from ${dropping.db}? Users that hold it lose its privileges. This cannot be undone.`}
          confirmLabel="Drop role"
          typedConfirmation={dropping.role}
          onConfirm={() => store.getState().dropRole({ db: dropping.db, role: dropping.role })}
          onClose={() => setDropping(undefined)}
        />
      )}
    </Stack>
  );
}
