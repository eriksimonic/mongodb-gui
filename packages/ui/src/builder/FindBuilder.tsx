import { Stack } from '@mantine/core';
import type { FieldInfo, FindStatement } from '@mongo-gui/core';
import { BuilderCard } from './BuilderCard';
import { countText, STAGE_ICONS, STAGE_TONES } from './card-kinds';
import { GroupEditor } from './GroupEditor';
import { ProjectionPanel, SkipLimitRow, SortPanel } from './RowPanels';

export interface FindBuilderProps {
  readonly statement: FindStatement;
  /** The fields of the collection. They are suggestions only. */
  readonly fields: readonly FieldInfo[];
  /** Receives the whole find statement after every change. */
  readonly onChange: (statement: FindStatement) => void;
}

/**
 * The find statement as three panels (Query, Projection, Sort) and the skip and limit row.
 *
 * It is stateless: the parent holds the statement and receives every change as a new statement.
 * The rows and `GroupEditor` read their type and value only on mount. The parent (BuilderPanel,
 * task U7) must remount this component with a `key` when the statement changes from outside.
 */
export function FindBuilder({ statement, fields, onChange }: FindBuilderProps) {
  // A missing flag means enabled. Enabling writes `undefined`, so an enabled panel has the same
  // shape as a parsed statement.
  const togglePanel = (
    key: 'filterEnabled' | 'projectionEnabled' | 'sortEnabled',
    enabled: boolean,
  ): void => {
    onChange({ ...statement, [key]: enabled ? undefined : false });
  };

  const conditions = statement.filter.items.length;

  return (
    <Stack gap="sm">
      <BuilderCard
        title="Query"
        icon={STAGE_ICONS.$match}
        tone={STAGE_TONES.$match}
        summary={conditions === 0 ? 'Matches every document' : countText(conditions, 'condition')}
        enabled={statement.filterEnabled !== false}
        toggleLabel="Enable query"
        onToggle={(enabled) => togglePanel('filterEnabled', enabled)}
      >
        <GroupEditor
          group={statement.filter}
          fields={fields}
          onChange={(filter) => onChange({ ...statement, filter })}
        />
      </BuilderCard>
      <BuilderCard
        title="Projection"
        icon={STAGE_ICONS.$project}
        tone={STAGE_TONES.$project}
        summary={
          statement.projection.length === 0
            ? 'All fields'
            : countText(statement.projection.length, 'field')
        }
        enabled={statement.projectionEnabled !== false}
        toggleLabel="Enable projection"
        onToggle={(enabled) => togglePanel('projectionEnabled', enabled)}
      >
        <ProjectionPanel
          rows={statement.projection}
          fields={fields}
          onChange={(projection) => onChange({ ...statement, projection })}
        />
      </BuilderCard>
      <BuilderCard
        title="Sort"
        icon={STAGE_ICONS.$sort}
        tone={STAGE_TONES.$sort}
        summary={
          statement.sort.length === 0 ? 'Natural order' : countText(statement.sort.length, 'field')
        }
        enabled={statement.sortEnabled !== false}
        toggleLabel="Enable sort"
        onToggle={(enabled) => togglePanel('sortEnabled', enabled)}
      >
        <SortPanel
          rows={statement.sort}
          fields={fields}
          onChange={(sort) => onChange({ ...statement, sort })}
        />
      </BuilderCard>
      <SkipLimitRow
        skip={statement.skip}
        limit={statement.limit}
        onChange={(next) => onChange({ ...statement, ...next })}
      />
    </Stack>
  );
}
