// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { emitBuilderStatement, type FieldInfo, type PipelineStage } from '@mongo-gui/core';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../test-support/render';
import { StageList } from './StageList';

const fields: FieldInfo[] = [{ path: 'name', types: ['String'] }];

const limit: PipelineStage = { stage: '$limit', count: 5, enabled: true };
const skip: PipelineStage = { stage: '$skip', count: 2, enabled: true };
const count: PipelineStage = { stage: '$count', output: 'total', enabled: true };

/** Keeps the stages in state, as the find builder does, and reports every change. */
function Harness({
  initial,
  onChange,
}: {
  readonly initial: readonly PipelineStage[];
  readonly onChange: (stages: PipelineStage[]) => void;
}) {
  const [stages, setStages] = useState<readonly PipelineStage[]>(initial);
  return (
    <StageList
      stages={stages}
      fields={fields}
      onChange={(next) => {
        setStages(next);
        onChange(next);
      }}
    />
  );
}

function renderList(initial: readonly PipelineStage[]): ReturnType<typeof vi.fn> {
  const onChange = vi.fn();
  renderWithApp(<Harness initial={initial} onChange={onChange} />);
  return onChange;
}

/** The element at `index` among those with the role and name. Fails the test when there is none. */
function nthNamed(role: 'button' | 'checkbox', name: string, index: number): HTMLElement {
  const found = screen.getAllByRole(role, { name }).at(index);
  if (found === undefined) {
    throw new Error(`no ${role} named ${name} at ${index}`);
  }
  return found;
}

/** The stage kinds of the reported list, in order. */
function kindsOf(onChange: ReturnType<typeof vi.fn>): string[] {
  const last = onChange.mock.lastCall?.[0] as PipelineStage[];
  return last.map((stage) => (stage.stage === 'raw' ? stage.name : stage.stage));
}

