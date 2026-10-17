import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Tabs,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import {
  explainInWords,
  PlanVerbositySchema,
  type PlanStage,
  type PlanTree,
  type PlanVerbosity,
} from '@mongo-gui/core';
import { useMemo, useState } from 'react';
import { errorText, notifyError } from '../kit/notify-error';
import { useAppStore } from '../state/app-store-context';
import {
  applyLookupMeasures,
  stageIdByName,
  type ExplainPanelState,
  type LookupMeasure,
} from './explain-model';
import { ExplainIndexSuggestion, ExplainSummaryBar, ExplainWarnings } from './ExplainParts';
import { CommandEditor } from './CommandEditor';
import { ExplainRaw } from './ExplainRaw';
import { PlanGraphView } from './PlanGraphView';
import { PlanTreeView, type StageSelection } from './PlanTreeView';
import './explain.css';

export interface ExplainPanelProps {
  /** The id the store gave the panel. The panel reads its request and result from the store. */
  readonly panelId: string;
}

const VERBOSITIES = PlanVerbositySchema.options;

// The server names stay in the hover text, so a reader can match them to the docs and the raw output.
const VERBOSITY_TEXT: Readonly<
  Record<PlanVerbosity, { readonly label: string; readonly hint: string }>
> = {
  queryPlanner: {
    label: 'Plan only',
    hint: 'queryPlanner: shows the plan the server picks. The query does not run.',
  },
  executionStats: {
    label: 'With stats',
    hint: 'executionStats: runs the query and shows the counts and timings of each stage.',
  },
  allPlansExecution: {
    label: 'All plans',
    hint: 'allPlansExecution: runs the query and also shows the plans the server tried and rejected.',
  },
};

const VERBOSITY_DATA = VERBOSITIES.map((value) => ({
  value,
  label: (
    <Tooltip label={VERBOSITY_TEXT[value].hint} withArrow openDelay={300} multiline maw={280}>
      <span>{VERBOSITY_TEXT[value].label}</span>
    </Tooltip>
  ),
}));

const VIEW_DATA = [
  { value: 'graph', label: 'Graph' },
  { value: 'list', label: 'List' },
];

function isVerbosity(value: string): value is PlanVerbosity {
  return VERBOSITIES.some((verbosity) => verbosity === value);
}

/** The explain of one statement or command: header, and the plan, raw output or a state message. */
export function ExplainPanel({ panelId }: ExplainPanelProps) {
  const panel = useAppStore((state) => state.explainPanels[panelId]);
  if (panel === undefined) {
    return null;
  }
  return <ExplainPanelBody panel={panel} />;
}

