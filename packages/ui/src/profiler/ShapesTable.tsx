import { Badge, Box, Group, Table, Text } from '@mantine/core';
import type { QueryShape } from '@mongo-gui/core';
import { commandPreview, formatCommand, isCollscan } from './profiler-model';

export interface ShapesTableProps {
  readonly shapes: readonly QueryShape[];
  /** Called with the shape key. The panel filters the slow query table to that shape. */
  readonly onSelect: (key: string) => void;
}

/** Query shapes sorted by total time. A row click lists that shape's operations in the slow query table. */
export function ShapesTable({ shapes, onSelect }: ShapesTableProps) {
  if (shapes.length === 0) {
    return (
      <Box p={12}>
        <Text size="sm" c="dimmed">
          No query shapes in this range.
        </Text>
      </Box>
    );
  }

  return (
    <Table
      highlightOnHover
      verticalSpacing={4}
      horizontalSpacing={8}
      fz="xs"
      withTableBorder={false}
    >
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Count</Table.Th>
          <Table.Th>Total (ms)</Table.Th>
          <Table.Th>Avg (ms)</Table.Th>
          <Table.Th>Max (ms)</Table.Th>
          <Table.Th>p95 (ms)</Table.Th>
          <Table.Th>Namespace</Table.Th>
          <Table.Th>Op</Table.Th>
          <Table.Th>Command</Table.Th>
          <Table.Th>Plans</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {shapes.map((shape) => (
          <Table.Tr
            key={shape.key}
            onClick={() => onSelect(shape.key)}
            style={{ cursor: 'pointer' }}
            aria-label={`Shape ${shape.ns} ${shape.op}`}
          >
            <Table.Td>{shape.count}</Table.Td>
            <Table.Td>{Math.round(shape.totalMillis)}</Table.Td>
            <Table.Td>{shape.avgMillis.toFixed(1)}</Table.Td>
            <Table.Td>{shape.maxMillis}</Table.Td>
            <Table.Td>{shape.p95Millis}</Table.Td>
            <Table.Td>{shape.ns}</Table.Td>
            <Table.Td>
              <Badge tt="none" variant="light" size="xs" color="gray">
                {shape.op}
              </Badge>
            </Table.Td>
            <Table.Td>
              <Text
                size="xs"
                ff="monospace"
                truncate
                maw={260}
                title={formatCommand(shape.example.command, 0)}
              >
                {commandPreview(shape.example.command)}
              </Text>
            </Table.Td>
            <Table.Td>
              <Group gap={4} wrap="wrap">
                {shape.planSummaries.length === 0 ? (
                  <Text size="xs" c="dimmed">
                    -
                  </Text>
                ) : (
                  shape.planSummaries.map((plan) => (
                    <Badge
                      tt="none"
                      key={plan}
                      size="xs"
                      variant="light"
                      color={isCollscan(plan) ? 'red' : 'gray'}
                    >
                      {plan}
                    </Badge>
                  ))
                )}
              </Group>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
