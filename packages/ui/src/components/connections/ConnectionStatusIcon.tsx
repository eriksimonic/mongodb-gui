import { Box, Loader, Tooltip } from '@mantine/core';
import type { ConnectionStatus } from '@mongo-gui/core';
import { IconAlertCircle, IconPlugConnected, IconPlugConnectedX } from '@tabler/icons-react';

export interface ConnectionStatusIconProps {
  readonly status: ConnectionStatus;
}

/** Status dot for a connection. The error state carries its message in a tooltip. */
export function ConnectionStatusIcon({ status }: ConnectionStatusIconProps) {
  switch (status.state) {
    case 'connected':
      return (
        <Tooltip label="Connected">
          <Box component="span" c="green.5" display="inline-flex">
            <IconPlugConnected size={14} aria-label="Connected" />
          </Box>
        </Tooltip>
      );
    case 'connecting':
      return (
        <Tooltip label="Connecting">
          <Box component="span" display="inline-flex">
            <Loader size={12} aria-label="Connecting" />
          </Box>
        </Tooltip>
      );
    case 'error': {
      const detail = status.error.detail === undefined ? '' : ` (${status.error.detail})`;
      return (
        <Tooltip label={`${status.error.message}${detail}`} multiline w={260}>
          <Box component="span" c="red.5" display="inline-flex">
            <IconAlertCircle size={14} aria-label="Connection error" />
          </Box>
        </Tooltip>
      );
    }
    case 'disconnected':
      return (
        <Tooltip label="Disconnected">
          <Box component="span" c="dimmed" display="inline-flex">
            <IconPlugConnectedX size={14} aria-label="Disconnected" />
          </Box>
        </Tooltip>
      );
  }
}
