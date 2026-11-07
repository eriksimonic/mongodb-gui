// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import type { FieldInfo } from '@mongo-gui/core';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../test-support/render';
import { FieldPicker } from './FieldPicker';

const fields: FieldInfo[] = [
  { path: 'name', types: ['String'] },
  { path: 'items.sku', types: ['String'] },
];

/** Keeps the value in state, as the builder row does. */
function Harness({ onChange }: { readonly onChange: (field: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <FieldPicker
      fields={fields}
      value={value}
      onChange={(field) => {
        setValue(field);
        onChange(field);
      }}
    />
  );
}

describe('FieldPicker', () => {
  it('picks a field from the suggestions', () => {
    const onChange = vi.fn();
    renderWithApp(<Harness onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Field' });

    fireEvent.change(input, { target: { value: 'items' } });
    fireEvent.click(screen.getByRole('option', { name: 'items.sku' }));

    expect(onChange).toHaveBeenLastCalledWith('items.sku');
    expect(input).toHaveValue('items.sku');
  });

  it('suggests at most 50 fields', () => {
    const many: FieldInfo[] = Array.from({ length: 60 }, (_, index) => ({
      path: `field${index}`,
      types: ['String'],
    }));
    renderWithApp(<FieldPicker fields={many} value="" onChange={vi.fn()} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Field' }), {
      target: { value: 'field' },
    });

    expect(screen.getAllByRole('option')).toHaveLength(50);
  });

  it('accepts a typed name that is not in the list', () => {
    const onChange = vi.fn();
    renderWithApp(<Harness onChange={onChange} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Field' }), {
      target: { value: 'custom.path' },
    });

    expect(onChange).toHaveBeenLastCalledWith('custom.path');
    expect(screen.getByRole('textbox', { name: 'Field' })).toHaveValue('custom.path');
  });
});
