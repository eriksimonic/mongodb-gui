import { Modal, Table, Text } from '@mantine/core';
import { useAppStore } from '../state/app-store-context';
import {
  formatShortcut,
  SCOPE_LABELS,
  SHORTCUTS,
  type Shortcut,
  type ShortcutScope,
} from './shortcuts';

const SCOPE_ORDER: readonly ShortcutScope[] = ['global', 'tree', 'table', 'dialog', 'editor'];

/** The keyboard reference. Opens with `?` or from the Help menu. */
export function ShortcutsModal() {
  const open = useAppStore((state) => state.shortcutsOpen);
  const setOpen = useAppStore((state) => state.setShortcutsOpen);
  return (
    <Modal
      opened={open}
      onClose={() => setOpen(false)}
      title="Keyboard shortcuts"
      size="lg"
      centered
    >
      {open ? <ShortcutTable rows={SHORTCUTS} platform={platformName()} /> : null}
    </Modal>
  );
}

export interface ShortcutTableProps {
  readonly rows: readonly Shortcut[];
  readonly platform: string;
}

/** Two columns, keys and action, with a header row for each scope. */
export function ShortcutTable({ rows, platform }: ShortcutTableProps) {
  return (
    <Table aria-label="Keyboard shortcuts" verticalSpacing="xs" horizontalSpacing="sm">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Shortcut</Table.Th>
          <Table.Th>Action</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {SCOPE_ORDER.flatMap((scope) => {
          const scoped = rows.filter((row) => row.scope === scope);
          if (scoped.length === 0) {
            return [];
          }
          return [
            <Table.Tr key={`scope-${scope}`}>
              <Table.Td colSpan={2}>
                <Text size="xs" fw={600} c="dimmed">
                  {SCOPE_LABELS[scope]}
                </Text>
              </Table.Td>
            </Table.Tr>,
            ...scoped.map((row) => (
              <Table.Tr key={row.id}>
                <Table.Td>
                  <Text size="sm" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                    {formatShortcut(row.keys, platform)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{row.action}</Text>
                </Table.Td>
              </Table.Tr>
            )),
          ];
        })}
      </Table.Tbody>
    </Table>
  );
}

function platformName(): string {
  return typeof navigator === 'undefined' ? '' : navigator.platform;
}
