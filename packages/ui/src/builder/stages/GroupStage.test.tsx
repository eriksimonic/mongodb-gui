// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import type { AccumulatorRow, FieldInfo } from '@mongo-gui/core';
import { type ReactNode, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoot } from '../../AppRoot';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { renderWithApp } from '../../test-support/render';
import { mongoshText } from '../condition-model';
import { type GroupBody, GroupStageForm } from './GroupStage';

const fields: FieldInfo[] = [{ path: 'category', types: ['String'] }];

const totalRow: AccumulatorRow = { output: 'total', accumulator: '$sum', expression: '$price' };
const namesRow: AccumulatorRow = { output: 'names', accumulator: '$push', expression: '$name' };

const group: GroupBody = {
  stage: '$group',
  id: '$category',
  accumulators: [totalRow, namesRow],
};

/**
 * Keeps the body in state and reports every change. `wrap` stores the body the way the stage list
 * does, with extra fields, so the form sees a new object after every change.
 */
function Harness({
  initial,
  onChange,
  wrap = (next: GroupBody) => next,
}: {
  readonly initial: GroupBody;
  readonly onChange: (body: GroupBody) => void;
  readonly wrap?: ((next: GroupBody) => GroupBody) | undefined;
}): ReactNode {
  const [body, setBody] = useState(initial);
  return (
    <GroupStageForm
      body={body}
      fields={fields}
      onChange={(next) => {
        setBody(wrap(next));
        onChange(next);
      }}
    />
  );
}

/** The stage list adds `enabled` to a stage. The form must keep its state when that happens. */
function withEnabled(body: GroupBody) {
  return { ...body, enabled: true };
}

function renderGroup(initial: GroupBody = group, wrap?: (next: GroupBody) => GroupBody) {
  const onChange = vi.fn<(body: GroupBody) => void>();
  renderWithApp(<Harness initial={initial} onChange={onChange} wrap={wrap} />);
  return { onChange, lastBody: () => onChange.mock.lastCall?.[0] };
}

