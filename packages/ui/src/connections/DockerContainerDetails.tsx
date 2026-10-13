import { Code, Stack, Text } from '@mantine/core';
import type { DockerMongoContainerSummary } from '@mongo-gui/core';
import type { ReactNode } from 'react';

export interface DockerContainerDetailsProps {
  readonly container: DockerMongoContainerSummary;
}

/**
 * Identity and configuration of a container. Environment variables appear by name only,
 * so a password in the container never reaches the screen.
 */
export function DockerContainerDetails({ container }: DockerContainerDetailsProps) {
  return (
    <Stack gap="sm">
      <Field label="Container id">
        <Code>{container.id}</Code>
      </Field>
      <Field label="Image">
        <Code>{container.image}</Code>
      </Field>
      <Field label="Networks">
        {container.networks.length === 0 ? (
          <Text size="sm">None</Text>
        ) : (
          container.networks.map((network) => <Code key={network}>{network}</Code>)
        )}
      </Field>
      <Field label="Environment variables (names only)">
        {container.envKeys.length === 0 ? (
          <Text size="sm">None</Text>
        ) : (
          container.envKeys.map((key) => <Code key={key}>{key}</Code>)
        )}
      </Field>
    </Stack>
  );
}

interface FieldProps {
  readonly label: string;
  readonly children: ReactNode;
}

function Field({ label, children }: FieldProps) {
  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Stack gap={4} align="flex-start">
        {children}
      </Stack>
    </Stack>
  );
}
