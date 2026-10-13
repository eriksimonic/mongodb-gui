import { ActionIcon, Button, Group, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { IconCheck, IconPencil, IconTrash } from '@tabler/icons-react';
import type { SavedRestore, SavedRestoreInput } from '@mongo-gui/core';
import { useEffect, useState } from 'react';
import { useUiApi } from '../api/ui-api';
import { runReported } from '../kit/notify-error';

export interface SavedRestoresProps {
  readonly connectionId: string;
  /** The restore as the form holds it. Undefined while there is nothing valid to save. */
  readonly current: ((name: string) => SavedRestoreInput) | undefined;
  /** Loads a saved restore into the form. */
  readonly onOpen: (saved: SavedRestore) => void;
}

/** The restores saved for one connection, and a row that saves the current one under a name. */
export function SavedRestores({ connectionId, current, onOpen }: SavedRestoresProps) {
  const { rpc } = useUiApi();
  const [items, setItems] = useState<readonly SavedRestore[]>([]);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void runReported(async () => {
      const all = await rpc.savedRestores.list();
      if (active) {
        setItems(all.filter((item) => item.connectionId === connectionId));
      }
    });
    return () => {
      active = false;
    };
  }, [rpc, connectionId]);

  function save() {
    if (current === undefined) {
      return;
    }
    void runReported(async () => {
      const saved = await rpc.savedRestores.save(current(name.trim()));
      setItems((list) => [...list, saved]);
      setName('');
    });
  }

  function rename(id: string, to: string) {
    void runReported(async () => {
      const renamed = await rpc.savedRestores.rename({ id, name: to });
      setItems((list) => list.map((item) => (item.id === id ? renamed : item)));
      setRenaming(undefined);
    });
  }

  function remove(id: string) {
    void runReported(async () => {
      await rpc.savedRestores.remove({ id });
      setItems((list) => list.filter((item) => item.id !== id));
    });
  }

  return (
    <Stack gap="xs" data-testid="saved-restores">
      <Text fw={500} size="sm">
        Saved restores
      </Text>
      {items.length === 0 ? (
        <Text size="sm" c="dimmed">
          None saved for this connection.
        </Text>
      ) : null}
      {items.map((item) =>
        renaming?.id === item.id ? (
          <Group key={item.id} gap="xs" wrap="nowrap">
            <TextInput
              aria-label={`Rename ${item.name}`}
              value={renaming.name}
              style={{ flex: 1 }}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setRenaming({ id: item.id, name: next });
              }}
            />
            <Tooltip label="Rename">
              <ActionIcon
                aria-label={`Confirm rename of ${item.name}`}
                disabled={renaming.name.trim() === ''}
                onClick={() => {
                  rename(item.id, renaming.name.trim());
                }}
              >
                <IconCheck size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        ) : (
          <Group key={item.id} gap="xs" wrap="nowrap">
            <Button
              variant="subtle"
              size="compact-sm"
              title={item.source}
              style={{ flex: 1, justifyContent: 'flex-start' }}
              onClick={() => {
                onOpen(item);
              }}
            >
              {item.name}
            </Button>
            <Tooltip label="Rename">
              <ActionIcon
                variant="subtle"
                aria-label={`Rename ${item.name}`}
                onClick={() => {
                  setRenaming({ id: item.id, name: item.name });
                }}
              >
                <IconPencil size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Delete">
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label={`Delete ${item.name}`}
                onClick={() => {
                  remove(item.id);
                }}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        ),
      )}
      {current === undefined ? null : (
        <Group gap="xs" wrap="nowrap">
          <TextInput
            aria-label="Saved restore name"
            placeholder="Name this restore"
            value={name}
            style={{ flex: 1 }}
            onChange={(event) => {
              setName(event.currentTarget.value);
            }}
          />
          <Button variant="default" disabled={name.trim() === ''} onClick={save}>
            Save
          </Button>
        </Group>
      )}
    </Stack>
  );
}
