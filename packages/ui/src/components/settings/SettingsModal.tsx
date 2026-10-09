import { Modal, NumberInput, Stack, Switch, Text } from '@mantine/core';
import type { Settings } from '@mongo-gui/core';
import { useEffect, useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { runReported } from '../notify-error';
import { useAppStore } from '../../state/app-store-context';

/** The settings this screen edits. Theme and the rest arrive with the settings screen in P7-4. */
export function SettingsModal() {
  const open = useAppStore((state) => state.settingsOpen);
  const setOpen = useAppStore((state) => state.setSettingsOpen);
  return (
    <Modal opened={open} onClose={() => setOpen(false)} title="Settings" size="sm" centered>
      {open ? <SettingsForm /> : null}
    </Modal>
  );
}

/** Loads the saved settings when it mounts and saves each change as the user makes it. */
function SettingsForm() {
  const { rpc } = useUiApi();
  const refreshUpdates = useAppStore((state) => state.refreshUpdates);
  const [settings, setSettings] = useState<Settings | undefined>(undefined);
  // The field keeps what the user types. A blur saves it and shows the value the backend stored.
  const [idleDraft, setIdleDraft] = useState<number | string>('');

  useEffect(() => {
    let active = true;
    void runReported(async () => {
      const loaded = await rpc.settings.get();
      if (active) {
        setSettings(loaded);
        setIdleDraft(loaded.idleLockMinutes);
      }
    });
    return () => {
      active = false;
    };
  }, [rpc]);

  if (settings === undefined) {
    return (
      <Text size="sm" c="dimmed">
        Loading settings
      </Text>
    );
  }

  const saveUpdateCheck = (checkForUpdates: boolean) => {
    setSettings({ ...settings, checkForUpdates });
    void runReported(async () => {
      const saved = await rpc.settings.update({ checkForUpdates });
      setSettings(saved);
      // The updater reacts to the switch, so its phase may have changed.
      await refreshUpdates();
    });
  };

  const saveIdleLock = () => {
    if (typeof idleDraft !== 'number') {
      // An empty field goes back to the saved value.
      setIdleDraft(settings.idleLockMinutes);
      return;
    }
    const minutes = clampIdleLock(idleDraft);
    void runReported(async () => {
      const saved = await rpc.settings.update({ idleLockMinutes: minutes });
      setSettings(saved);
      setIdleDraft(saved.idleLockMinutes);
    });
  };

  return (
    <Stack gap="md">
      <Switch
        label="Check for updates"
        description="Looks for a new version on GitHub while the app runs."
        checked={settings.checkForUpdates}
        onChange={(event) => saveUpdateCheck(event.currentTarget.checked)}
      />
      <NumberInput
        label="Idle lock (minutes)"
        description="The vault locks after this many minutes without activity."
        min={MIN_IDLE_LOCK_MINUTES}
        max={MAX_IDLE_LOCK_MINUTES}
        allowDecimal={false}
        value={idleDraft}
        onChange={setIdleDraft}
        onBlur={saveIdleLock}
      />
    </Stack>
  );
}

const MIN_IDLE_LOCK_MINUTES = 1;
const MAX_IDLE_LOCK_MINUTES = 24 * 60;

/** Keeps a typed idle lock inside the range the backend accepts. */
function clampIdleLock(minutes: number): number {
  return Math.min(MAX_IDLE_LOCK_MINUTES, Math.max(MIN_IDLE_LOCK_MINUTES, Math.round(minutes)));
}
