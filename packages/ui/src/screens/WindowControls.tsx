import { ActionIcon, Group } from '@mantine/core';
import { IconCopy, IconMinus, IconSquare, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '../kit/ConfirmDialog';

/** The preload object for the window. Only the Electron app has it. */
interface WindowBridge {
  act(action: 'minimize' | 'toggle-maximize' | 'close'): void;
  isMaximized(): Promise<boolean>;
  onMaximized(listener: (maximized: boolean) => void): () => void;
}

/** Minimize, maximize and close for the frameless Electron window. The browser mock UI has none. */
export function WindowControls() {
  const bridge = (window as { mongoGuiWindow?: WindowBridge }).mongoGuiWindow;
  const [maximized, setMaximized] = useState(false);
  const [confirmingQuit, setConfirmingQuit] = useState(false);
  useEffect(() => {
    if (bridge === undefined) {
      return undefined;
    }
    void bridge.isMaximized().then(setMaximized);
    return bridge.onMaximized(setMaximized);
  }, [bridge]);
  if (bridge === undefined) {
    return null;
  }
  return (
    <Group gap={2} wrap="nowrap" ml={4}>
      <ActionIcon
        variant="subtle"
        color="gray"
        size="md"
        aria-label="Minimize"
        onClick={() => bridge.act('minimize')}
      >
        <IconMinus size={16} aria-hidden="true" />
      </ActionIcon>
      <ActionIcon
        variant="subtle"
        color="gray"
        size="md"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        onClick={() => bridge.act('toggle-maximize')}
      >
        {maximized ? (
          <IconCopy size={14} aria-hidden="true" />
        ) : (
          <IconSquare size={14} aria-hidden="true" />
        )}
      </ActionIcon>
      <ActionIcon
        variant="subtle"
        color="red"
        size="md"
        aria-label="Close window"
        onClick={() => setConfirmingQuit(true)}
      >
        <IconX size={16} aria-hidden="true" />
      </ActionIcon>
      {confirmingQuit ? (
        <ConfirmDialog
          title="Quit Mongo GUI?"
          description="Open connections and running queries end when the app closes."
          confirmLabel="Quit"
          onConfirm={async () => bridge.act('close')}
          onClose={() => setConfirmingQuit(false)}
        />
      ) : null}
    </Group>
  );
}
