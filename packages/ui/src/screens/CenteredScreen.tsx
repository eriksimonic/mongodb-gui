import { Center, Paper, Stack, Title } from '@mantine/core';
import type { ReactNode } from 'react';

export interface CenteredScreenProps {
  readonly title: string;
  readonly children: ReactNode;
}

/** A single card in the middle of the window. Used by the first-run and unlock screens. */
export function CenteredScreen({ title, children }: CenteredScreenProps) {
  return (
    <Center mih="100vh" p="md">
      <Paper w={420} maw="100%" p="lg" withBorder>
        <Stack gap="md">
          <Title order={3}>{title}</Title>
          {children}
        </Stack>
      </Paper>
    </Center>
  );
}
