import {
  Alert,
  Button,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
} from '@mantine/core';
import type { ProfilingLevel } from '@mongo-gui/core';
import { useProfilerStore } from './profiler-store-context';
import type { ProfilerPanelState } from './profiler-store';
import { formatBytes, isDraftDirty, levelFromText, type LevelDraft } from './profiler-model';

const LEVEL_OPTIONS = [
  { label: 'Off', value: '0' },
  { label: 'Slow only', value: '1' },
  { label: 'All', value: '2' },
];

const LEVEL_NAMES: Readonly<Record<ProfilingLevel['level'], string>> = {
  0: 'Off',
  1: 'Slow only',
  2: 'All',
};

const POLL_OPTIONS = [
  { label: '0.5 s', value: '500' },
  { label: '1 s', value: '1000' },
  { label: '2 s', value: '2000' },
  { label: '5 s', value: '5000' },
  { label: '10 s', value: '10000' },
];

/** Shown while the tail runs at level 2. Each poll then writes a row to the capped system.profile. */
const LEVEL_TWO_TAIL_WARNING =
  'At level 2, each tail poll writes one entry to system.profile, about 1 KB of the 1 MB default size. Use a longer poll interval or set the level to Slow only.';

export interface ProfilerHeaderProps {
  readonly panelId: string;
  readonly panel: ProfilerPanelState;
}

/** Level control, the size of system.profile, and the tail toggle with its poll interval. */
export function ProfilerHeader({ panelId, panel }: ProfilerHeaderProps) {
  const setLevelDraft = useProfilerStore((state) => state.setLevelDraft);
  const applyLevel = useProfilerStore((state) => state.applyLevel);
  const setTailEnabled = useProfilerStore((state) => state.setTailEnabled);
  const setPollMs = useProfilerStore((state) => state.setPollMs);
  const draft = panel.levelDraft;
  const dirty = isDraftDirty(draft, panel.level);
  const tailOnLevelTwo = panel.tailEnabled && panel.level?.level === 2;

  function patchDraft(change: Partial<LevelDraft>) {
    setLevelDraft(panelId, change);
  }

  return (
    <Stack gap={6}>
      <Group gap={8} align="flex-end" wrap="wrap">
        <Stack gap={2}>
          <Text size="xs" c="dimmed">
            Profiling level
          </Text>
          <SegmentedControl
            aria-label="Profiling level"
            data={LEVEL_OPTIONS}
            value={String(draft.level)}
            onChange={(value) => patchDraft({ level: levelFromText(value) })}
          />
        </Stack>
        {draft.level === 1 ? (
          <NumberInput
            label="Slow threshold (ms)"
            min={0}
            step={10}
            value={draft.slowMs}
            onChange={(value) => patchDraft({ slowMs: typeof value === 'number' ? value : 0 })}
            w={150}
          />
        ) : null}
        {draft.level === 1 ? (
          <NumberInput
            label="Sample rate"
            min={0}
            max={1}
            step={0.1}
            decimalScale={2}
            value={draft.sampleRate}
            onChange={(value) => patchDraft({ sampleRate: typeof value === 'number' ? value : 0 })}
            w={120}
          />
        ) : null}
        <Button variant="default" disabled={!dirty} onClick={() => void applyLevel(panelId)}>
          Apply
        </Button>
        <Stack gap={2}>
          <Text size="xs" c="dimmed">
            Server level
          </Text>
          <Text size="sm">
            {panel.level === undefined
              ? 'Not read yet'
              : `${LEVEL_NAMES[panel.level.level]}${panel.level.level === 0 ? '' : `, ${panel.level.slowMs} ms`}`}
          </Text>
        </Stack>
        <Stack gap={2}>
          <Text size="xs" c="dimmed">
            system.profile
          </Text>
          <Text size="sm">{describeProfileCollection(panel)}</Text>
        </Stack>
        <Group gap={8} align="center" wrap="nowrap" h={28}>
          <Switch
            label="Tail"
            checked={panel.tailEnabled}
            onChange={(event) => void setTailEnabled(panelId, event.currentTarget.checked)}
          />
          <Select
            aria-label="Tail poll interval"
            data={POLL_OPTIONS}
            value={String(panel.pollMs)}
            onChange={(value) => {
              if (value !== null) {
                void setPollMs(panelId, Number(value));
              }
            }}
            w={100}
          />
        </Group>
      </Group>
      {tailOnLevelTwo ? (
        <Alert color="yellow" variant="light" p="xs">
          {LEVEL_TWO_TAIL_WARNING}
        </Alert>
      ) : null}
      {panel.tailError === undefined ? null : (
        <Alert color="red" variant="light" p="xs">
          The tail stopped. {panel.tailError.message}
        </Alert>
      )}
    </Stack>
  );
}

function describeProfileCollection(panel: ProfilerPanelState): string {
  const info = panel.info;
  if (info === undefined) {
    return 'Not read yet';
  }
  if (!info.exists) {
    return 'Does not exist yet';
  }
  const size = info.sizeBytes === undefined ? 'Unknown size' : formatBytes(info.sizeBytes);
  const count = info.count === undefined ? 'unknown count' : `${info.count} documents`;
  return `${size}, ${count}`;
}
