import { Badge, Group, Text } from '@mantine/core';
import type { UserRoleRef } from '@mongo-gui/core';

/** Role references as chips. Each chip shows the role and the database it lives in. */
export function RoleBadges({ roles }: { readonly roles: readonly UserRoleRef[] }) {
  if (roles.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        None
      </Text>
    );
  }
  return (
    <Group gap={4}>
      {roles.map((ref) => (
        <Badge key={`${ref.db}/${ref.role}`} variant="light" size="sm" tt="none">
          {ref.role}@{ref.db}
        </Badge>
      ))}
    </Group>
  );
}
