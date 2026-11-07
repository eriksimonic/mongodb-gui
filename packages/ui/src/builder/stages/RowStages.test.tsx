// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import type { FieldInfo } from '@mongo-gui/core';
import { type ReactNode, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoot } from '../../AppRoot';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { renderWithApp } from '../../test-support/render';
import {
  type MatchBody,
  MatchStageForm,
  type ProjectBody,
  ProjectStageForm,
  type SortBody,
  SortStageForm,
} from './RowStages';

const fields: FieldInfo[] = [
  { path: 'name', types: ['String'] },
  { path: 'total', types: ['Number'] },
];

const match: MatchBody = {
  stage: '$match',
  filter: {
    kind: 'group',
    operator: 'and',
    items: [{ kind: 'condition', enabled: true, field: 'name', operator: 'eq', value: 'shop' }],
  },
};

const project: ProjectBody = {
  stage: '$project',
  rows: [
    { kind: 'field', enabled: true, field: 'name', include: true },
    { kind: 'field', enabled: true, field: 'total', include: false },
  ],
};

const sort: SortBody = {
  stage: '$sort',
  rows: [
    { enabled: true, field: 'name', direction: 1 },
    { enabled: true, field: 'total', direction: -1 },
  ],
};

/**
 * Keeps the body in state and reports every change. `wrap` stores the body the way the stage list
 * does, with extra fields, so the form sees a new object after every change.
 */
function Harness<T>({
  initial,
  onChange,
  render: renderForm,
  wrap = (next: T) => next,
}: {
  readonly initial: T;
  readonly onChange: (body: T) => void;
  readonly render: (body: T, onChange: (next: T) => void) => ReactNode;
  readonly wrap?: (next: T) => T;
}) {
  const [body, setBody] = useState(initial);
  return (
    <>
      {renderForm(body, (next) => {
        setBody(wrap(next));
        onChange(next);
      })}
    </>
  );
}

/** The stage list adds `enabled` to a stage. The form must keep its state when that happens. */
function withEnabled<T extends object>(body: T) {
  return { ...body, enabled: true };
}

/** Types each text into the first box with the label, and checks that the same box keeps focus. */
function typeKeepingFocus(label: string, texts: readonly string[]): void {
  const input = screen.getAllByRole('textbox', { name: label })[0] as HTMLElement;
  input.focus();
  for (const text of texts) {
    fireEvent.change(input, { target: { value: text } });
  }
  expect(screen.getAllByRole('textbox', { name: label })[0]).toBe(input);
  expect(input).toHaveFocus();
}

