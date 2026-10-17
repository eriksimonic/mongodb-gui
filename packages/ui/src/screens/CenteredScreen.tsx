import { Center, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { IconDatabase } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { WindowControls } from './WindowControls';

export interface CenteredScreenProps {
  readonly title: string;
  readonly children: ReactNode;
}

/** The app mark and a single card in the middle of the window. Used by the first-run and unlock screens. */
export function CenteredScreen({ title, children }: CenteredScreenProps) {
  return (
    <Center mih="100vh" p="md" bg="var(--mg-bg-sunken)">
      {/* The window has no OS frame, so these screens drag and close it themselves. */}
      <Group
        className="mg-app-header"
        justify="flex-end"
        h={40}
        px={8}
        style={{ position: 'absolute', top: 0, left: 0, right: 0 }}
      >
        <WindowControls />
      </Group>
      <Stack gap="md" w={420} maw="100%">
        <Group gap={8} justify="center">
          <IconDatabase size={22} color="var(--mg-accent)" aria-hidden="true" />
          <Text fw={600} size="lg">
            Mongo GUI
          </Text>
        </Group>
        <Paper
          w="100%"
          p="xl"
          withBorder
          bg="var(--mg-surface-1)"
          style={{ borderColor: 'var(--mg-border)' }}
        >
          <Stack gap="md">
            <Title order={4}>{title}</Title>
            {children}
          </Stack>
        </Paper>
      </Stack>
    </Center>
  );
}
