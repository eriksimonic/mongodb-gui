import {
  Box,
  Button,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  Stack,
  Switch,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import {
  IconDatabase,
  IconGauge,
  IconInfoCircle,
  IconLock,
  IconPalette,
  IconPlugConnected,
  IconRefresh,
  IconTool,
} from '@tabler/icons-react';
import type { AppVersions, Settings, SettingsPatch, StartupSettings } from '@mongo-gui/core';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useUiApi } from '../../api/ui-api';
import { LICENCE_URL, PROJECT_URL } from './links';
import { useAppStore } from '../../state/app-store-context';
import { runReported } from '../../kit/notify-error';
import { ChangePasswordModal } from './ChangePasswordModal';
import { ConnectionsExportModal } from './ConnectionsExportModal';
import { ToolsLicenceModal } from '../tools/ToolsLicenceModal';
import { useMongoTools } from '../tools/use-mongo-tools';
import { ToolsSection } from './ToolsSection';
import { ConnectionsImportModal } from './ConnectionsImportModal';
import { CONNECTIONS_FILE_FILTER } from './connections-file-model';
import {
  clampToRange,
  EDITOR_FONT_SIZE_RANGE,
  HISTORY_LIMIT_RANGE,
  IDLE_LOCK_RANGE,
  SAMPLE_SIZE_RANGE,
  type NumericRange,
} from './settings-limits';

/** The height of the tab content. Fixed, so the dialog keeps its size when the tab changes. */
const PANEL_HEIGHT = 'calc(460px * var(--mg-font-scale, 1))';

/** The settings screen. Each control saves when the user changes it, and reads back the stored value. */
export function SettingsModal() {
  const open = useAppStore((state) => state.settingsOpen);
  const setOpen = useAppStore((state) => state.setSettingsOpen);
  return (
    <Modal
      opened={open}
      onClose={() => setOpen(false)}
      title="Settings"
      size="calc(780px * var(--mg-font-scale, 1))"
      centered
    >
      {open ? <SettingsForm /> : null}
    </Modal>
  );
}

const TABS = [
  { value: 'appearance', label: 'Appearance', icon: IconPalette },
  { value: 'security', label: 'Security', icon: IconLock },
  { value: 'connections', label: 'Connections', icon: IconPlugConnected },
  { value: 'data', label: 'Data', icon: IconDatabase },
  { value: 'updates', label: 'Updates', icon: IconRefresh },
  { value: 'performance', label: 'Performance', icon: IconGauge },
  { value: 'tools', label: 'MongoDB tools', icon: IconTool },
  { value: 'about', label: 'About', icon: IconInfoCircle },
] as const;

