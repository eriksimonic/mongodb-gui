// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import type { FieldInfo, QueryCondition, RawCondition, RawFragment } from '@mongo-gui/core';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../test-support/render';
import { ConditionRow, RawItemRow } from './ConditionRow';

const fields: FieldInfo[] = [
  { path: 'name', types: ['String'] },
  { path: 'price', types: ['Double'] },
];

const price: QueryCondition = {
  kind: 'condition',
  enabled: true,
  field: 'price',
  operator: 'eq',
  value: 5,
};

/** Keeps the row in state, as the group editor does, and reports every change. */
function Harness({
  initial,
  onChange,
}: {
  readonly initial: QueryCondition;
  readonly onChange: (item: QueryCondition) => void;
}) {
  const [item, setItem] = useState(initial);
  return (
    <ConditionRow
      item={item}
      fields={fields}
      onChange={(next) => {
        setItem(next);
        onChange(next);
      }}
      onCopy={vi.fn()}
      onDelete={vi.fn()}
    />
  );
}

function chooseOperator(name: string): void {
  fireEvent.click(screen.getByRole('textbox', { name: 'Operator' }));
  fireEvent.click(screen.getByRole('option', { name }));
}

describe('ConditionRow', () => {
  it('reports a disabled condition through the checkbox', () => {
    const onChange = vi.fn();
    renderWithApp(<Harness initial={price} onChange={onChange} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable condition' }));

    expect(onChange).toHaveBeenLastCalledWith({ ...price, enabled: false });
  });

  it('starts the value again when the operator needs another type', () => {
    const onChange = vi.fn();
    renderWithApp(<Harness initial={price} onChange={onChange} />);

    chooseOperator('exists');

    expect(onChange).toHaveBeenLastCalledWith({ ...price, operator: 'exists', value: true });
    expect(screen.getByLabelText('Boolean value')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Value type' })).toHaveTextContent('Boolean');
  });

  it('writes a regex from the text of a regex row, which has no type menu', () => {
    const onChange = vi.fn();
    const name: QueryCondition = { ...price, field: 'name', value: 'x' };
    renderWithApp(<Harness initial={name} onChange={onChange} />);

    chooseOperator('matches regex');
    expect(screen.queryByRole('button', { name: 'Value type' })).not.toBeInTheDocument();
    const text = screen.getByRole('textbox', { name: 'Regex value' });
    expect(text).toHaveValue('/(?:)/');

    fireEvent.change(text, { target: { value: '/ab/i' } });
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'condition',
      enabled: true,
      field: 'name',
      operator: 'regex',
      pattern: 'ab',
      options: 'i',
    });
  });

  it('keeps the regex when the text is not a regex and shows the reason', () => {
    const onChange = vi.fn();
    const regex: QueryCondition = {
      kind: 'condition',
      enabled: true,
      field: 'name',
      operator: 'regex',
      pattern: 'ab',
      options: '',
    };
    renderWithApp(<Harness initial={regex} onChange={onChange} />);
    const text = screen.getByRole('textbox', { name: 'Regex value' });

    fireEvent.change(text, { target: { value: '5' } });

    expect(onChange).not.toHaveBeenCalled();
    expect(text).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Enter a regex, such as /abc/i')).toBeInTheDocument();
  });

  it('keeps the model value when the typed value is not valid', () => {
    const onChange = vi.fn();
    renderWithApp(<Harness initial={price} onChange={onChange} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Value' }), {
      target: { value: 'abc' },
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Value' })).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows the fixed element field and no field picker in a scalar group', () => {
    renderWithApp(
      <ConditionRow
        item={{ ...price, field: '<Array Element>' }}
        fields={[{ path: '<Array Element>', types: ['String'] }]}
        scalarElement
        takenOperators={['gt']}
        onChange={vi.fn()}
        onCopy={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText('<Array Element>')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Field' })).not.toBeInTheDocument();
  });

  it('disables Copy in a scalar group, where a copy would repeat an operator', () => {
    renderWithApp(
      <ConditionRow
        item={{ ...price, field: '<Array Element>' }}
        fields={[{ path: '<Array Element>', types: ['String'] }]}
        scalarElement
        onChange={vi.fn()}
        onCopy={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Copy condition' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete condition' })).toBeEnabled();
  });

  it('shows a parsed number on an unknown field as Number with the number in the box', () => {
    renderWithApp(<Harness initial={{ ...price, field: 'a', value: 5 }} onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Value type' })).toHaveTextContent('Number');
    expect(screen.getByRole('textbox', { name: 'Value' })).toHaveValue('5');
  });

  it('shows an ObjectId value as ObjectId on a String field', () => {
    const hex = '64b7f1e2c3d4a5b6c7d8e9f0';
    renderWithApp(
      <Harness initial={{ ...price, field: 'name', value: { $oid: hex } }} onChange={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: 'Value type' })).toHaveTextContent('ObjectId');
    expect(screen.getByRole('textbox', { name: 'Value' })).toHaveValue(hex);
  });

  it('disables Copy on a raw item in a scalar group', () => {
    renderWithApp(
      <RawItemRow
        item={{ kind: 'rawFragment', enabled: true, key: '$expr', value: 1 }}
        onChange={vi.fn()}
        onCopy={vi.fn()}
        onDelete={vi.fn()}
        copyDisabled
      />,
    );

    expect(screen.getByRole('button', { name: 'Copy raw item' })).toBeDisabled();
  });
});

describe('RawItemRow', () => {
  const rawCondition: RawCondition = {
    kind: 'rawCondition',
    enabled: true,
    field: 'price',
    operator: '$not',
    value: { $gt: 5 },
  };

  it('shows the operator value as mongosh text and reads the edited text on blur', () => {
    const onChange = vi.fn();
    renderWithApp(
      <RawItemRow item={rawCondition} onChange={onChange} onCopy={vi.fn()} onDelete={vi.fn()} />,
    );
    const text = screen.getByRole('textbox', { name: 'price $not value' });
    expect(text).toHaveValue('{$gt: 5}');

    fireEvent.change(text, { target: { value: '{ $lt: 3 }' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(text);
    expect(onChange).toHaveBeenLastCalledWith({ ...rawCondition, value: { $lt: 3 } });
  });

  it('keeps the old value when the text does not parse, and shows the reason', () => {
    const onChange = vi.fn();
    renderWithApp(
      <RawItemRow item={rawCondition} onChange={onChange} onCopy={vi.fn()} onDelete={vi.fn()} />,
    );
    const text = screen.getByRole('textbox', { name: 'price $not value' });

    fireEvent.change(text, { target: { value: '{ $lt: ' } });
    fireEvent.blur(text);

    expect(onChange).not.toHaveBeenCalled();
    expect(text).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/^syntax error/)).toBeInTheDocument();
  });

  it('shows a raw fragment as its whole object and reads one key back', () => {
    const onChange = vi.fn();
    const fragment: RawFragment = { kind: 'rawFragment', enabled: true, key: '$expr', value: 1 };
    renderWithApp(
      <RawItemRow item={fragment} onChange={onChange} onCopy={vi.fn()} onDelete={vi.fn()} />,
    );
    const text = screen.getByRole('textbox', { name: '$expr value' });
    expect(text).toHaveValue('{$expr: 1}');

    fireEvent.change(text, { target: { value: '{ $where: 2 }' } });
    fireEvent.blur(text);
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'rawFragment',
      enabled: true,
      key: '$where',
      value: 2,
    });
  });

  it('refuses a raw fragment text with two keys and keeps the old key', () => {
    const onChange = vi.fn();
    const fragment: RawFragment = { kind: 'rawFragment', enabled: true, key: '$expr', value: 1 };
    renderWithApp(
      <RawItemRow item={fragment} onChange={onChange} onCopy={vi.fn()} onDelete={vi.fn()} />,
    );
    const text = screen.getByRole('textbox', { name: '$expr value' });

    fireEvent.change(text, { target: { value: '{ $expr: 1, $where: 2 }' } });
    fireEvent.blur(text);

    expect(onChange).not.toHaveBeenCalled();
    expect(text).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Write one key, such as { $expr: ... }')).toBeInTheDocument();
  });
});
