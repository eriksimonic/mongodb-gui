import { Box, Tooltip } from '@mantine/core';
import type { DockerContainerState, DockerMongoContainerSummary } from '@mongo-gui/core';
import { IconPlug, IconRoute } from '@tabler/icons-react';

const STATE_LABELS: Record<DockerContainerState, string> = {
  running: 'Running',
  exited: 'Exited',
  paused: 'Paused',
  restarting: 'Restarting',
  other: 'Other state',
};

export interface DockerContainerMetaProps {
  readonly container: DockerMongoContainerSummary;
}

/**
 * The right side of a container row: image, state dot, and how the connection reaches it.
 * A plug marks a published port. Without one, the connection goes through a forwarder.
 */
export function DockerContainerMeta({ container }: DockerContainerMetaProps) {
  const published = container.publishedPort;
  return (
    <span className="mg-tree-meta" aria-hidden="true">
      <span className="mg-tree-image">{container.image}</span>
      <Tooltip label={STATE_LABELS[container.state]}>
        <Box
          component="span"
          className="mg-tree-state"
          data-state={container.state}
          aria-label={STATE_LABELS[container.state]}
        />
      </Tooltip>
      {published === undefined ? (
        <Tooltip label="via forwarder">
          <Box component="span" className="mg-tree-route" aria-label="via forwarder">
            <IconRoute size={12} />
          </Box>
        </Tooltip>
      ) : (
        <Tooltip label={`Published on ${published.hostIp}:${published.hostPort}`}>
          <Box component="span" className="mg-tree-route" aria-label="Published port">
            <IconPlug size={12} />
          </Box>
        </Tooltip>
      )}
    </span>
  );
}
