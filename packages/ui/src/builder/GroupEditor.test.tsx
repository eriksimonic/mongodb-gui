// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { ARRAY_ELEMENT_FIELD, type FieldInfo, type QueryGroup } from '@mongo-gui/core';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../test-support/render';
import { GroupEditor } from './GroupEditor';

const fields: FieldInfo[] = [
  { path: 'name', types: ['String'] },
  { path: 'price', types: ['Double'] },
  { path: 'tags', types: ['Array', 'String'] },
  { path: 'items', types: ['Array'] },
  { path: 'items.sku', types: ['String'] },
  { path: 'items.qty', types: ['Int32'] },
];

const empty: QueryGroup = { kind: 'group', operator: 'and', items: [] };

const shop: QueryGroup = {
  kind: 'group',
  operator: 'and',
  items: [{ kind: 'condition', enabled: true, field: 'name', operator: 'eq', value: 'shop' }],
};

/** Keeps the group in state, as the find builder does, and reports every change. */
function Harness({
  initial,
  fields: scope = fields,
  scalarElement,
  onChange,
}: {
  readonly initial: QueryGroup;
  readonly fields?: readonly FieldInfo[];
  readonly scalarElement?: boolean;
  readonly onChange: (group: QueryGroup) => void;
}) {
  const [group, setGroup] = useState(initial);
  return (
    <GroupEditor
      group={group}
      fields={scope}
      scalarElement={scalarElement}
      onChange={(next) => {
        setGroup(next);
        onChange(next);
      }}
    />
  );
}

function renderGroup(initial: QueryGroup, options: Partial<Parameters<typeof Harness>[0]> = {}) {
  const onChange = vi.fn<(group: QueryGroup) => void>();
  renderWithApp(<Harness initial={initial} onChange={onChange} {...options} />);
  const lastGroup = (): QueryGroup | undefined => onChange.mock.lastCall?.[0];
  return { onChange, lastGroup };
}

function chooseOperator(index: number, name: string): void {
  fireEvent.click(screen.getAllByRole('textbox', { name: 'Operator' })[index] as HTMLElement);
  fireEvent.click(screen.getByRole('option', { name }));
}

