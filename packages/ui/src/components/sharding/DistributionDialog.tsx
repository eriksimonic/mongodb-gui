import { Alert, Modal, Stack, Table, Text } from '@mantine/core';
import type { ShardDistribution } from '@mongo-gui/core';
import { useEffect, useState } from 'react';
import { formatBytes } from '../../sharding/format-bytes';
import type { ShardingStore } from '../../sharding/sharding-store';
import { errorText } from '../notify-error';

export interface DistributionDialogProps {
  readonly store: ShardingStore;
  readonly namespace: string;
  readonly onClose: () => void;
}

/** Documents and chunks per shard for one collection. */
export function DistributionDialog({ store, namespace, onClose }: DistributionDialogProps) {
  const [distribution, setDistribution] = useState<ShardDistribution | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    store
      .getState()
      .distribution(namespace)
      .then((result) => {
        if (active) {
          setDistribution(result);
        }
      })
      .catch((failure: unknown) => {
        if (active) {
          setError(errorText(failure));
        }
      });
    return () => {
      active = false;
    };
  }, [store, namespace]);

  return (
    <Modal opened onClose={onClose} title={`Distribution of ${namespace}`} centered size="lg">
      <Stack gap="sm">
        {error === undefined ? null : (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        {distribution === undefined && error === undefined ? (
          <Text size="sm" c="dimmed">
            Loading the distribution
          </Text>
        ) : null}
        {distribution === undefined ? null : (
          <>
            <Text size="sm">
              {distribution.totalDocuments} documents, {formatBytes(distribution.totalSizeBytes)} in
              total
            </Text>
            <Table striped withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Shard</Table.Th>
                  <Table.Th>Documents</Table.Th>
                  <Table.Th>Share</Table.Th>
                  <Table.Th>Size</Table.Th>
                  <Table.Th>Chunks</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {distribution.shards.map((shard) => (
                  <Table.Tr key={shard.shard}>
                    <Table.Td>{shard.shard}</Table.Td>
                    <Table.Td>{shard.documents}</Table.Td>
                    <Table.Td>{shard.documentPercent.toFixed(2)}%</Table.Td>
                    <Table.Td>{formatBytes(shard.sizeBytes)}</Table.Td>
                    <Table.Td>{shard.chunks}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </>
        )}
      </Stack>
    </Modal>
  );
}