function ExplainPanelBody({ panel }: { readonly panel: ExplainPanelState }) {
  const rerun = useAppStore((state) => state.rerunExplain);
  const [tab, setTab] = useState<string | null>('plan');
  const [selection, setSelection] = useState<StageSelection | undefined>(undefined);
  const { outcome, request } = panel;
  const busy = outcome.state === 'loading';
  const refused = outcome.state === 'refused';
  const statement =
    request.source.kind === 'statement' ? request.source.code : request.source.commandEjson;
  const [draft, setDraft] = useState(statement);
  const run = () => void rerun(panel.id, undefined, draft);

  return (
    <Stack gap="sm" p="md" className="mg-explain" h="100%" style={{ minHeight: 0 }}>
      <CommandEditor
        value={draft}
        language={request.source.kind === 'statement' ? 'mongosh' : 'json'}
        connectionId={request.connectionId}
        database={request.database}
        onChange={setDraft}
        onRun={run}
      />
      {panel.note === undefined ? null : (
        <Text size="xs" c="dimmed">
          {panel.note}
        </Text>
      )}

      <Group gap={8} wrap="wrap" justify="space-between">
        <Group gap={8} wrap="wrap" align="center" className="mg-explain-toolbar">
          {refused ? null : (
            <SegmentedControl
              size="xs"
              aria-label="Verbosity"
              data={VERBOSITY_DATA}
              value={request.verbosity}
              disabled={busy}
              onChange={(value) => {
                if (isVerbosity(value)) {
                  void rerun(panel.id, value);
                }
              }}
            />
          )}
          <Button
            size="xs"
            variant="default"
            leftSection={<IconRefresh size={14} aria-hidden="true" />}
            disabled={busy}
            onClick={run}
          >
            Re-run
          </Button>
        </Group>
        <Group gap={8} wrap="wrap">
          {outcome.state === 'ready' ? (
            <Text size="xs" c="dimmed">
              {outcome.result.elapsedMs} ms
            </Text>
          ) : null}
          {outcome.state === 'ready' && outcome.result.tree.engine !== 'unknown' ? (
            <Badge tt="none" variant="outline" color="gray" size="sm">
              {outcome.result.tree.engine}
            </Badge>
          ) : null}
          {outcome.state === 'ready' && outcome.result.tree.serverVersion !== undefined ? (
            <Text size="xs" c="dimmed">
              Server {outcome.result.tree.serverVersion}
            </Text>
          ) : null}
        </Group>
      </Group>

      {outcome.state === 'loading' ? (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            Running explain
          </Text>
        </Group>
      ) : null}
      {outcome.state === 'error' ? (
        <Alert color="red" title="Explain failed">
          {errorText(outcome.error)}
        </Alert>
      ) : null}
      {outcome.state === 'refused' ? <NoPlan message={outcome.message} /> : null}
      {outcome.state === 'idle' ? (
        <Text size="sm" c="dimmed">
          This explain is from the last session. Press Re-run to run it again.
        </Text>
      ) : null}
      {outcome.state === 'ready' ? (
        <Tabs
          value={tab}
          onChange={setTab}
          styles={{ root: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }}
        >
          <Tabs.List>
            <Tabs.Tab value="plan">Plan</Tabs.Tab>
            <Tabs.Tab value="raw">Raw</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel
            value="plan"
            pt="sm"
            style={{
              flex: 1,
              minHeight: 0,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <PlanView
              panelId={panel.id}
              tree={outcome.result.tree}
              collection={panel.collection}
              measures={panel.lookupMeasures}
              selection={selection}
              onSelect={setSelection}
            />
          </Tabs.Panel>
          <Tabs.Panel
            value="raw"
            pt="sm"
            style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
          >
            <ExplainRaw text={outcome.result.rawEjson} />
          </Tabs.Panel>
        </Tabs>
      ) : null}
    </Stack>
  );
}

interface PlanViewProps {
  readonly panelId: string;
  readonly tree: PlanTree;
  readonly collection: string | undefined;
  readonly measures: Readonly<Record<string, LookupMeasure>> | undefined;
  readonly selection: StageSelection | undefined;
  readonly onSelect: (selection: StageSelection | undefined) => void;
}

function PlanView({ panelId, tree, collection, measures, selection, onSelect }: PlanViewProps) {
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const measureLookup = useAppStore((state) => state.measureLookup);

  // The measured inner pipelines replace the spec-modelled stages under their $lookup.
  const winning = useMemo(
    () => applyLookupMeasures(tree.winning, measures),
    [tree.winning, measures],
  );

  async function measure(id: string, stage: PlanStage): Promise<void> {
    try {
      await measureLookup(panelId, id, stage);
    } catch (error) {
      notifyError(error, 'The $lookup could not be measured');
    }
  }

  if (tree.command === 'unknown') {
    return <NoPlan message={explainInWords(tree)[0] ?? 'The explain output is not a plan.'} />;
  }
  return (
    <Stack gap="sm" className="mg-explain-plan" style={{ flex: 1, minHeight: 0 }}>
      <ExplainSummaryBar tree={tree} />
      <ExplainWarnings
        warnings={tree.warnings}
        onSelect={(stageName) => {
          const id = stageIdByName(winning, stageName);
          if (id !== undefined) {
            onSelect({ id });
          }
        }}
      />
      <ExplainIndexSuggestion tree={tree} collection={collection} />
      <SegmentedControl
        size="xs"
        aria-label="Plan view"
        data={VIEW_DATA}
        value={view}
        onChange={(value) => setView(value === 'list' ? 'list' : 'graph')}
        style={{ alignSelf: 'flex-start' }}
      />
      {view === 'graph' ? (
        <PlanGraphView
          root={winning}
          rejected={tree.rejected}
          selection={selection}
          onSelect={onSelect}
          onMeasure={measure}
          measures={measures}
        />
      ) : (
        <div className="mg-explain-list-area">
          <PlanTreeView
            root={winning}
            rejected={tree.rejected}
            selection={selection}
            onSelect={onSelect}
          />
        </div>
      )}
    </Stack>
  );
}

function NoPlan({ message }: { readonly message: string }) {
  return (
    <Stack gap={2}>
      <Text fw={600} size="sm">
        No plan for this result
      </Text>
      <Text size="sm" c="dimmed">
        {message}
      </Text>
    </Stack>
  );
}