/** Loads the saved settings when it mounts. Each tab reads them from the store. */
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

  const panels: Record<(typeof TABS)[number]['value'], ReactNode> = {
    appearance: <AppearanceSection settings={settings} />,
    security: <SecuritySection settings={settings} />,
    connections: <ConnectionsSection />,
    data: <DataSection settings={settings} />,
    updates: <UpdatesSection settings={settings} />,
    performance: <PerformanceSection />,
    tools: <ToolsSettings settings={settings} />,
    about: <AboutSection />,
  };

  return (
    <Tabs
      orientation="vertical"
      defaultValue="appearance"
      keepMounted={false}
      variant="pills"
      styles={{
        tab: { justifyContent: 'flex-start', paddingBlock: 8 },
        tabLabel: { textAlign: 'left' },
      }}
    >
      <Tabs.List
        w="calc(180px * var(--mg-font-scale, 1))"
        pr="md"
        style={{ borderRight: '1px solid var(--mg-border)', gap: 6, flex: 'none' }}
      >
        {TABS.map(({ value, label, icon: Icon }) => (
          <Tabs.Tab key={value} value={value} leftSection={<Icon size={14} />}>
            {label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {TABS.map(({ value }) => (
        <Tabs.Panel
          key={value}
          value={value}
          pl="lg"
          h={PANEL_HEIGHT}
          style={{ overflowY: 'auto', flex: 1, minWidth: 0 }}
        >
          {panels[value]}
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}

interface SectionProps {
  readonly settings: Settings;
}

/** The content of one tab: a heading and its rows. The heading names the region for screen readers. */
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
    <Stack gap={0} component="section" aria-labelledby={id}>
      <Title order={5} id={id} mb="xs">
        {title}
      </Title>
      {children}
    </Stack>
  );
}

/**
 * One setting: the label and its description on the left, the control on the right. Every setting
 * uses it, so labels and controls line up across tabs. The control gets the label's id.
 */
function SettingRow({
  label,
  description,
  children,
}: {
  readonly label: string;
  readonly description?: string;
  readonly children: (labelId: string) => ReactNode;
}) {
  const labelId = useId();
  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      gap="xl"
      py="md"
      style={{ borderBottom: '1px solid var(--mg-border)' }}
    >
      <Stack gap={2} miw={0}>
        <Text size="sm" id={labelId}>
          {label}
        </Text>
        {description === undefined ? null : (
          <Text size="xs" c="dimmed">
            {description}
          </Text>
        )}
      </Stack>
      <Box style={{ flex: 'none' }}>{children(labelId)}</Box>
    </Group>
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
      <SettingRow label="Theme" description="Dark, light, or the scheme of the operating system.">
        {(labelId) => (
          <SegmentedControl
            aria-labelledby={labelId}
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
        )}
      </SettingRow>
      <NumericField
        label="Editor font size"
        description="Font size in pixels for the query and JSON editors."
        range={EDITOR_FONT_SIZE_RANGE}
        value={settings.editorFontSize}
        onSave={(editorFontSize) => save({ editorFontSize })}
      />
      <SettingRow label="Tree density" description="Row height of the connection tree.">
        {(labelId) => (
          <SegmentedControl
            aria-labelledby={labelId}
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
        )}
      </SettingRow>
      <SettingRow label="Panel layout" description="Puts every panel back in its default place.">
        {() => (
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
        )}
      </SettingRow>
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
      <SettingRow label="Master password" description="The password that unlocks the vault.">
        {() => (
          <Button variant="default" onClick={() => setChanging(true)}>
            Change master password
          </Button>
        )}
      </SettingRow>
      <SettingRow label="Lock" description="Locks the vault now. Open connections close.">
        {() => (
          <Button variant="default" onClick={() => void runReported(() => lock())}>
            Lock now
          </Button>
        )}
      </SettingRow>
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
  const { rpc } = useUiApi();
  const autoConnect = useAppStore((state) => state.docker.autoConnect);
  const setDockerAutoConnect = useAppStore((state) => state.setDockerAutoConnect);
  const [exporting, setExporting] = useState(false);
  // The import modal opens once the open dialog has returned a file.
  const [importPath, setImportPath] = useState<string | undefined>(undefined);

  async function chooseImportFile() {
    const picked = await rpc.app.showOpenDialog({
      title: 'Choose a connections file',
      filters: [CONNECTIONS_FILE_FILTER],
    });
    if (picked.path !== undefined) {
      setImportPath(picked.path);
    }
  }
  return (
    <Section id="settings-connections" title="Connections">
      <SettingRow
        label="Connect Docker instances automatically"
        description="Connects each MongoDB container on this machine when the app finds it."
      >
        {(labelId) => (
          <Switch
            aria-labelledby={labelId}
            checked={autoConnect}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              void runReported(() => setDockerAutoConnect(enabled));
            }}
          />
        )}
      </SettingRow>
      <SettingRow
        label="Connections file"
        description="Moves saved connections to another machine, in an encrypted file."
      >
        {() => (
          <Group gap="xs" wrap="nowrap">
            <Button variant="default" onClick={() => setExporting(true)}>
              Export connections
            </Button>
            <Button variant="default" onClick={() => void runReported(chooseImportFile)}>
              Import connections
            </Button>
          </Group>
        )}
      </SettingRow>
      <ConnectionsExportModal opened={exporting} onClose={() => setExporting(false)} />
      <ConnectionsImportModal path={importPath} onClose={() => setImportPath(undefined)} />
    </Section>
  );
}

function PerformanceSection() {
  const { rpc } = useUiApi();
  const [startup, setStartup] = useState<StartupSettings | undefined>(undefined);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    void runReported(async () => {
      setStartup(await rpc.app.getStartupSettings());
    });
  }, [rpc]);
  return (
    <Section id="settings-performance" title="Performance">
      <SettingRow
        label="Disable GPU acceleration"
        description="Saves about 90 MB of memory. Drawing moves to the CPU, so large grids and charts use more of it. Takes effect after a restart."
      >
        {(labelId) => (
          <Switch
            aria-labelledby={labelId}
            checked={startup?.disableGpu ?? false}
            disabled={startup === undefined}
            onChange={(event) => {
              const disableGpu = event.currentTarget.checked;
              void runReported(async () => {
                setStartup(await rpc.app.setStartupSettings({ disableGpu }));
                setChanged(true);
              });
            }}
          />
        )}
      </SettingRow>
      {changed && (
        <Group py="md">
          <Button onClick={() => void runReported(() => rpc.app.restart())}>Restart now</Button>
        </Group>
      )}
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
      <SettingRow
        label="Check for updates"
        description="Looks for a new version on GitHub while the app runs."
      >
        {(labelId) => (
          <Switch
            aria-labelledby={labelId}
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
        )}
      </SettingRow>
      <SettingRow
        label={`Current version ${updates.current}`}
        description={`Last checked: ${lastChecked}`}
      >
        {() => (
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
        )}
      </SettingRow>
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
      <SettingRow label="Query history" description="Deletes every saved history entry.">
        {() => (
          <Button
            variant="light"
            color="red"
            onClick={() =>
              modals.openConfirmModal({
                title: 'Clear query history',
                children: (
                  <Text size="sm">
                    Every saved history entry is deleted. This cannot be undone.
                  </Text>
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
        )}
      </SettingRow>
    </Section>
  );
}

function ToolsSettings({ settings }: SectionProps) {
  const save = useSaveSettings();
  return (
    <Section id="settings-tools" title="MongoDB tools">
      <ToolsSection settings={settings} save={save} />
    </Section>
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

  const { list } = useMongoTools();
  const bundled = list?.installs.find((install) => install.source === 'bundled');
  const [licenceOpen, setLicenceOpen] = useState(false);

  const open = (url: string) => void runReported(() => rpc.app.openExternal({ url }));
  return (
    <Section id="settings-about" title="About">
      <SettingRow
        label={`Mongo GUI ${version}`}
        description={
          versions === undefined
            ? 'Loading runtime versions'
            : `Electron ${versions.electron}, Chromium ${versions.chrome}, Node.js ${versions.node}`
        }
      >
        {() => (
          <Group gap="xs" wrap="nowrap">
            <Button variant="default" onClick={() => open(PROJECT_URL)}>
              Repository
            </Button>
            <Button variant="default" onClick={() => open(LICENCE_URL)}>
              Project licence
            </Button>
          </Group>
        )}
      </SettingRow>
      {bundled === undefined ? null : (
        <SettingRow
          label={`MongoDB Database Tools ${bundled.version}`}
          description="Included with the app, under the Apache License 2.0."
        >
          {() => (
            <Button variant="default" onClick={() => setLicenceOpen(true)}>
              Tools licence
            </Button>
          )}
        </SettingRow>
      )}
      <ToolsLicenceModal
        installId={licenceOpen && bundled !== undefined ? bundled.id : undefined}
        onClose={() => setLicenceOpen(false)}
      />
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
    <SettingRow label={label} description={description}>
      {(labelId) => (
        <NumberInput
          aria-labelledby={labelId}
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
          w="calc(110px * var(--mg-font-scale, 1))"
        />
      )}
    </SettingRow>
  );
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
