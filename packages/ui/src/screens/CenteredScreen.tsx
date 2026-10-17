import { Center, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { IconDatabase } from '@tabler/icons-react';
import type { ReactNode } from 'react';

export interface CenteredScreenProps {
  readonly title: string;
  readonly children: ReactNode;
}

/** The app mark and a single card in the middle of the window. Used by the first-run and unlock screens. */
export function CenteredScreen({ title, children }: CenteredScreenProps) {
  return (
    <Center mih="100vh" p="md" bg="var(--mg-bg-sunken)">
      <Stack gap="md" w={420} maw="100%">
        <Group gap={8} justify="center">
          <IconDatabase size={22} color="var(--mg-accent)" aria-hidden="true" />
          <Text fw={600} size="lg">Mongo GUI</Text>
        </Group>
        <Paper w="100%" p="xl" withBorder bg="var(--mg-surface-1)" style={{ borderColor: 'var(--mg-border)' }}>
          <Stack gap="md">
            <Title order={4}>{title}</Title>
            {children}
          </Stack>
        </Paper>
      </Stack>
    </Center>
  );
}