describe('GroupEditor', () => {
  it('adds a condition with no field, then fills it in', () => {
    const { lastGroup } = renderGroup(empty);

    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));

    expect(lastGroup()?.items).toEqual([
      { kind: 'condition', enabled: true, field: '', operator: 'eq', value: '' },
    ]);
    expect(screen.getByRole('textbox', { name: 'Field' })).toHaveValue('');
  });

  it('copies a condition after itself', () => {
    const { lastGroup } = renderGroup(shop);

    fireEvent.click(screen.getByRole('button', { name: 'Copy condition' }));

    const items = lastGroup()?.items ?? [];
    expect(items).toHaveLength(2);
    expect(items[1]).toEqual(items[0]);
  });

  it('deletes a condition and keeps the others', () => {
    const { lastGroup } = renderGroup({
      ...shop,
      items: [
        ...shop.items,
        { kind: 'condition', enabled: true, field: 'price', operator: 'eq', value: 5 },
      ],
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete condition' })[0] as HTMLElement);

    expect(lastGroup()?.items).toEqual([
      { kind: 'condition', enabled: true, field: 'price', operator: 'eq', value: 5 },
    ]);
  });

  it('disables a condition without removing it', () => {
    const { lastGroup } = renderGroup(shop);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable condition' }));

    expect(lastGroup()?.items).toEqual([{ ...shop.items[0], enabled: false }]);
  });

  it('nests a group and changes its operator', () => {
    const { lastGroup } = renderGroup(empty);

    fireEvent.click(screen.getByRole('button', { name: 'Add group' }));
    expect(lastGroup()?.items).toEqual([{ kind: 'group', operator: 'and', items: [] }]);
    expect(screen.getAllByRole('button', { name: 'Delete group' })).toHaveLength(1);

    fireEvent.click(screen.getAllByRole('textbox', { name: 'Group operator' })[1] as HTMLElement);
    fireEvent.click(screen.getByRole('option', { name: 'NOR' }));
    expect(lastGroup()?.items).toEqual([{ kind: 'group', operator: 'nor', items: [] }]);
  });

  it('edits a raw item as mongosh text and keeps the old value when the text is not valid', () => {
    const raw: QueryGroup = {
      ...empty,
      items: [
        {
          kind: 'rawCondition',
          enabled: true,
          field: 'price',
          operator: '$not',
          value: { $gt: 5 },
        },
      ],
    };
    const { onChange, lastGroup } = renderGroup(raw);
    const text = screen.getByRole('textbox', { name: 'price $not value' });

    fireEvent.change(text, { target: { value: '{ $lt: 3 }' } });
    fireEvent.blur(text);
    expect(lastGroup()?.items[0]).toMatchObject({ value: { $lt: 3 } });

    const calls = onChange.mock.calls.length;
    fireEvent.change(text, { target: { value: '{ $lt: ' } });
    fireEvent.blur(text);
    expect(onChange).toHaveBeenCalledTimes(calls);
    expect(text).toHaveAttribute('aria-invalid', 'true');
  });

  it('remounts the value when the operator changes', () => {
    const price: QueryGroup = {
      ...empty,
      items: [{ kind: 'condition', enabled: true, field: 'price', operator: 'eq', value: 5 }],
    };
    const { lastGroup } = renderGroup(price);

    chooseOperator(0, 'is one of');

    expect(lastGroup()?.items[0]).toMatchObject({ operator: 'in', value: [] });
    expect(screen.getByRole('textbox', { name: 'Value' })).toHaveValue('[]');
  });

  it('does not change the model for a value that is not valid', () => {
    const { onChange } = renderGroup({
      ...empty,
      items: [{ kind: 'condition', enabled: true, field: 'price', operator: 'eq', value: 5 }],
    });

    fireEvent.change(screen.getByRole('textbox', { name: 'Value' }), {
      target: { value: 'abc' },
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Value' })).toHaveAttribute('aria-invalid', 'true');
  });

  it('turns an operator of an array field into an elemMatch group of scalars', () => {
    const { lastGroup } = renderGroup({
      ...empty,
      items: [{ kind: 'condition', enabled: true, field: 'tags', operator: 'eq', value: 'x' }],
    });

    chooseOperator(0, 'has array element matching');

    expect(lastGroup()?.items[0]).toEqual({
      kind: 'condition',
      enabled: true,
      field: 'tags',
      operator: 'elemMatch',
      group: {
        kind: 'group',
        operator: 'and',
        items: [
          {
            kind: 'condition',
            enabled: true,
            field: ARRAY_ELEMENT_FIELD,
            operator: 'eq',
            value: '',
          },
        ],
      },
    });
  });

  it('offers the relative field names inside an elemMatch of an array of objects', () => {
    renderGroup({
      ...empty,
      items: [
        {
          kind: 'condition',
          enabled: true,
          field: 'items',
          operator: 'elemMatch',
          group: { kind: 'group', operator: 'and', items: [] },
        },
      ],
    });

    // The first Add condition belongs to the nested group, which comes before the top group's.
    fireEvent.click(screen.getAllByRole('button', { name: 'Add condition' })[0] as HTMLElement);
    const fieldInputs = screen.getAllByRole('textbox', { name: 'Field' });
    fireEvent.change(fieldInputs[1] as HTMLElement, { target: { value: 'sk' } });

    expect(screen.getByRole('option', { name: 'sku' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'items.sku' })).not.toBeInTheDocument();
  });

  it('limits a scalar elemMatch group to one field, no nested group and no repeated operator', () => {
    const scalar: QueryGroup = {
      ...empty,
      items: [
        {
          kind: 'condition',
          enabled: true,
          field: ARRAY_ELEMENT_FIELD,
          operator: 'eq',
          value: 'a',
        },
      ],
    };
    const { lastGroup } = renderGroup(scalar, {
      scalarElement: true,
      fields: [{ path: ARRAY_ELEMENT_FIELD, types: ['String'] }],
    });

    expect(screen.getByText(ARRAY_ELEMENT_FIELD)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add group' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));

    expect(lastGroup()?.items[1]).toEqual({
      kind: 'condition',
      enabled: true,
      field: ARRAY_ELEMENT_FIELD,
      operator: 'ne',
      value: '',
    });
  });

  it('shows the scalar elemMatch group of an elemMatch on an array of scalars', () => {
    renderGroup({
      ...empty,
      items: [
        {
          kind: 'condition',
          enabled: true,
          field: 'tags',
          operator: 'elemMatch',
          group: {
            kind: 'group',
            operator: 'and',
            items: [
              {
                kind: 'condition',
                enabled: true,
                field: ARRAY_ELEMENT_FIELD,
                operator: 'eq',
                value: 'a',
              },
            ],
          },
        },
      ],
    });

    expect(screen.getByText(ARRAY_ELEMENT_FIELD)).toBeInTheDocument();
    // Only the top group offers a nested group. The elemMatch group of scalars does not.
    expect(screen.getAllByRole('button', { name: 'Add group' })).toHaveLength(1);
  });

  it('hides the group operator menu in a scalar group, which is always AND', () => {
    const scalar: QueryGroup = {
      ...empty,
      items: [
        {
          kind: 'condition',
          enabled: true,
          field: ARRAY_ELEMENT_FIELD,
          operator: 'eq',
          value: 'a',
        },
      ],
    };
    renderGroup(scalar, {
      scalarElement: true,
      fields: [{ path: ARRAY_ELEMENT_FIELD, types: ['String'] }],
    });

    expect(screen.queryByRole('textbox', { name: 'Group operator' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add condition' })).toBeEnabled();
  });

  it('disables Copy on every row of a scalar group', () => {
    const scalar: QueryGroup = {
      ...empty,
      items: [
        {
          kind: 'condition',
          enabled: true,
          field: ARRAY_ELEMENT_FIELD,
          operator: 'eq',
          value: 'a',
        },
      ],
    };
    renderGroup(scalar, {
      scalarElement: true,
      fields: [{ path: ARRAY_ELEMENT_FIELD, types: ['String'] }],
    });

    expect(screen.getByRole('button', { name: 'Copy condition' })).toBeDisabled();
  });

  it('copies a row and keeps the ObjectId value on a String field', () => {
    const hex = '64b7f1e2c3d4a5b6c7d8e9f0';
    const { lastGroup } = renderGroup({
      ...empty,
      items: [
        { kind: 'condition', enabled: true, field: 'name', operator: 'eq', value: { $oid: hex } },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Copy condition' }));

    expect(lastGroup()?.items).toHaveLength(2);
    const types = screen.getAllByRole('button', { name: 'Value type' });
    expect(types).toHaveLength(2);
    for (const type of types) {
      expect(type).toHaveTextContent('ObjectId');
    }
  });
});
