// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import type { FieldInfo } from '@mongo-gui/core';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../../test-support/render';
import { CountStage, LookupStage, RawStage, SkipLimitStage, UnwindStage } from './SimpleStages';

const fields: FieldInfo[] = [
  { path: 'name', types: ['String'] },
  { path: 'items', types: ['Array'] },
];

describe('SkipLimitStage', () => {
  it('reports each number typed in the count box', () => {
    const onChange = vi.fn();
    renderWithApp(
      <SkipLimitStage body={{ stage: '$limit', count: 5 }} fields={fields} onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText('Count'), { target: { value: '25' } });
    expect(onChange).toHaveBeenLastCalledWith({ stage: '$limit', count: 25 });
  });

  it('keeps the stage kind when the body is $skip', () => {
    const onChange = vi.fn();
    renderWithApp(
      <SkipLimitStage body={{ stage: '$skip', count: 0 }} fields={fields} onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText('Count'), { target: { value: '3' } });
    expect(onChange).toHaveBeenLastCalledWith({ stage: '$skip', count: 3 });
  });

  it('reports nothing for an empty count box', () => {
    const onChange = vi.fn();
    renderWithApp(
      <SkipLimitStage body={{ stage: '$skip', count: 4 }} fields={fields} onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText('Count'), { target: { value: '' } });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('CountStage', () => {
  it('reports the output field name', () => {
    const onChange = vi.fn();
    renderWithApp(
      <CountStage
        body={{ stage: '$count', output: 'count' }}
        fields={fields}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('Output field'), { target: { value: 'total' } });
    expect(onChange).toHaveBeenLastCalledWith({ stage: '$count', output: 'total' });
  });
});

describe('UnwindStage', () => {
  it('reports the path without a leading $', () => {
    const onChange = vi.fn();
    renderWithApp(
      <UnwindStage
        body={{ stage: '$unwind', path: 'items', preserveEmpty: false }}
        fields={fields}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Array path' }), {
      target: { value: '$name' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      stage: '$unwind',
      path: 'name',
      preserveEmpty: false,
    });
  });

  it('reports the keep-empty switch', () => {
    const onChange = vi.fn();
    renderWithApp(
      <UnwindStage
        body={{ stage: '$unwind', path: 'items', preserveEmpty: false }}
        fields={fields}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText('Keep documents with an empty or missing array'));
    expect(onChange).toHaveBeenLastCalledWith({
      stage: '$unwind',
      path: 'items',
      preserveEmpty: true,
    });
  });
});

describe('LookupStage', () => {
  it('reports each of the four fields', () => {
    const onChange = vi.fn();
    const body = {
      stage: '$lookup' as const,
      from: 'orders',
      localField: 'id',
      foreignField: 'shopId',
      as: 'orders',
    };
    renderWithApp(<LookupStage body={body} fields={fields} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('From collection'), { target: { value: 'users' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...body, from: 'users' });

    fireEvent.change(screen.getByLabelText('Local field'), { target: { value: '_id' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...body, localField: '_id' });

    fireEvent.change(screen.getByLabelText('Foreign field'), { target: { value: 'userId' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...body, foreignField: 'userId' });

    fireEvent.change(screen.getByLabelText('Output array field'), { target: { value: 'user' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...body, as: 'user' });
  });
});

describe('RawStage', () => {
  const body = { stage: 'raw' as const, name: '$addFields', value: { a: 1 } };

  /** Types `text` in the raw box and leaves it, so the box commits. */
  function typeAndLeave(text: string): void {
    const input = screen.getByLabelText('Raw stage text');
    fireEvent.change(input, { target: { value: text } });
    fireEvent.blur(input);
  }

  it('reports the name and value of one key', () => {
    const onChange = vi.fn();
    renderWithApp(
      <RawStage
        body={body}
        fields={fields}
        onChange={onChange}
        reservedNames={['$limit', '$sort']}
      />,
    );
    typeAndLeave('{ $replaceRoot: { newRoot: "$name" } }');
    expect(onChange).toHaveBeenLastCalledWith({
      stage: 'raw',
      name: '$replaceRoot',
      value: { newRoot: '$name' },
    });
  });

  it('refuses a name that has its own form and keeps the stored stage', () => {
    const onChange = vi.fn();
    renderWithApp(
      <RawStage
        body={body}
        fields={fields}
        onChange={onChange}
        reservedNames={['$limit', '$sort']}
      />,
    );
    typeAndLeave('{ $limit: 5 }');
    expect(
      screen.getByText('$limit has its own form. Use the $limit stage instead of a raw stage.'),
    ).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('refuses two keys and a name without $', () => {
    const onChange = vi.fn();
    renderWithApp(
      <RawStage
        body={body}
        fields={fields}
        onChange={onChange}
        reservedNames={['$limit', '$sort']}
      />,
    );
    typeAndLeave('{ $addFields: {}, $project: {} }');
    expect(screen.getByText('Write one key, such as { $addFields: { ... } }')).toBeInTheDocument();
    typeAndLeave('{ addFields: {} }');
    expect(screen.getByText('A stage name starts with $')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
