import { Box, Button, Tooltip, type ButtonProps } from '@mantine/core';
import type { ComponentPropsWithoutRef } from 'react';

export type GatedButtonProps = ButtonProps &
  Omit<ComponentPropsWithoutRef<'button'>, 'color'> & {
    /** False when the signed-in user lacks the right. The button then reads disabled. */
    readonly allowed: boolean;
    /** Shown on hover while the button is disabled, so the user sees why it is off. */
    readonly reason: string;
  };

/**
 * A button that a right can switch off. A disabled button takes no pointer events, so the tooltip
 * sits on a wrapper that does.
 */
export function GatedButton({ allowed, reason, disabled, ...buttonProps }: GatedButtonProps) {
  return (
    <Tooltip label={reason} disabled={allowed} multiline w={260} withArrow position="bottom">
      <Box component="span" style={{ display: 'inline-flex' }}>
        <Button {...buttonProps} disabled={!allowed || disabled === true} />
      </Box>
    </Tooltip>
  );
}
