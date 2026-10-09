import {
  Alert,
  Button,
  Checkbox,
  CopyButton,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { useUiApi } from '../api/ui-api';
import { SchemaFieldTable } from './SchemaFieldTable';
import { SchemaSummaryView } from './SchemaSummaryView';
import {
  buildRows,
  filtersActive,
  formatCount,
  formatElapsed,
  legendBuckets,
  SAMPLE_SIZES,
  SPARSE_PRESENCE,
  summarizeTotals,
  topLevelTypeTotals,
  type SampleSizeOption,
} from './schema-model';
import { createSchemaStore, type SchemaTarget } from './schema-store';

const STRATEGY_OPTIONS = [
  { value: 'random', label: 'Random' },
  { value: 'first', label: 'First by _id' },
  { value: 'last', label: 'Last by _id' },
];

const SIZE_OPTIONS = SAMPLE_SIZES.map((size) => ({
  value: String(size),
  label: `${formatCount(size)} documents`,
}));

function parseSize(value: string | null): SampleSizeOption {
  return SAMPLE_SIZES.find((size) => String(size) === value) ?? 1000;
}

function parseStrategy(value: string | null): 'random' | 'first' | 'last' {
  return value === 'first' || value === 'last' ? value : 'random';
}

/**
 * Samples one collection and reports its fields: types, presence, examples, distinct ratio and
 * ranges. The header chooses the sample, the summary counts the fields, and the table lists them.
 * Row actions lead to indexes, validation rules and queries.
 */
export function SchemaPanel({ connectionId, database, collection }: SchemaTarget) {
  const { rpc } = useUiApi();
  const [store] = useState(() =>
    createSchemaStore({
      target: { connectionId, database, collection },
      analyse: (input) => rpc.schema.analyse(input),
    }),
  );
  const state = useStore(store, (current) => current);
  const { report, loading, error, elapsedMs, sort, filters, expanded } = state;
  const fields = useMemo(() => report?.fields ?? [], [report]);
  const rows = useMemo(
    () => buildRows(fields, { filters, sort, expanded }),
    [fields, filters, sort, expanded],
  );
  const totals = useMemo(() => summarizeTotals(fields), [fields]);
  const topTypes = useMemo(() => topLevelTypeTotals(fields), [fields]);
  const legend = useMemo(() => legendBuckets(fields), [fields]);
  const target = useMemo(
    () => ({ connectionId, database, collection }),
    [connectionId, database, collection],
  );
  const reportText = report === undefined ? '' : JSON.stringify(report, null, 2);
  const narrowed = filtersActive(filters);

  return (
    <Stack gap="sm" p="sm" h="100%" style={{ minHeight: 0, overflow: 'hidden' }}>
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Group gap="xs" align="flex-end" wrap="wrap">
          <Select
            label="Sample size"
            data={SIZE_OPTIONS}
            value={String(state.sampleSize)}
            onChange={(value) => state.setSampleSize(parseSize(value))}
            allowDeselect={false}
            w={170}
          />
          <Select
            label="Strategy"
            data={STRATEGY_OPTIONS}
            value={state.strategy}
            onChange={(value) => state.setStrategy(parseStrategy(value))}
            allowDeselect={false}
            w={150}
          />
          <Button loading={loading} onClick={() => void state.analyse()}>
            Analyse
          </Button>
        </Group>
        <Group gap="xs" align="center" wrap="nowrap">
          {report === undefined ? null : (
            <Text size="sm" c="dimmed" role="status">
              {report.total < report.sampled
                ? `Sampled ${formatCount(report.sampled)} documents (collection count unknown)`
                : `Sampled ${formatCount(report.sampled)} of ${formatCount(report.total)} documents`}
              {elapsedMs === undefined ? '' : `, in ${formatElapsed(elapsedMs)}`}
            </Text>
          )}
          <CopyButton value={reportText}>
            {({ copied, copy }) => (
              <Button variant="default" disabled={report === undefined} onClick={copy}>
                {copied ? 'Copied' : 'Export report'}
              </Button>
            )}
          </CopyButton>
        </Group>
      </Group>

      {error === undefined ? null : (
        <Alert color="red" variant="light" role="alert">
          {error}
        </Alert>
      )}

      {report === undefined && !loading && error === undefined ? (
        <Text size="sm" c="dimmed">
          Choose a sample size and strategy, then press Analyse. Fields, types, presence and
          examples come from the sampled documents.
        </Text>
      ) : null}

      {report !== undefined && report.sampled === 0 ? (
        <Alert color="gray" variant="light">
          The collection has no documents to sample.
        </Alert>
      ) : null}

      {report !== undefined && report.sampled < report.total ? (
        <Text size="xs" c="dimmed">
          {`The sample holds ${formatCount(report.sampled)} of about ${formatCount(report.total)} documents. Presence and types describe the sample, so a rare field can be missing from it.`}
        </Text>
      ) : null}

      {report !== undefined && report.sampled > 0 ? (
        <>
          <SchemaSummaryView totals={totals} topTypes={topTypes} legend={legend} />
          <Group gap="sm" align="flex-end" wrap="wrap">
            <TextInput
              label="Path contains"
              placeholder="customer.address"
              value={filters.text}
              onChange={(event) => state.setPathText(event.currentTarget.value)}
              w={260}
            />
            <Checkbox
              label="Only mixed types"
              checked={filters.mixedOnly}
              onChange={(event) => state.setMixedOnly(event.currentTarget.checked)}
              mb={4}
            />
            <Checkbox
              label={`Only sparse (under ${Math.round(SPARSE_PRESENCE * 100)}%)`}
              checked={filters.sparseOnly}
              onChange={(event) => state.setSparseOnly(event.currentTarget.checked)}
              mb={4}
            />
            {narrowed ? (
              <Text size="xs" c="dimmed" mb={6}>
                {`${formatCount(rows.length)} of ${formatCount(fields.length)} fields match`}
              </Text>
            ) : null}
          </Group>
          <SchemaFieldTable
            rows={rows}
            sort={sort}
            target={target}
            onSort={state.sortBy}
            onToggle={state.toggleRow}
          />
        </>
      ) : null}
    </Stack>
  );
}
