import { Progress, Stack, Text } from '@mantine/core';
import { passwordStrength } from './password-rules';

const STRENGTH_COLORS = ['red', 'red', 'orange', 'yellow', 'green'] as const;

export interface PasswordStrengthMeterProps {
  readonly password: string;
}

/** The bar and label under a new master password field. Shared by first run and the change dialog. */
export function PasswordStrengthMeter({ password }: PasswordStrengthMeterProps) {
  const strength = passwordStrength(password);
  return (
    <Stack gap={4}>
      <Progress
        value={(strength.score / 4) * 100}
        color={STRENGTH_COLORS[strength.score] ?? 'red'}
        size="xs"
        aria-label="Password strength"
      />
      <Text size="xs" c="dimmed">
        Strength: {strength.label}. Use 10 or more characters with upper and lower case, digits and
        symbols.
      </Text>
    </Stack>
  );
}
