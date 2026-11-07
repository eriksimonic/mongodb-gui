import { Box, Checkbox, Group, Paper, Stack, Text } from '@mantine/core';
import type { FieldInfo, FindStatement } from '@mongo-gui/core';
import type { ReactNode } from 'react';
import { GroupEditor } from './GroupEditor';
import { ProjectionPanel, SkipLimitRow, SortPanel } from './RowPanels';

export interface FindBuilderProps {
  readonly statement: FindStatement;
  /** The fields of the collection. They are suggestions only. */
  readonly fields: readonly FieldInfo[];
  /** Receives the whole find statement after every change. */
  readonly onChange: (statement: FindStatement) => void;
}

interface PanelFrameProps {
  readonly title: string;
  readonly enabled: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly children: ReactNode;
}

/**
 * A panel with a title bar and an enable checkbox. A disabled panel cannot be edited, and its rows
 * stay in the statement.
 */
function PanelFrame({ title, enabled, onToggle, children }: PanelFrameProps) {
  return (
    <Paper component="section" aria-label={title} withBorder p="xs">
      <Stack gap="xs">
        <Group gap="xs" wrap="nowrap">
          <Checkbox
            size="xs"
            aria-label={`Enable ${title.toLowerCase()}`}
            checked={enabled}
            onChange={(event) => onToggle(event.currentTarget.checked)}
          />
          <Text fw={600} size="sm">
            {title}
          </Text>
        </Group>
        <Box inert={!enabled} opacity={enabled ? 1 : 0.5}>
          {children}
        </Box>
      </Stack>
    </Paper>
  );
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

  return (
    <Stack gap="sm">
      <PanelFrame
        title="Query"
        enabled={statement.filterEnabled !== false}
        onToggle={(enabled) => togglePanel('filterEnabled', enabled)}
      >
        <GroupEditor
          group={statement.filter}
          fields={fields}
          onChange={(filter) => onChange({ ...statement, filter })}
        />
      </PanelFrame>
      <PanelFrame
        title="Projection"
        enabled={statement.projectionEnabled !== false}
        onToggle={(enabled) => togglePanel('projectionEnabled', enabled)}
      >
        <ProjectionPanel
          rows={statement.projection}
          fields={fields}
          onChange={(projection) => onChange({ ...statement, projection })}
        />
      </PanelFrame>
      <PanelFrame
        title="Sort"
        enabled={statement.sortEnabled !== false}
        onToggle={(enabled) => togglePanel('sortEnabled', enabled)}
      >
        <SortPanel
          rows={statement.sort}
          fields={fields}
          onChange={(sort) => onChange({ ...statement, sort })}
        />
      </PanelFrame>
      <SkipLimitRow
        skip={statement.skip}
        limit={statement.limit}
        onChange={(next) => onChange({ ...statement, ...next })}
      />
    </Stack>
  );
}
