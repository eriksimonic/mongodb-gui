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
} from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import {
  explainInWords,
  PlanVerbositySchema,
  type PlanTree,
  type PlanVerbosity,
} from '@mongo-gui/core';
import { useState } from 'react';
import { errorText } from '../components/notify-error';
import { useAppStore } from '../state/app-store-context';
import { stageIdByName, type ExplainPanelState } from './explain-model';
import { ExplainPlainLanguage, ExplainSummaryBar, ExplainWarnings } from './ExplainParts';
import { ExplainRaw } from './ExplainRaw';
import { PlanTreeView, type StageSelection } from './PlanTreeView';
import './explain.css';

export interface ExplainPanelProps {
  /** The id the store gave the panel. The panel reads its request and result from the store. */
  readonly panelId: string;
}

const VERBOSITIES = PlanVerbositySchema.options;

const VERBOSITY_DATA = VERBOSITIES.map((value) => ({ value, label: value }));

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
  const [statementOpen, setStatementOpen] = useState(false);
  const [tab, setTab] = useState<string | null>('plan');
  const [selection, setSelection] = useState<StageSelection | undefined>(undefined);
  const { outcome, request } = panel;
  const busy = outcome.state === 'loading';
  const refused = outcome.state === 'refused';
  const statement =
    request.source.kind === 'statement' ? request.source.code : request.source.commandEjson;

  return (
    <Stack gap="xs" p="sm" className="mg-explain">
      <button
        type="button"
        className={
          statementOpen ? 'mg-explain-statement mg-explain-statement-open' : 'mg-explain-statement'
        }
        aria-expanded={statementOpen}
        title={statement}
        onClick={() => setStatementOpen((open) => !open)}
      >
        <code>{statement}</code>
      </button>

      <Group gap="xs" wrap="wrap" justify="space-between">
        <Group gap="xs" wrap="wrap">
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
            disabled={busy || refused}
            onClick={() => void rerun(panel.id)}
          >
            Re-run
          </Button>
        </Group>
        <Group gap="xs" wrap="wrap">
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
      {outcome.state === 'ready' ? (
        <Tabs value={tab} onChange={setTab}>
          <Tabs.List>
            <Tabs.Tab value="plan">Plan</Tabs.Tab>
            <Tabs.Tab value="raw">Raw</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="plan" pt="xs">
            <PlanView
              tree={outcome.result.tree}
              collection={panel.collection}
              selection={selection}
              onSelect={setSelection}
            />
          </Tabs.Panel>
          <Tabs.Panel value="raw" pt="xs">
            <ExplainRaw text={outcome.result.rawEjson} />
          </Tabs.Panel>
        </Tabs>
      ) : null}
    </Stack>
  );
}

interface PlanViewProps {
  readonly tree: PlanTree;
  readonly collection: string | undefined;
  readonly selection: StageSelection | undefined;
  readonly onSelect: (selection: StageSelection | undefined) => void;
}

function PlanView({ tree, collection, selection, onSelect }: PlanViewProps) {
  if (tree.command === 'unknown') {
    return <NoPlan message={explainInWords(tree)[0] ?? 'The explain output is not a plan.'} />;
  }
  return (
    <Stack gap="sm">
      <ExplainSummaryBar tree={tree} />
      <ExplainWarnings
        warnings={tree.warnings}
        onSelect={(stageName) => {
          const id = stageIdByName(tree.winning, stageName);
          if (id !== undefined) {
            onSelect({ id });
          }
        }}
      />
      <ExplainPlainLanguage tree={tree} collection={collection} />
      <PlanTreeView
        root={tree.winning}
        rejected={tree.rejected}
        selection={selection}
        onSelect={onSelect}
      />
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
