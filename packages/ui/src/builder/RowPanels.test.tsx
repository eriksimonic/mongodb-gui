// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import type { FieldInfo, ProjectionRow, SortRow } from '@mongo-gui/core';
import { describe, expect, it, vi } from 'vitest';
import { AppRoot } from '../AppRoot';
import { createMockUiApi } from '../api/mock-rpc-client';
import { renderWithApp } from '../test-support/render';
import { ProjectionPanel, SkipLimitRow, SortPanel } from './RowPanels';

const fields: FieldInfo[] = [
  { path: 'name', types: ['String'] },
  { path: 'total', types: ['Number'] },
];

const nameProjection: ProjectionRow = {
  kind: 'field',
  enabled: true,
  field: 'name',
  include: true,
};
const totalProjection: ProjectionRow = {
  kind: 'field',
  enabled: true,
  field: 'total',
  include: false,
};
const scoresProjection: ProjectionRow = {
  kind: 'raw',
  enabled: true,
  field: 'scores',
  value: { $slice: 5 },
};
const projection: ProjectionRow[] = [nameProjection, totalProjection, scoresProjection];

const nameSort: SortRow = { enabled: true, field: 'name', direction: 1 };
const totalSort: SortRow = { enabled: true, field: 'total', direction: -1 };
const sort: SortRow[] = [nameSort, totalSort];

/** The element at `index`. The test fails when the list is shorter. */
function nth<T>(items: readonly T[], index: number): T {
  if (index >= items.length) throw new Error(`no item at index ${index}`);
  return items[index] as T;
}