describe('MatchStageForm', () => {
  it('adds a condition and fills in its field', () => {
    const onChange = vi.fn<(body: MatchBody) => void>();
    renderWithApp(
      <Harness
        initial={match}
        onChange={onChange}
        render={(body, set) => <MatchStageForm body={body} fields={fields} onChange={set} />}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    fireEvent.change(screen.getAllByRole('textbox', { name: 'Field' })[1] as HTMLElement, {
      target: { value: 'total' },
    });

    const last = onChange.mock.lastCall?.[0];
    expect(last?.stage).toBe('$match');
    expect(last?.filter.items).toHaveLength(2);
    expect(last?.filter.items[1]).toMatchObject({ kind: 'condition', field: 'total' });
  });

  it('changes the group operator', () => {
    const onChange = vi.fn<(body: MatchBody) => void>();
    renderWithApp(
      <Harness
        initial={match}
        onChange={onChange}
        render={(body, set) => <MatchStageForm body={body} fields={fields} onChange={set} />}
      />,
    );

    fireEvent.click(screen.getByRole('radio', { name: 'OR' }));

    expect(onChange.mock.lastCall?.[0].filter.operator).toBe('or');
  });

  it('shows a body that the parent sets from outside', () => {
    const api = createMockUiApi();
    const view = (body: MatchBody) => (
      <AppRoot api={api}>
        <MatchStageForm body={body} fields={fields} onChange={() => undefined} />
      </AppRoot>
    );
    const { rerender } = render(view(match));
    const before = screen.getByRole('textbox', { name: 'Field' });
    expect(before).toHaveValue('name');

    rerender(
      view({
        stage: '$match',
        filter: {
          kind: 'group',
          operator: 'and',
          items: [{ kind: 'condition', enabled: true, field: 'total', operator: 'gt', value: 5 }],
        },
      }),
    );

    expect(screen.getByRole('textbox', { name: 'Field' })).toHaveValue('total');
    expect(screen.getByRole('textbox', { name: 'Field' })).not.toBe(before);
  });
});

describe('ProjectStageForm', () => {
  it('switches a row to exclude', () => {
    const onChange = vi.fn<(body: ProjectBody) => void>();
    renderWithApp(
      <Harness
        initial={project}
        onChange={onChange}
        render={(body, set) => <ProjectStageForm body={body} fields={fields} onChange={set} />}
      />,
    );

    fireEvent.click(screen.getAllByRole('radio', { name: 'Exclude' })[0] as HTMLElement);

    expect(onChange).toHaveBeenLastCalledWith({
      stage: '$project',
      rows: [{ kind: 'field', enabled: true, field: 'name', include: false }, project.rows[1]],
    });
  });

  it('renames a row and disables it', () => {
    const onChange = vi.fn<(body: ProjectBody) => void>();
    renderWithApp(
      <Harness
        initial={project}
        onChange={onChange}
        render={(body, set) => <ProjectStageForm body={body} fields={fields} onChange={set} />}
      />,
    );

    fireEvent.change(
      screen.getAllByRole('textbox', { name: 'Projection field' })[1] as HTMLElement,
      {
        target: { value: 'name' },
      },
    );
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Enable row' })[1] as HTMLElement);

    expect(onChange.mock.lastCall?.[0].rows[1]).toEqual({
      kind: 'field',
      enabled: false,
      field: 'name',
      include: false,
    });
  });
});

describe('SortStageForm', () => {
  it('changes the direction of a sort row', () => {
    const onChange = vi.fn<(body: SortBody) => void>();
    renderWithApp(
      <Harness
        initial={sort}
        onChange={onChange}
        render={(body, set) => <SortStageForm body={body} fields={fields} onChange={set} />}
      />,
    );

    fireEvent.click(screen.getAllByRole('radio', { name: 'Descending' })[0] as HTMLElement);

    expect(onChange).toHaveBeenLastCalledWith({
      stage: '$sort',
      rows: [{ enabled: true, field: 'name', direction: -1 }, sort.rows[1]],
    });
  });

  it('changes the field of a sort row and removes a row', () => {
    const onChange = vi.fn<(body: SortBody) => void>();
    renderWithApp(
      <Harness
        initial={sort}
        onChange={onChange}
        render={(body, set) => <SortStageForm body={body} fields={fields} onChange={set} />}
      />,
    );

    fireEvent.change(screen.getAllByRole('textbox', { name: 'Sort field' })[0] as HTMLElement, {
      target: { value: 'total' },
    });
    expect(onChange.mock.lastCall?.[0].rows[0]).toMatchObject({ field: 'total', direction: 1 });

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove row' })[0] as HTMLElement);
    expect(onChange.mock.lastCall?.[0].rows).toEqual([sort.rows[1]]);
  });
});

describe('stage forms when the parent re-wraps the body', () => {
  it('MatchStageForm keeps the condition box mounted and focused while typing', () => {
    renderWithApp(
      <Harness
        initial={match}
        onChange={() => undefined}
        wrap={withEnabled}
        render={(body, set) => <MatchStageForm body={body} fields={fields} onChange={set} />}
      />,
    );

    typeKeepingFocus('Field', ['t', 'to', 'tot', 'tota', 'total']);
  });

  it('ProjectStageForm keeps the row box mounted and focused while typing', () => {
    renderWithApp(
      <Harness
        initial={project}
        onChange={() => undefined}
        wrap={withEnabled}
        render={(body, set) => <ProjectStageForm body={body} fields={fields} onChange={set} />}
      />,
    );

    typeKeepingFocus('Projection field', ['n', 'na', 'nam', 'name']);
  });

  it('SortStageForm keeps the row box mounted and focused while typing', () => {
    renderWithApp(
      <Harness
        initial={sort}
        onChange={() => undefined}
        wrap={withEnabled}
        render={(body, set) => <SortStageForm body={body} fields={fields} onChange={set} />}
      />,
    );

    typeKeepingFocus('Sort field', ['t', 'to', 'tot', 'tota', 'total']);
  });
});
