import { Group, Stack, Text } from '@mantine/core';
import { passwordStrength } from './password-rules';

export interface PasswordStrengthMeterProps {
  readonly password: string;
}

/** Four segments and a label under a new master password field. Shared by first run and the change dialog. */
export function PasswordStrengthMeter({ password }: PasswordStrengthMeterProps) {
  const strength = passwordStrength(password);
  return (
    <Stack gap={4}>
      <Group gap={4} wrap="nowrap" role="img" aria-label="Password strength">
        {[1, 2, 3, 4].map((segment) => (
          <div
            key={segment}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: segment <= strength.score ? 'var(--mg-ok)' : 'var(--mg-surface-3)',
            }}
          />
        ))}
      </Group>
      <Text size="xs" c="dimmed">
        Strength: {strength.label}. Use 10 or more characters with upper and lower case, digits and
        symbols.
      </Text>
    </Stack>
  );
}
