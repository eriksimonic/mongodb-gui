import { Alert, Button, Group, Modal, MultiSelect, Stack, Text, TextInput } from '@mantine/core';
import { isBuiltinRole, type RoleInfo } from '@mongo-gui/core';
import { useRef, useState } from 'react';
import { useStore } from 'zustand';
import { errorText } from '../notify-error';
import { databaseNameError } from '../../management/input-rules';
import {
  draftFromPrivilege,
  privilegesFromDrafts,
  roleGroups,
  roleRefFromValue,
  roleValue,
  type PrivilegeDraft,
} from '../../security/privilege-model';
import type { SecurityStore } from '../../security/security-store';
import { PrivilegeEditor } from './PrivilegeEditor';

export interface RoleEditorDialogProps {
  readonly store: SecurityStore;
  /** The database the role lives in. */
  readonly database: string;
  /** The role to edit or show. Undefined creates a role. */
  readonly role?: RoleInfo | undefined;
  readonly onClose: () => void;
}

/**
 * Creates or edits a custom role: its name, inherited roles and privileges. A built-in role opens
 * read-only, so its privileges show without any control that changes them.
 */
export function RoleEditorDialog({ store, database, role, onClose }: RoleEditorDialogProps) {
  const actions = useStore(store, (state) => state.actions);
  const roleCatalog = useStore(store, (state) => state.roleCatalog);
  const readOnly = role?.isBuiltin === true;
  const [name, setName] = useState(role?.role ?? '');
  const [inherited, setInherited] = useState<string[]>(
    (role?.roles ?? []).map((ref) => roleValue(ref)),
  );
  const [drafts, setDrafts] = useState<PrivilegeDraft[]>(() =>
    (role?.privileges ?? []).map((privilege, index) => draftFromPrivilege(privilege, `p${index}`)),
  );
  const nextId = useRef(drafts.length);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const nameProblem = validateRoleName(name, role !== undefined);
  const databaseProblem = databaseNameError(database);
  const valid = !readOnly && nameProblem === undefined && databaseProblem === undefined;
  const title = readOnly
    ? `Built-in role ${role?.role ?? ''}`
    : role === undefined
      ? `New role in ${database}`
      : `Edit role ${role.role}`;

  async function submit() {
    const built = privilegesFromDrafts(drafts, database);
    if ('error' in built) {
      setError(built.error);
      return;
    }
    const roles = inherited.map(roleRefFromValue);
    setBusy(true);
    setError(undefined);
    try {
      if (role === undefined) {
        await store.getState().createRole({
          db: database,
          role: name,
          privileges: built.privileges,
          roles,
        });
      } else {
        await store.getState().updateRole({
          db: database,
          role: role.role,
          privileges: built.privileges,
          roles,
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
    <Modal opened onClose={onClose} title={title} centered size="lg">
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
            label="Role name"
            value={name}
            disabled={role !== undefined}
            onChange={(event) => setName(event.currentTarget.value)}
            error={name === '' || role !== undefined ? undefined : nameProblem}
            autoComplete="off"
            autoFocus={role === undefined}
          />
          <MultiSelect
            label="Inherited roles"
            description="A user with this role also gets the privileges of these roles."
            data={roleGroups(roleCatalog.filter((item) => !isSameRole(item, role)))}
            value={inherited}
            onChange={setInherited}
            searchable
            disabled={readOnly}
            clearable={!readOnly}
            hidePickedOptions
          />
          <Text size="sm" fw={500}>
            Privileges
          </Text>
          <PrivilegeEditor
            drafts={drafts}
            onChange={setDrafts}
            database={database}
            actions={actions}
            readOnly={readOnly}
            nextKey={() => {
              nextId.current += 1;
              return `p${nextId.current}`;
            }}
          />
          {error === undefined ? null : (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {readOnly ? 'Close' : 'Cancel'}
            </Button>
            {readOnly ? null : (
              <Button disabled={!valid} loading={busy} type="submit">
                {role === undefined ? 'Create role' : 'Save role'}
              </Button>
            )}
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** True when a catalog entry is the role being edited. Role names repeat across databases, so both match. */
function isSameRole(item: RoleInfo, role: RoleInfo | undefined): boolean {
  return role !== undefined && item.role === role.role && item.db === role.db;
}

function validateRoleName(name: string, existing: boolean): string | undefined {
  if (existing) {
    return undefined;
  }
  if (name.trim() === '') {
    return 'Enter a role name';
  }
  if (isBuiltinRole(name)) {
    return 'That name belongs to a built-in role';
  }
  return undefined;
}