describe('StageList', () => {
  it('adds a stage of the chosen kind at the end, enabled', () => {
    const onChange = renderList([limit]);
    fireEvent.click(screen.getByRole('button', { name: 'Add stage' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '$count' }));
    expect(onChange).toHaveBeenLastCalledWith([
      limit,
      { stage: '$count', output: 'count', enabled: true },
    ]);
  });

  it('moves a stage down and up and disables the end buttons', () => {
    const onChange = renderList([limit, skip, count]);
    fireEvent.click(nthNamed('button', 'Move stage down', 0));
    expect(kindsOf(onChange)).toEqual(['$skip', '$limit', '$count']);

    fireEvent.click(nthNamed('button', 'Move stage up', 1));
    expect(kindsOf(onChange)).toEqual(['$limit', '$skip', '$count']);
  });

  it('keeps the card order on screen after a move', () => {
    renderList([limit, skip, count]);
    fireEvent.click(nthNamed('button', 'Move stage down', 0));
    expect(screen.getAllByRole('checkbox', { name: 'Enable stage' })).toHaveLength(3);
    expect(screen.getAllByLabelText('Count')[0]).toHaveValue('2');
    expect(screen.getAllByLabelText('Count')[1]).toHaveValue('5');
  });

  it('disables a stage and keeps it in the list', () => {
    const onChange = renderList([limit, skip, count]);
    fireEvent.click(nthNamed('checkbox', 'Enable stage', 1));
    expect(onChange).toHaveBeenLastCalledWith([limit, { ...skip, enabled: false }, count]);
    expect(screen.getAllByRole('checkbox', { name: 'Enable stage' })).toHaveLength(3);
  });

  it('deletes a stage', () => {
    const onChange = renderList([limit, skip, count]);
    fireEvent.click(nthNamed('button', 'Delete stage', 0));
    expect(onChange).toHaveBeenLastCalledWith([skip, count]);
    expect(screen.getAllByRole('checkbox', { name: 'Enable stage' })).toHaveLength(2);
  });

  it('copies a stage after itself', () => {
    const onChange = renderList([limit, count]);
    fireEvent.click(nthNamed('button', 'Copy stage', 0));
    expect(onChange).toHaveBeenLastCalledWith([limit, limit, count]);
  });

  it('edits a simple form and reports the whole stage list', () => {
    const onChange = renderList([limit, count]);
    fireEvent.change(screen.getByLabelText('Output field'), { target: { value: 'n' } });
    expect(onChange).toHaveBeenLastCalledWith([
      limit,
      { stage: '$count', output: 'n', enabled: true },
    ]);
  });

  it('keeps a disabled stage disabled when its form changes', () => {
    const onChange = renderList([{ ...count, enabled: false }]);
    fireEvent.change(screen.getByLabelText('Output field'), { target: { value: 'n' } });
    expect(onChange).toHaveBeenLastCalledWith([{ stage: '$count', output: 'n', enabled: false }]);
  });

  it('adds a raw stage that refuses a known stage name', () => {
    const onChange = renderList([]);
    fireEvent.click(screen.getByRole('button', { name: 'Add stage' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Raw stage' }));
    expect(kindsOf(onChange)).toEqual(['$addFields']);

    const input = screen.getByLabelText('Raw stage text');
    fireEvent.change(input, { target: { value: '{ $sort: { name: 1 } }' } });
    fireEvent.blur(input);
    expect(
      screen.getByText('$sort has its own form. Use the $sort stage instead of a raw stage.'),
    ).toBeInTheDocument();
    expect(kindsOf(onChange)).toEqual(['$addFields']);
  });

  it('shows the not-in-query cue on a fresh $unwind card and removes it when a path is typed', () => {
    renderList([]);
    fireEvent.click(screen.getByRole('button', { name: 'Add stage' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '$unwind' }));
    expect(screen.getByText('Not in the query yet')).toBeVisible();

    fireEvent.change(screen.getByRole('textbox', { name: 'Array path' }), {
      target: { value: '$items' },
    });
    expect(screen.queryByText('Not in the query yet')).toBeNull();
  });

  it('shows no not-in-query cue on a disabled unfinished stage', () => {
    renderList([{ stage: '$unwind', path: '', preserveEmpty: false, enabled: false }]);
    expect(screen.queryByText('Not in the query yet')).toBeNull();
  });
});

describe('StageList with the $match, $project, $sort and $group forms', () => {
  const match: PipelineStage = {
    stage: '$match',
    enabled: true,
    filter: {
      kind: 'group',
      operator: 'and',
      items: [{ kind: 'condition', enabled: true, field: 'name', operator: 'eq', value: 'shop' }],
    },
  };
  const project: PipelineStage = {
    stage: '$project',
    enabled: true,
    rows: [{ kind: 'field', enabled: true, field: 'name', include: true }],
  };
  const sort: PipelineStage = {
    stage: '$sort',
    enabled: true,
    rows: [{ enabled: true, field: 'name', direction: 1 }],
  };
  const group: PipelineStage = {
    stage: '$group',
    enabled: true,
    id: null,
    accumulators: [{ output: 'total', accumulator: '$sum', expression: 1 }],
  };
  const four = [match, project, sort, group];

  /** The stages of the last change, as the parent received them. */
  function lastStages(onChange: ReturnType<typeof vi.fn>): PipelineStage[] {
    return onChange.mock.lastCall?.[0] as PipelineStage[];
  }

  it('renders one card for each form, with its own controls', () => {
    renderList(four);
    expect(screen.getByRole('textbox', { name: 'Field' })).toHaveValue('name');
    expect(screen.getByRole('textbox', { name: 'Projection field' })).toHaveValue('name');
    expect(screen.getByRole('textbox', { name: 'Sort field' })).toHaveValue('name');
    expect(screen.getByRole('textbox', { name: 'Group by expression' })).toHaveValue('null');
    expect(screen.getByRole('textbox', { name: 'Output field' })).toHaveValue('total');
  });

  it('edits the field of the $match condition', () => {
    const onChange = renderList(four);
    fireEvent.change(screen.getByRole('textbox', { name: 'Field' }), {
      target: { value: 'price' },
    });
    expect(lastStages(onChange)).toEqual([
      {
        ...match,
        filter: {
          kind: 'group',
          operator: 'and',
          items: [
            { kind: 'condition', enabled: true, field: 'price', operator: 'eq', value: 'shop' },
          ],
        },
      },
      project,
      sort,
      group,
    ]);
  });

  it('edits the field of the $project row', () => {
    const onChange = renderList(four);
    fireEvent.change(screen.getByRole('textbox', { name: 'Projection field' }), {
      target: { value: 'total' },
    });
    expect(lastStages(onChange)).toEqual([
      match,
      { ...project, rows: [{ kind: 'field', enabled: true, field: 'total', include: true }] },
      sort,
      group,
    ]);
  });

  it('edits the field of the $sort row', () => {
    const onChange = renderList(four);
    fireEvent.change(screen.getByRole('textbox', { name: 'Sort field' }), {
      target: { value: 'total' },
    });
    expect(lastStages(onChange)).toEqual([
      match,
      project,
      { ...sort, rows: [{ enabled: true, field: 'total', direction: 1 }] },
      group,
    ]);
  });

  it('edits the $group id expression', () => {
    const onChange = renderList(four);
    const input = screen.getByRole('textbox', { name: 'Group by expression' });
    fireEvent.change(input, { target: { value: '"$name"' } });
    fireEvent.blur(input);
    expect(lastStages(onChange)).toEqual([match, project, sort, { ...group, id: '$name' }]);
  });

  it('keeps the $group output box mounted while the user types in it', () => {
    const onChange = renderList(four);
    const input = screen.getByRole('textbox', { name: 'Output field' });
    fireEvent.change(input, { target: { value: 'totalA' } });
    fireEvent.change(input, { target: { value: 'totalAB' } });
    expect(screen.getByRole('textbox', { name: 'Output field' })).toBe(input);
    expect(input).toHaveValue('totalAB');
    expect(lastStages(onChange)[3]).toEqual({
      ...group,
      accumulators: [{ output: 'totalAB', accumulator: '$sum', expression: 1 }],
    });
  });

  it('emits no $unwind stage until a path is typed', () => {
    const onChange = renderList([]);
    fireEvent.click(screen.getByRole('button', { name: 'Add stage' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '$unwind' }));
    const emitted = (): string =>
      emitBuilderStatement({
        kind: 'aggregate',
        collection: 'orders',
        stages: lastStages(onChange),
      });
    expect(emitted()).toBe('db.orders.aggregate([])');

    fireEvent.change(screen.getByRole('textbox', { name: 'Array path' }), {
      target: { value: '$items' },
    });
    expect(emitted()).toBe('db.orders.aggregate([\n  {\n    $unwind: "$items"\n  }\n])');
  });

  it('keeps the enabled flag of a stage whose form changes', () => {
    const onChange = renderList([{ ...sort, enabled: false }]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Sort field' }), {
      target: { value: 'total' },
    });
    expect(lastStages(onChange)[0]).toMatchObject({ stage: '$sort', enabled: false });
  });
});