function typeInto(name: string, index: number, value: string): void {
  const input = screen.getAllByRole('textbox', { name })[index] as HTMLElement;
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

function outputBox(index: number): HTMLElement {
  return screen.getAllByRole('textbox', { name: 'Output field' })[index] as HTMLElement;
}

describe('GroupStageForm', () => {
  it('sets the _id expression on blur', () => {
    const { lastBody } = renderGroup();

    typeInto('Group by expression', 0, '"$sku"');

    expect(lastBody()).toEqual({ ...group, id: '$sku' });
  });

  it('accepts null as the _id expression', () => {
    const { lastBody } = renderGroup();

    typeInto('Group by expression', 0, 'null');

    expect(lastBody()?.id).toBeNull();
  });

  it('keeps the stored _id and shows the reason for text that does not parse', () => {
    const { onChange } = renderGroup();

    typeInto('Group by expression', 0, '$$ (');

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/syntax error/)).toBeInTheDocument();
  });

  it('adds an accumulator row with a default operator', () => {
    const { lastBody } = renderGroup();

    fireEvent.click(screen.getByRole('button', { name: 'Add accumulator' }));

    expect(lastBody()?.accumulators).toEqual([
      ...group.accumulators,
      { output: '', accumulator: '$sum', expression: null },
    ]);
  });

  it('removes the accumulator row it belongs to', () => {
    const { lastBody } = renderGroup();

    fireEvent.click(
      screen.getAllByRole('button', { name: 'Remove accumulator' })[0] as HTMLElement,
    );

    expect(lastBody()?.accumulators).toEqual([group.accumulators[1]]);
  });

  it('changes the accumulator operator of a row', () => {
    const { lastBody } = renderGroup();

    fireEvent.click(screen.getAllByRole('textbox', { name: 'Accumulator' })[1] as HTMLElement);
    fireEvent.click(screen.getByRole('option', { name: '$avg' }));

    expect(lastBody()?.accumulators[1]).toEqual({
      output: 'names',
      accumulator: '$avg',
      expression: '$name',
    });
  });

  it('renames an output field and keeps the same input element', () => {
    const { lastBody } = renderGroup();
    const input = screen.getAllByRole('textbox', { name: 'Output field' })[0] as HTMLElement;

    fireEvent.change(input, { target: { value: 'sum' } });

    expect(lastBody()?.accumulators[0]).toEqual({ ...group.accumulators[0], output: 'sum' });
    expect(screen.getAllByRole('textbox', { name: 'Output field' })[0]).toBe(input);
  });

  it('sets an accumulator expression from mongosh text', () => {
    const { lastBody } = renderGroup();

    typeInto('Accumulator expression', 0, '{ $multiply: ["$price", "$qty"] }');

    expect(lastBody()?.accumulators[0]?.expression).toEqual({
      $multiply: ['$price', '$qty'],
    });
  });

  it('keeps the stored expression when the accumulator text does not parse', () => {
    const { onChange } = renderGroup();

    typeInto('Accumulator expression', 0, '$price(');

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/syntax error/)).toBeInTheDocument();
  });

  it('shows a body that the parent sets from outside', () => {
    const api = createMockUiApi();
    const view = (body: GroupBody) => (
      <AppRoot api={api}>
        <GroupStageForm body={body} fields={fields} onChange={() => undefined} />
      </AppRoot>
    );
    const { rerender } = render(view(group));
    const before = outputBox(0);

    rerender(view({ ...group, id: '$sku', accumulators: [namesRow] }));

    expect(screen.getByRole('textbox', { name: 'Group by expression' })).toHaveValue(
      mongoshText('$sku'),
    );
    expect(screen.getAllByRole('textbox', { name: 'Output field' })).toHaveLength(1);
    expect(outputBox(0)).not.toBe(before);
  });

  it('keeps the Output box focused while typing when the parent re-wraps the body', () => {
    const { onChange } = renderGroup(group, withEnabled);
    const input = outputBox(0);
    input.focus();

    for (const text of ['tot', 'tota', 'totals', 'totalsX']) {
      fireEvent.change(input, { target: { value: text } });
    }

    expect(outputBox(0)).toBe(input);
    expect(input).toHaveFocus();
    expect(onChange.mock.lastCall?.[0].accumulators[0]?.output).toBe('totalsX');
  });

  it('marks an empty output name as invalid and still writes it', () => {
    const { lastBody } = renderGroup();

    fireEvent.click(screen.getByRole('button', { name: 'Add accumulator' }));

    expect(outputBox(2)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Name the output field.')).toBeInTheDocument();
    expect(outputBox(0)).not.toHaveAttribute('aria-invalid', 'true');
    expect(lastBody()?.accumulators[2]?.output).toBe('');
  });

  it('marks an output name equal to _id as invalid and still writes it', () => {
    const { lastBody } = renderGroup();

    fireEvent.change(outputBox(1), { target: { value: '_id' } });

    expect(outputBox(1)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('_id is the group key.')).toBeInTheDocument();
    expect(lastBody()?.accumulators[1]?.output).toBe('_id');
  });

  it('marks both rows of a duplicate output name as invalid and still writes it', () => {
    const { lastBody } = renderGroup();

    fireEvent.change(outputBox(1), { target: { value: 'total' } });

    expect(outputBox(0)).toHaveAttribute('aria-invalid', 'true');
    expect(outputBox(1)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getAllByText('Another row uses this name.')).toHaveLength(2);
    expect(lastBody()?.accumulators[1]?.output).toBe('total');
  });

  it('clears the mark when the name becomes valid', () => {
    renderGroup();
    fireEvent.change(outputBox(1), { target: { value: 'total' } });

    fireEvent.change(outputBox(1), { target: { value: 'names' } });

    expect(outputBox(0)).not.toHaveAttribute('aria-invalid', 'true');
    expect(outputBox(1)).not.toHaveAttribute('aria-invalid', 'true');
  });
});
