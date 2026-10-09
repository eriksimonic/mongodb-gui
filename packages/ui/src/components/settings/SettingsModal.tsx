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

  useEffect(() => {
    let active = true;
    void runReported(async () => {
      const loaded = await rpc.settings.get();
      if (active) {
        setSettings(loaded);
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

  const saveIdleLock = (minutes: number) => {
    void runReported(async () => {
      setSettings(await rpc.settings.update({ idleLockMinutes: minutes }));
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
        min={1}
        max={24 * 60}
        allowDecimal={false}
        value={settings.idleLockMinutes}
        onChange={(value) => {
          if (typeof value === 'number') {
            setSettings({ ...settings, idleLockMinutes: value });
          }
        }}
        onBlur={() => saveIdleLock(settings.idleLockMinutes)}
      />
    </Stack>
  );
}
