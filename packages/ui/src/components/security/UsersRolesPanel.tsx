import { Alert, Stack, Tabs, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { useUiApi } from '../../api/ui-api';
import { createSecurityStore } from '../../security/security-store';
import { RolesTab } from './RolesTab';
import { UsersTab } from './UsersTab';

export interface UsersRolesPanelProps {
  readonly connectionId: string;
  readonly database: string;
}

type PanelTab = 'users' | 'roles';

/**
 * Users and custom roles of one database. The users tab lists the users with their roles and
 * restrictions. The roles tab lists the roles with their privileges and opens the privilege editor.
 */
export function UsersRolesPanel({ connectionId, database }: UsersRolesPanelProps) {
  const { rpc } = useUiApi();
  const [store] = useState(() => createSecurityStore({ connectionId, database }, rpc.security));
  const loadError = useStore(store, (state) => state.loadError);
  const [tab, setTab] = useState<PanelTab>('users');

  useEffect(() => {
    void store.getState().load();
  }, [store]);

  return (
    <Stack gap="xs" p="sm">
      <Text size="sm" c="dimmed">
        Users and roles of {database}
      </Text>
      {loadError === undefined ? null : (
        <Alert color="red" variant="light">
          {loadError}
        </Alert>
      )}
      <Tabs value={tab} onChange={(value) => setTab(value === 'roles' ? 'roles' : 'users')}>
        <Tabs.List>
          <Tabs.Tab value="users">Users</Tabs.Tab>
          <Tabs.Tab value="roles">Roles</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="users">
          <UsersTab store={store} database={database} />
        </Tabs.Panel>
        <Tabs.Panel value="roles">
          <RolesTab store={store} database={database} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
