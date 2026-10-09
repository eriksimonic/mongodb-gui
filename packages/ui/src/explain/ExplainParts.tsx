import { Badge, Button, Code, Group, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { ReactNode } from 'react';
import {
  explainInWords,
  suggestedIndexKeys,
  type PlanTree,
  type PlanWarning,
  type PlanWarningSeverity,
} from '@mongo-gui/core';
import { notifyError } from '../components/notify-error';
import { createIndexLine } from './explain-model';

const INTEGER_LOCALE = 'en-US';
const RATIO_DIGITS = 1;
const EMPTY_VALUE = '-';

function count(value: number | undefined): string {
  return value === undefined ? EMPTY_VALUE : value.toLocaleString(INTEGER_LOCALE);
}

interface SummaryItemProps {
  readonly label: string;
  readonly children: ReactNode;
}

function SummaryItem({ label, children }: SummaryItemProps) {
  return (
    <div className="mg-explain-summary-item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The numbers a reader checks first: the index, the examined counts, the time, and two flags. */
export function ExplainSummaryBar({ tree }: { readonly tree: PlanTree }) {
  const { summary } = tree;
  const ratio =
    summary.totalDocsExaminedToReturnedRatio === undefined
      ? EMPTY_VALUE
      : summary.totalDocsExaminedToReturnedRatio.toFixed(RATIO_DIGITS);
  let index: ReactNode;
  if (summary.collectionScan) {
    index = (
      <Text component="span" c="red" fw={600} size="sm">
        Collection scan
      </Text>
    );
  } else {
    index = summary.indexesUsed.length === 0 ? 'None' : summary.indexesUsed.join(', ');
  }
  return (
    <div className="mg-explain-summary-bar">
      <dl className="mg-explain-summary">
        <SummaryItem label="Index">{index}</SummaryItem>
        <SummaryItem label="Keys examined">{count(summary.keysExamined)}</SummaryItem>
        <SummaryItem label="Docs examined">{count(summary.docsExamined)}</SummaryItem>
        <SummaryItem label="Returned">{count(summary.nReturned)}</SummaryItem>
        <SummaryItem label="Examined per returned">{ratio}</SummaryItem>
        <SummaryItem label="Time">
          {summary.executionTimeMs === undefined ? EMPTY_VALUE : `${summary.executionTimeMs} ms`}
        </SummaryItem>
      </dl>
      <Group gap={4}>
        {summary.inMemorySort ? (
          <Badge color="orange" variant="light">
            Sort in memory
          </Badge>
        ) : null}
        {summary.covered === true ? (
          <Badge color="teal" variant="light">
            Covered
          </Badge>
        ) : null}
      </Group>
    </div>
  );
}

const SEVERITY_COLOR: Readonly<Record<PlanWarningSeverity, string>> = {
  critical: 'red',
  warning: 'yellow',
  info: 'blue',
};

export interface ExplainWarningsProps {
  readonly warnings: readonly PlanWarning[];
  /** Called with the stage name a warning points at. Warnings without a stage do nothing. */
  readonly onSelect: (stageName: string) => void;
}

/** One row per warning. A row with a stage selects that stage in the tree when clicked. */
export function ExplainWarnings({ warnings, onSelect }: ExplainWarningsProps) {
  if (warnings.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No warnings
      </Text>
    );
  }
  return (
    <Stack gap={4} className="mg-explain-warnings">
      <Text fw={600} size="sm">
        Warnings
      </Text>
      {warnings.map((warning, index) => {
        const stageName = warning.stageName;
        return (
          <button
            key={`${warning.code}-${index}`}
            type="button"
            className="mg-explain-warning"
            data-severity={warning.severity}
            disabled={stageName === undefined}
            onClick={() => {
              if (stageName !== undefined) {
                onSelect(stageName);
              }
            }}
          >
            <Badge color={SEVERITY_COLOR[warning.severity]} variant="light" size="sm">
              {warning.severity}
            </Badge>
            <Code>{warning.code}</Code>
            <span className="mg-explain-warning-message">{warning.message}</span>
            {stageName === undefined ? null : (
              <span className="mg-explain-warning-stage">Stage {stageName}</span>
            )}
          </button>
        );
      })}
    </Stack>
  );
}

export interface ExplainPlainLanguageProps {
  readonly tree: PlanTree;
  /** The collection the plan is for. The index line needs it. */
  readonly collection: string | undefined;
}

/** The plan in sentences, and the index that would remove the top warning, ready to copy. */
export function ExplainPlainLanguage({ tree, collection }: ExplainPlainLanguageProps) {
  const sentences = explainInWords(tree);
  const keys = suggestedIndexKeys(tree);
  const line =
    keys === undefined || collection === undefined ? undefined : createIndexLine(collection, keys);

  async function copyLine(): Promise<void> {
    if (line === undefined) {
      return;
    }
    try {
      await navigator.clipboard.writeText(line);
      notifications.show({ title: 'Index command copied', message: line, color: 'teal' });
    } catch (error) {
      notifyError(error, 'The command could not be copied');
    }
  }

  return (
    <Stack gap={4} className="mg-explain-words">
      <Text fw={600} size="sm">
        In plain words
      </Text>
      {sentences.map((sentence, index) => (
        <Text key={`${index}-${sentence}`} size="sm">
          {sentence}
        </Text>
      ))}
      {line === undefined ? null : (
        <Group gap="xs" wrap="nowrap" align="center">
          <Code className="mg-explain-index-line">{line}</Code>
          <Button size="xs" variant="default" onClick={() => void copyLine()}>
            Copy
          </Button>
        </Group>
      )}
    </Stack>
  );
}
