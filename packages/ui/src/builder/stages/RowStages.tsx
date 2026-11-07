import type { FieldInfo, StageBody } from '@mongo-gui/core';
import { GroupEditor } from '../GroupEditor';
import { ProjectionPanel, SortPanel } from '../RowPanels';
import { useStageKey } from './stage-form';

export type MatchBody = Extract<StageBody, { stage: '$match' }>;
export type ProjectBody = Extract<StageBody, { stage: '$project' }>;
export type SortBody = Extract<StageBody, { stage: '$sort' }>;

export interface MatchStageFormProps {
  readonly body: MatchBody;
  /** The fields of the collection. They are suggestions only. */
  readonly fields: readonly FieldInfo[];
  readonly onChange: (body: MatchBody) => void;
}

/** The `$match` filter, edited with the find builder's group editor. */
export function MatchStageForm({ body, fields, onChange }: MatchStageFormProps) {
  const { key, emit } = useStageKey(body, onChange);
  return (
    <GroupEditor
      key={key}
      group={body.filter}
      fields={fields}
      onChange={(filter) => emit({ ...body, filter })}
    />
  );
}

export interface ProjectStageFormProps {
  readonly body: ProjectBody;
  /** The fields of the collection. They are suggestions only. */
  readonly fields: readonly FieldInfo[];
  readonly onChange: (body: ProjectBody) => void;
}

/** The `$project` rows, edited with the find builder's projection panel. */
export function ProjectStageForm({ body, fields, onChange }: ProjectStageFormProps) {
  const { key, emit } = useStageKey(body, onChange);
  return (
    <ProjectionPanel
      key={key}
      rows={body.rows}
      fields={fields}
      onChange={(rows) => emit({ ...body, rows })}
    />
  );
}

export interface SortStageFormProps {
  readonly body: SortBody;
  /** The fields of the collection. They are suggestions only. */
  readonly fields: readonly FieldInfo[];
  readonly onChange: (body: SortBody) => void;
}

/** The `$sort` rows, edited with the find builder's sort panel. */
export function SortStageForm({ body, fields, onChange }: SortStageFormProps) {
  const { key, emit } = useStageKey(body, onChange);
  return (
    <SortPanel
      key={key}
      rows={body.rows}
      fields={fields}
      onChange={(rows) => emit({ ...body, rows })}
    />
  );
}
