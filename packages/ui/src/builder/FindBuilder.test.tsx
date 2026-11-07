// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { emitBuilderStatement, type FieldInfo, type FindStatement } from '@mongo-gui/core';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../test-support/render';
import { FindBuilder } from './FindBuilder';

const fields: FieldInfo[] = [
  { path: 'name', types: ['String'] },
  { path: 'total', types: ['Double'] },
  { path: 'status', types: ['String'] },
];

const base: FindStatement = {
  kind: 'find',
  collection: 'orders',
  filter: {
    kind: 'group',
    operator: 'and',
    items: [{ kind: 'condition', enabled: true, field: 'name', operator: 'eq', value: 'shop' }],
  },
  projection: [],
  sort: [{ enabled: true, field: 'total', direction: -1 }],
  skip: null,
  limit: null,
};

/** Keeps the statement in state, as BuilderPanel does, and reports every change. */
function Harness({
  initial,
  onChange,
}: {
  readonly initial: FindStatement;
  readonly onChange: (statement: FindStatement) => void;
}) {
  const [statement, setStatement] = useState(initial);
  return (
    <FindBuilder
      statement={statement}
      fields={fields}
      onChange={(next) => {
        setStatement(next);
        onChange(next);
      }}
    />
  );
}

function renderFind(initial: FindStatement = base) {
  const onChange = vi.fn<(statement: FindStatement) => void>();
  renderWithApp(<Harness initial={initial} onChange={onChange} />);
  const lastStatement = (): FindStatement | undefined => onChange.mock.lastCall?.[0];
  return { onChange, lastStatement };
}

describe('FindBuilder', () => {
  it('edits a condition and emits the whole statement', () => {
    const { lastStatement } = renderFind();

    fireEvent.change(screen.getByRole('textbox', { name: 'Value' }), {
      target: { value: 'outlet' },
    });

    expect(lastStatement()).toEqual({
      ...base,
      filter: {
        kind: 'group',
        operator: 'and',
        items: [
          { kind: 'condition', enabled: true, field: 'name', operator: 'eq', value: 'outlet' },
        ],
      },
    });
  });

  it('disables the sort panel, keeps its rows, and leaves the sort out of the text', () => {
    const { lastStatement } = renderFind();

    fireEvent.click(screen.getByRole('switch', { name: 'Enable sort' }));

    expect(lastStatement()).toEqual({ ...base, sortEnabled: false });
    expect(lastStatement()?.sort).toEqual(base.sort);
    const text = emitBuilderStatement(lastStatement() as FindStatement);
    expect(text).not.toContain('.sort(');
    expect(text).toBe('db.orders.find({\n  name: "shop"\n})');
  });

  it('enables a disabled panel again and drops the flag', () => {
    const { lastStatement } = renderFind({ ...base, sortEnabled: false });

    fireEvent.click(screen.getByRole('switch', { name: 'Enable sort' }));

    expect(lastStatement()).toEqual(base);
  });

  it('disables the Query panel and writes the projection alone', () => {
    const { lastStatement } = renderFind({ ...base, projection: [] });

    fireEvent.click(screen.getByRole('switch', { name: 'Enable query' }));

    expect(lastStatement()).toEqual({ ...base, filterEnabled: false });
    expect(emitBuilderStatement(lastStatement() as FindStatement)).toBe(
      'db.orders.find().sort({\n  total: -1\n})',
    );
  });

  it('adds a projection row, names the field and excludes it', () => {
    const { lastStatement } = renderFind();
    const projection = within(screen.getByRole('region', { name: 'Projection' }));

    fireEvent.click(projection.getByRole('button', { name: 'Add field' }));
    fireEvent.change(projection.getByRole('textbox', { name: 'Projection field' }), {
      target: { value: 'status' },
    });
    fireEvent.click(projection.getByRole('radio', { name: 'Exclude' }));

    expect(lastStatement()?.projection).toEqual([
      { kind: 'field', enabled: true, field: 'status', include: false },
    ]);
  });

  it('sets the limit and keeps the skip empty', () => {
    const { lastStatement } = renderFind();

    fireEvent.change(screen.getByRole('textbox', { name: 'Limit' }), {
      target: { value: '10' },
    });

    expect(lastStatement()).toEqual({ ...base, limit: 10, skip: null });
    expect(emitBuilderStatement(lastStatement() as FindStatement)).toContain('.limit(10)');
  });

  it('clears the limit to null when its box is emptied', () => {
    const { lastStatement } = renderFind({ ...base, limit: 5 });

    fireEvent.change(screen.getByRole('textbox', { name: 'Limit' }), { target: { value: '' } });

    expect(lastStatement()?.limit).toBeNull();
  });

  it('shows a disabled panel as inert and keeps its rows', () => {
    renderFind({ ...base, sortEnabled: false });
    const sort = within(screen.getByRole('region', { name: 'Sort' }));
    const queryValue = within(screen.getByRole('region', { name: 'Query' })).getByRole('textbox', {
      name: 'Value',
    });

    expect(sort.getByRole('textbox', { name: 'Sort field' })).toHaveValue('total');
    expect(sort.getByRole('textbox', { name: 'Sort field' }).closest('[inert]')).not.toBeNull();
    expect(queryValue.closest('[inert]')).toBeNull();
  });

  it('disables the projection, keeps its rows, and leaves it out of the text', () => {
    const projection = [{ kind: 'field', enabled: true, field: 'name', include: true }] as const;
    const { lastStatement } = renderFind({ ...base, projection });

    fireEvent.click(screen.getByRole('switch', { name: 'Enable projection' }));

    expect(lastStatement()).toEqual({ ...base, projection, projectionEnabled: false });
    expect(emitBuilderStatement(lastStatement() as FindStatement)).toBe(
      'db.orders.find({\n  name: "shop"\n}).sort({\n  total: -1\n})',
    );
  });

  it('keeps a disabled panel disabled after an edit in another panel', () => {
    const { lastStatement } = renderFind({ ...base, sortEnabled: false });

    fireEvent.change(screen.getByRole('textbox', { name: 'Limit' }), { target: { value: '5' } });

    expect(lastStatement()).toEqual({ ...base, sortEnabled: false, limit: 5 });
    expect(lastStatement()?.sortEnabled).toBe(false);
  });

  it('edits a sort row field and direction', () => {
    const { lastStatement } = renderFind();
    const sort = within(screen.getByRole('region', { name: 'Sort' }));

    fireEvent.change(sort.getByRole('textbox', { name: 'Sort field' }), {
      target: { value: 'status' },
    });
    fireEvent.click(sort.getByRole('radio', { name: 'Ascending' }));

    expect(lastStatement()?.sort).toEqual([{ enabled: true, field: 'status', direction: 1 }]);
  });

  it('keeps the Query panel disabled when its group is edited', () => {
    const { lastStatement } = renderFind({ ...base, filterEnabled: false });
    const query = within(screen.getByRole('region', { name: 'Query' }));

    fireEvent.change(query.getByRole('textbox', { name: 'Value' }), {
      target: { value: 'outlet' },
    });

    expect(lastStatement()?.filterEnabled).toBe(false);
    expect(lastStatement()?.filter.items).toEqual([
      { kind: 'condition', enabled: true, field: 'name', operator: 'eq', value: 'outlet' },
    ]);
  });
});
