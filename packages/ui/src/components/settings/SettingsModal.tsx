import {
  Box,
  Button,
  Divider,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import type { AppVersions, Settings, SettingsPatch } from '@mongo-gui/core';
import { useEffect, useState, type ReactNode } from 'react';
import { useUiApi } from '../../api/ui-api';
import { LICENCE_URL, PROJECT_URL } from './links';
import { useAppStore } from '../../state/app-store-context';
import { runReported } from '../notify-error';
import { ChangePasswordModal } from './ChangePasswordModal';
import {
  clampToRange,
  EDITOR_FONT_SIZE_RANGE,
  HISTORY_LIMIT_RANGE,
  IDLE_LOCK_RANGE,
  SAMPLE_SIZE_RANGE,
  type NumericRange,
} from './settings-limits';

const EXPORT_IMPORT_HINT = 'Arrives with Phase 7 finishing';

/** The settings screen. Each control saves when the user changes it, and reads back the stored value. */
export function SettingsModal() {
  const open = useAppStore((state) => state.settingsOpen);
  const setOpen = useAppStore((state) => state.setSettingsOpen);
  return (
    <Modal opened={open} onClose={() => setOpen(false)} title="Settings" size="lg" centered>
      {open ? <SettingsForm /> : null}
    </Modal>
  );
}

/** Loads the saved settings when it mounts. The sections below read them from the store. */
function SettingsForm() {
  const settings = useAppStore((state) => state.settings);
  const loadSettings = useAppStore((state) => state.loadSettings);
  const loaded = settings !== undefined;

  useEffect(() => {
    if (!loaded) {
      void runReported(loadSettings);
    }
  }, [loaded, loadSettings]);

  if (settings === undefined) {
    return (
      <Text size="sm" c="dimmed">
        Loading settings
      </Text>
    );
  }

  return (
    <Stack gap="lg">
      <AppearanceSection settings={settings} />
      <Divider />
      <SecuritySection settings={settings} />
      <Divider />
      <ConnectionsSection />
      <Divider />
      <UpdatesSection settings={settings} />
      <Divider />
      <DataSection settings={settings} />
      <Divider />
      <AboutSection />
    </Stack>
  );
}

interface SectionProps {
  readonly settings: Settings;
}

/** A titled group of controls. The heading names the region for screen readers. */
function Section({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Stack gap="sm" component="section" aria-labelledby={id}>
      <Title order={5} id={id}>
        {title}
      </Title>
      {children}
    </Stack>
  );
}

/** Saves a settings patch through the store. A failure shows as a notification. */
function useSaveSettings(): (patch: SettingsPatch) => Promise<void> {
  const updateSettings = useAppStore((state) => state.updateSettings);
  return (patch) =>
    runReported(async () => {
      await updateSettings(patch);
    });
}

function AppearanceSection({ settings }: SectionProps) {
  const save = useSaveSettings();
  const resetLayout = useAppStore((state) => state.resetLayout);
  return (
    <Section id="settings-appearance" title="Appearance">
      <Stack gap={4}>
        <Text size="sm" fw={500} id="settings-theme-label">
          Theme
        </Text>
        <SegmentedControl
          aria-labelledby="settings-theme-label"
          value={settings.theme}
          onChange={(value) => {
            if (value === 'dark' || value === 'light' || value === 'system') {
              void save({ theme: value });
            }
          }}
          data={[
            { label: 'Dark', value: 'dark' },
            { label: 'Light', value: 'light' },
            { label: 'System', value: 'system' },
          ]}
        />
      </Stack>
      <NumericField
        label="Editor font size"
        description="Font size in pixels for the query and JSON editors."
        range={EDITOR_FONT_SIZE_RANGE}
        value={settings.editorFontSize}
        onSave={(editorFontSize) => save({ editorFontSize })}
      />
      <Stack gap={4}>
        <Text size="sm" fw={500} id="settings-density-label">
          Tree density
        </Text>
        <SegmentedControl
          aria-labelledby="settings-density-label"
          value={settings.treeDensity}
          onChange={(value) => {
            if (value === 'compact' || value === 'comfortable') {
              void save({ treeDensity: value });
            }
          }}
          data={[
            { label: 'Compact', value: 'compact' },
            { label: 'Comfortable', value: 'comfortable' },
          ]}
        />
      </Stack>
      <Group>
        <Button
          variant="default"
          onClick={() =>
            void runReported(async () => {
              await resetLayout();
              notifications.show({
                title: 'Layout reset',
                message: 'The panels are back in their default places.',
              });
            })
          }
        >
          Reset layout
        </Button>
      </Group>
    </Section>
  );
}

function SecuritySection({ settings }: SectionProps) {
  const save = useSaveSettings();
  const lock = useAppStore((state) => state.lock);
  const [changing, setChanging] = useState(false);
  return (
    <Section id="settings-security" title="Security">
      <NumericField
        label="Idle lock (minutes)"
        description="The vault locks after this many minutes without activity."
        range={IDLE_LOCK_RANGE}
        value={settings.idleLockMinutes}
        onSave={(idleLockMinutes) => save({ idleLockMinutes })}
      />
      <Group gap="xs">
        <Button variant="default" onClick={() => setChanging(true)}>
          Change master password
        </Button>
        <Button variant="default" onClick={() => void runReported(() => lock())}>
          Lock now
        </Button>
      </Group>
      <ChangePasswordModal
        opened={changing}
        onClose={() => setChanging(false)}
        onChanged={() => {
          notifications.show({
            title: 'Master password changed',
            message: 'The vault uses the new password from the next unlock.',
          });
        }}
      />
    </Section>
  );
}

function ConnectionsSection() {
  const autoConnect = useAppStore((state) => state.docker.autoConnect);
  const setDockerAutoConnect = useAppStore((state) => state.setDockerAutoConnect);
  return (
    <Section id="settings-connections" title="Connections">
      <Switch
        label="Connect Docker instances automatically"
        description="Connects each MongoDB container on this machine when the app finds it."
        checked={autoConnect}
        onChange={(event) => {
          const enabled = event.currentTarget.checked;
          void runReported(() => setDockerAutoConnect(enabled));
        }}
      />
    </Section>
  );
}

function UpdatesSection({ settings }: SectionProps) {
  const updates = useAppStore((state) => state.updates);
  const refreshUpdates = useAppStore((state) => state.refreshUpdates);
  const checkForUpdates = useAppStore((state) => state.checkForUpdates);
  const save = useSaveSettings();
  const [checking, setChecking] = useState(false);
  const lastChecked =
    updates.lastCheckedAt === undefined ? 'Never' : formatDateTime(updates.lastCheckedAt);
  return (
    <Section id="settings-updates" title="Updates">
      <Switch
        label="Check for updates"
        description="Looks for a new version on GitHub while the app runs."
        checked={settings.checkForUpdates}
        onChange={(event) => {
          const enabled = event.currentTarget.checked;
          void runReported(async () => {
            await save({ checkForUpdates: enabled });
            // The updater reacts to the switch, so its phase may have changed.
            await refreshUpdates();
          });
        }}
      />
      <Text size="sm">Current version {updates.current}</Text>
      <Text size="sm" c="dimmed">
        Last checked: {lastChecked}
      </Text>
      <Group>
        <Button
          variant="default"
          loading={checking}
          onClick={() => {
            setChecking(true);
            void runReported(checkForUpdates).finally(() => {
              setChecking(false);
            });
          }}
        >
          Check now
        </Button>
      </Group>
    </Section>
  );
}

function DataSection({ settings }: SectionProps) {
  const save = useSaveSettings();
  const clearHistory = useAppStore((state) => state.clearHistory);
  return (
    <Section id="settings-data" title="Data">
      <NumericField
        label="Sample size (documents)"
        description="Documents read per sample. Saved for the schema and validation views."
        range={SAMPLE_SIZE_RANGE}
        value={settings.sampleSize}
        onSave={(sampleSize) => save({ sampleSize })}
      />
      <NumericField
        label="History limit (entries)"
        description="Older query history entries are removed past this count."
        range={HISTORY_LIMIT_RANGE}
        value={settings.historyLimit}
        onSave={(historyLimit) => save({ historyLimit })}
      />
      <Group gap="xs">
        <Button
          variant="light"
          color="red"
          onClick={() =>
            modals.openConfirmModal({
              title: 'Clear query history',
              children: (
                <Text size="sm">Every saved history entry is deleted. This cannot be undone.</Text>
              ),
              labels: { confirm: 'Clear history', cancel: 'Cancel' },
              confirmProps: { color: 'red' },
              onConfirm: () =>
                void runReported(async () => {
                  await clearHistory();
                  notifications.show({
                    title: 'History cleared',
                    message: 'All history entries are deleted.',
                  });
                }),
            })
          }
        >
          Clear history
        </Button>
      </Group>
      <Group gap="xs">
        <DisabledWithHint label="Export connections" />
        <DisabledWithHint label="Import connections" />
      </Group>
    </Section>
  );
}

/** A button that cannot be used yet. The tooltip says when it arrives. */
function DisabledWithHint({ label }: { readonly label: string }) {
  return (
    <Tooltip label={EXPORT_IMPORT_HINT} withArrow>
      <Box component="span" display="inline-block">
        <Button variant="default" disabled>
          {label}
        </Button>
      </Box>
    </Tooltip>
  );
}

function AboutSection() {
  const { rpc } = useUiApi();
  const version = useAppStore((state) => state.updates.current);
  // The version comes from the updater, which knows the running build.
  const [versions, setVersions] = useState<AppVersions | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void runReported(async () => {
      const loaded = await rpc.app.versions();
      if (active) {
        setVersions(loaded);
      }
    });
    return () => {
      active = false;
    };
  }, [rpc]);

  const open = (url: string) => void runReported(() => rpc.app.openExternal({ url }));
  return (
    <Section id="settings-about" title="About">
      <Text size="sm" fw={600}>
        Mongo GUI
      </Text>
      <Text size="sm">Version {version}</Text>
      <Text size="sm" c="dimmed">
        {versions === undefined
          ? 'Loading runtime versions'
          : `Electron ${versions.electron}, Chromium ${versions.chrome}, Node.js ${versions.node}`}
      </Text>
      <Group gap="xs">
        <Button variant="default" onClick={() => open(PROJECT_URL)}>
          Repository
        </Button>
        <Button variant="default" onClick={() => open(LICENCE_URL)}>
          Licence (MIT)
        </Button>
      </Group>
    </Section>
  );
}

interface NumericFieldProps {
  readonly label: string;
  readonly description: string;
  readonly range: NumericRange;
  readonly value: number;
  readonly onSave: (next: number) => Promise<void>;
}

/**
 * A number field that keeps what the user types. A blur clamps the value to the range and saves
 * it, when it changed. An empty field goes back to the saved value.
 */
function NumericField({ label, description, range, value, onSave }: NumericFieldProps) {
  const [draft, setDraft] = useState<number | string>(value);
  return (
    <NumberInput
      label={label}
      description={description}
      min={range.min}
      max={range.max}
      allowDecimal={false}
      value={draft}
      onChange={setDraft}
      onBlur={() => {
        if (typeof draft !== 'number') {
          setDraft(value);
          return;
        }
        const next = clampToRange(draft, range);
        setDraft(next);
        if (next !== value) {
          void onSave(next);
        }
      }}
      w={220}
    />
  );
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