describe('ProjectionPanel', () => {
  it('adds an include row with an empty field', () => {
    const onChange = vi.fn();
    renderWithApp(<ProjectionPanel rows={[]} fields={fields} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));

    expect(onChange).toHaveBeenLastCalledWith([
      { kind: 'field', enabled: true, field: '', include: true },
    ]);
  });

  it('removes the row it belongs to', () => {
    const onChange = vi.fn();
    renderWithApp(<ProjectionPanel rows={projection} fields={fields} onChange={onChange} />);

    fireEvent.click(nth(screen.getAllByRole('button', { name: 'Remove row' }), 1));

    expect(onChange).toHaveBeenLastCalledWith([nameProjection, scoresProjection]);
  });

  it('switches a field row between include and exclude', () => {
    const onChange = vi.fn();
    renderWithApp(<ProjectionPanel rows={projection} fields={fields} onChange={onChange} />);

    fireEvent.click(nth(screen.getAllByRole('radio', { name: 'Exclude' }), 0));

    expect(onChange).toHaveBeenLastCalledWith([
      { ...nameProjection, include: false },
      totalProjection,
      scoresProjection,
    ]);
  });

  it('disables a row without removing it', () => {
    const onChange = vi.fn();
    renderWithApp(<ProjectionPanel rows={projection} fields={fields} onChange={onChange} />);

    fireEvent.click(nth(screen.getAllByRole('checkbox', { name: 'Enable row' }), 1));

    expect(onChange).toHaveBeenLastCalledWith([
      nameProjection,
      { ...totalProjection, enabled: false },
      scoresProjection,
    ]);
  });

  it('shows a raw value as one line of mongosh text', () => {
    renderWithApp(<ProjectionPanel rows={projection} fields={fields} onChange={vi.fn()} />);

    expect(screen.getByRole('textbox', { name: 'Raw value' })).toHaveValue('{$slice: 5}');
  });

  it('shows an ObjectId in mongosh form', () => {
    const id: ProjectionRow = {
      kind: 'raw',
      enabled: true,
      field: 'owner',
      value: { $oid: '64b64f6a2f1e2d3c4b5a6978' },
    };
    renderWithApp(<ProjectionPanel rows={[id]} fields={fields} onChange={vi.fn()} />);

    expect(screen.getByRole('textbox', { name: 'Raw value' })).toHaveValue(
      'ObjectId("64b64f6a2f1e2d3c4b5a6978")',
    );
  });

  it('parses the mongosh text back into the stored value on blur', () => {
    const onChange = vi.fn();
    renderWithApp(<ProjectionPanel rows={projection} fields={fields} onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Raw value' });

    fireEvent.change(input, { target: { value: '{ $slice: 3 }' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);

    expect(onChange).toHaveBeenLastCalledWith([
      nameProjection,
      totalProjection,
      { ...scoresProjection, value: { $slice: 3 } },
    ]);
  });

  it('parses an ObjectId typed as mongosh text', () => {
    const onChange = vi.fn();
    renderWithApp(<ProjectionPanel rows={projection} fields={fields} onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Raw value' });

    fireEvent.change(input, { target: { value: 'ObjectId("64b64f6a2f1e2d3c4b5a6978")' } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenLastCalledWith([
      nameProjection,
      totalProjection,
      { ...scoresProjection, value: { $oid: '64b64f6a2f1e2d3c4b5a6978' } },
    ]);
  });

  it('keeps the stored value and shows red when the text does not parse', () => {
    const onChange = vi.fn();
    renderWithApp(<ProjectionPanel rows={projection} fields={fields} onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Raw value' });

    fireEvent.change(input, { target: { value: '{ $slice: 3' } });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveValue('{ $slice: 3');
  });

  it('refuses an identifier inside the raw text', () => {
    const onChange = vi.fn();
    renderWithApp(<ProjectionPanel rows={projection} fields={fields} onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Raw value' });

    fireEvent.change(input, { target: { value: '{ $slice: limit }' } });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows a stored value that changes while the box is being edited', () => {
    const api = createMockUiApi();
    const view = (rows: readonly ProjectionRow[]) => (
      <AppRoot api={api}>
        <ProjectionPanel rows={rows} fields={fields} onChange={vi.fn()} />
      </AppRoot>
    );
    const { rerender } = render(view(projection));
    fireEvent.change(screen.getByRole('textbox', { name: 'Raw value' }), {
      target: { value: '{ $slice: 3 }' },
    });

    rerender(
      view([nameProjection, totalProjection, { ...scoresProjection, value: { $slice: 9 } }]),
    );

    expect(screen.getByRole('textbox', { name: 'Raw value' })).toHaveValue('{$slice: 9}');
  });

  it('does not show the draft of a raw row on the row that moves into its place', () => {
    const api = createMockUiApi();
    const fiveRow: ProjectionRow = { ...scoresProjection, field: 'five' };
    const sevenRow: ProjectionRow = { ...scoresProjection, field: 'seven', value: { $slice: 7 } };
    const view = (rows: readonly ProjectionRow[]) => (
      <AppRoot api={api}>
        <ProjectionPanel rows={rows} fields={fields} onChange={vi.fn()} />
      </AppRoot>
    );
    const { rerender } = render(view([nameProjection, fiveRow, sevenRow]));
    fireEvent.change(nth(screen.getAllByRole('textbox', { name: 'Raw value' }), 0), {
      target: { value: '{ $slice: 3 }' },
    });

    rerender(view([fiveRow, sevenRow]));

    const boxes = screen.getAllByRole('textbox', { name: 'Raw value' });
    expect(nth(boxes, 0)).toHaveValue('{$slice: 5}');
    expect(nth(boxes, 1)).toHaveValue('{$slice: 7}');
  });
});

describe('SortPanel', () => {
  it('adds an ascending row with an empty field', () => {
    const onChange = vi.fn();
    renderWithApp(<SortPanel rows={sort} fields={fields} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add sort field' }));

    expect(onChange).toHaveBeenLastCalledWith([
      ...sort,
      { enabled: true, field: '', direction: 1 },
    ]);
  });

  it('removes the row it belongs to', () => {
    const onChange = vi.fn();
    renderWithApp(<SortPanel rows={sort} fields={fields} onChange={onChange} />);

    fireEvent.click(nth(screen.getAllByRole('button', { name: 'Remove row' }), 0));

    expect(onChange).toHaveBeenLastCalledWith([totalSort]);
  });

  it('moves a row down and swaps it with the next row', () => {
    const onChange = vi.fn();
    renderWithApp(<SortPanel rows={sort} fields={fields} onChange={onChange} />);

    fireEvent.click(nth(screen.getAllByRole('button', { name: 'Move down' }), 0));

    expect(onChange).toHaveBeenLastCalledWith([totalSort, nameSort]);
  });

  it('moves a row up and swaps it with the previous row', () => {
    const onChange = vi.fn();
    renderWithApp(<SortPanel rows={sort} fields={fields} onChange={onChange} />);

    fireEvent.click(nth(screen.getAllByRole('button', { name: 'Move up' }), 1));

    expect(onChange).toHaveBeenLastCalledWith([totalSort, nameSort]);
  });

  it('disables move up on the first row and move down on the last row', () => {
    renderWithApp(<SortPanel rows={sort} fields={fields} onChange={vi.fn()} />);

    const up = screen.getAllByRole('button', { name: 'Move up' });
    const down = screen.getAllByRole('button', { name: 'Move down' });
    expect(nth(up, 0)).toBeDisabled();
    expect(nth(up, 1)).toBeEnabled();
    expect(nth(down, 0)).toBeEnabled();
    expect(nth(down, 1)).toBeDisabled();
  });

  it('changes the direction of a row', () => {
    const onChange = vi.fn();
    renderWithApp(<SortPanel rows={sort} fields={fields} onChange={onChange} />);

    fireEvent.click(nth(screen.getAllByRole('radio', { name: 'Descending' }), 0));

    expect(onChange).toHaveBeenLastCalledWith([{ ...nameSort, direction: -1 }, totalSort]);
  });

  it('disables a row without removing it', () => {
    const onChange = vi.fn();
    renderWithApp(<SortPanel rows={sort} fields={fields} onChange={onChange} />);

    fireEvent.click(nth(screen.getAllByRole('checkbox', { name: 'Enable row' }), 0));

    expect(onChange).toHaveBeenLastCalledWith([{ ...nameSort, enabled: false }, totalSort]);
  });

  it('writes the typed field name', () => {
    const onChange = vi.fn();
    renderWithApp(<SortPanel rows={sort} fields={fields} onChange={onChange} />);

    fireEvent.change(nth(screen.getAllByRole('textbox', { name: 'Sort field' }), 1), {
      target: { value: 'created' },
    });

    expect(onChange).toHaveBeenLastCalledWith([nameSort, { ...totalSort, field: 'created' }]);
  });
});

describe('SkipLimitRow', () => {
  it('writes a typed skip and keeps the limit', () => {
    const onChange = vi.fn();
    renderWithApp(<SkipLimitRow skip={null} limit={10} onChange={onChange} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Skip' }), { target: { value: '5' } });

    expect(onChange).toHaveBeenLastCalledWith({ skip: 5, limit: 10 });
  });

  it('writes null when a box is cleared', () => {
    const onChange = vi.fn();
    renderWithApp(<SkipLimitRow skip={5} limit={10} onChange={onChange} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Limit' }), { target: { value: '' } });

    expect(onChange).toHaveBeenLastCalledWith({ skip: 5, limit: null });
  });

  it('writes null for a limit of 0', () => {
    const onChange = vi.fn();
    renderWithApp(<SkipLimitRow skip={5} limit={10} onChange={onChange} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Limit' }), { target: { value: '0' } });

    expect(onChange).toHaveBeenLastCalledWith({ skip: 5, limit: null });
  });

  it('writes null for a skip of 0', () => {
    const onChange = vi.fn();
    renderWithApp(<SkipLimitRow skip={5} limit={10} onChange={onChange} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Skip' }), { target: { value: '0' } });

    expect(onChange).toHaveBeenLastCalledWith({ skip: null, limit: 10 });
  });

  it('writes a positive limit', () => {
    const onChange = vi.fn();
    renderWithApp(<SkipLimitRow skip={null} limit={null} onChange={onChange} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Limit' }), { target: { value: '1' } });

    expect(onChange).toHaveBeenLastCalledWith({ skip: null, limit: 1 });
  });
});
