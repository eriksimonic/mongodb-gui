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
  const setFilters = useProfilerStore((state) => state.setFilters);
  const draft = panel.levelDraft;
  const dirty = isDraftDirty(draft, panel.level);
  const tailOnLevelTwo = panel.tailEnabled && panel.level?.level === 2;

  function patchDraft(change: Partial<LevelDraft>) {
    setLevelDraft(panelId, change);
  }

  const serverLevel =
    panel.level === undefined
      ? 'Not read yet'
      : `${LEVEL_NAMES[panel.level.level]}${panel.level.level === 0 ? '' : `, ${panel.level.slowMs} ms`}`;

  return (
    <Stack gap={8}>
      <Group gap={8} align="center" wrap="wrap">
        <Text className="mg-profiler-row-label">Capture</Text>
        <SegmentedControl
          size="xs"
          aria-label="Profiling level"
          data={LEVEL_OPTIONS}
          value={String(draft.level)}
          onChange={(value) => patchDraft({ level: levelFromText(value) })}
        />
        {draft.level === 1 ? (
          <NumberInput
            size="xs"
            aria-label="Slow threshold (ms)"
            leftSection={
              <Text size="xs" c="dimmed">
                Slow ms
              </Text>
            }
            leftSectionWidth={64}
            min={0}
            step={10}
            value={draft.slowMs}
            onChange={(value) => patchDraft({ slowMs: typeof value === 'number' ? value : 0 })}
            w={140}
          />
        ) : null}
        {draft.level === 1 ? (
          <NumberInput
            size="xs"
            aria-label="Sample rate"
            leftSection={
              <Text size="xs" c="dimmed">
                Sample
              </Text>
            }
            leftSectionWidth={56}
            min={0}
            max={1}
            step={0.1}
            decimalScale={2}
            value={draft.sampleRate}
            onChange={(value) => patchDraft({ sampleRate: typeof value === 'number' ? value : 0 })}
            w={130}
          />
        ) : null}
        <Button
          size="xs"
          variant="default"
          disabled={!dirty}
          onClick={() => void applyLevel(panelId)}
        >
          Apply
        </Button>
        <Switch
          size="xs"
          label="Tail"
          checked={panel.tailEnabled}
          onChange={(event) => void setTailEnabled(panelId, event.currentTarget.checked)}
        />
        <Select
          size="xs"
          aria-label="Tail poll interval"
          data={POLL_OPTIONS}
          value={String(panel.pollMs)}
          onChange={(value) => {
            if (value !== null) {
              void setPollMs(panelId, Number(value));
            }
          }}
          allowDeselect={false}
          w={90}
        />
        <Switch
          size="xs"
          label="Only problematic"
          checked={panel.filters.onlyProblematic}
          onChange={(event) =>
            setFilters(panelId, { onlyProblematic: event.currentTarget.checked })
          }
        />
        <Text size="xs" c="dimmed" ml="auto" className="mg-profiler-status">
          Server level:{' '}
          <Text span inherit c="default">
            {serverLevel}
          </Text>
          . system.profile: {describeProfileCollection(panel)}.
        </Text>
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
