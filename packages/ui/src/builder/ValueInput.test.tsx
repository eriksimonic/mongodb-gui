// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../test-support/render';
import { ValueInput } from './ValueInput';
import type { ValueType } from './value-types';

const VALID_OBJECT_ID = '64b7f1e2c3d4a5b6c7d8e9f0';

function renderValue(type: ValueType, value: unknown) {
  const onChange = vi.fn();
  renderWithApp(<ValueInput type={type} value={value} onChange={onChange} />);
  return { onChange, input: screen.getByRole('textbox', { name: 'Value' }) };
}

function chooseType(name: string): void {
  fireEvent.click(screen.getByRole('button', { name: 'Value type' }));
  fireEvent.click(screen.getByRole('menuitem', { name }));
}

describe('ValueInput', () => {
  it('shows the starting value as text', () => {
    const { input, onChange } = renderValue('String', 'shop');

    expect(input).toHaveValue('shop');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the text when the type changes and marks it red until it reads as the new type', () => {
    const { onChange, input } = renderValue('String', 'abc');

    chooseType('Number');
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Enter a number')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '12' } });
    expect(onChange).toHaveBeenLastCalledWith(12);
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  it('marks a bad ObjectId red and writes the valid one', () => {
    const { onChange, input } = renderValue('ObjectId', { $oid: VALID_OBJECT_ID });

    fireEvent.change(input, { target: { value: 'xyz' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('An ObjectId has 24 hex characters')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: VALID_OBJECT_ID } });
    expect(onChange).toHaveBeenLastCalledWith({ $oid: VALID_OBJECT_ID });
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  it('uses a date-time input for Date and writes the EJSON date', () => {
    const { onChange, input } = renderValue('String', 'x');

    chooseType('Date');
    expect(input).toHaveAttribute('type', 'datetime-local');
    expect(input).toHaveValue('');

    fireEvent.change(input, { target: { value: '2026-01-01T10:00' } });
    expect(onChange).toHaveBeenLastCalledWith({
      $date: new Date(2026, 0, 1, 10, 0).toISOString(),
    });
  });

  it('writes a Boolean from the true and false choice', () => {
    const onChange = vi.fn();
    renderWithApp(<ValueInput type="Boolean" value={true} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText('false'));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('writes a Null as null when the type changes to Null', () => {
    const { onChange } = renderValue('String', 'x');

    chooseType('Null');
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByText('null')).toBeInTheDocument();
  });

  it('reads a regex as /pattern/flags and rejects an unknown flag', () => {
    const { onChange, input } = renderValue('Regex', {
      $regularExpression: { pattern: '^a', options: 'i' },
    });
    expect(input).toHaveValue('/^a/i');

    fireEvent.change(input, { target: { value: '/b/x' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(input).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(input, { target: { value: '/b/m' } });
    expect(onChange).toHaveBeenLastCalledWith({
      $regularExpression: { pattern: 'b', options: 'm' },
    });
  });

  it('writes a List only when the text is a JSON array', () => {
    const { onChange, input } = renderValue('List', [1]);
    expect(input).toHaveValue('[1]');

    fireEvent.change(input, { target: { value: '[1,' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);

    fireEvent.change(input, { target: { value: '[1, "a"]' } });
    expect(onChange).toHaveBeenLastCalledWith([1, 'a']);
  });

  it('shows the starting Boolean as the checked choice', () => {
    renderWithApp(<ValueInput type="Boolean" value={false} onChange={vi.fn()} />);

    expect(screen.getByLabelText('false')).toBeChecked();
    expect(screen.getByLabelText('true')).not.toBeChecked();
  });

  it('changes a Number to a Boolean and writes true for the number text', () => {
    const onChange = vi.fn();
    renderWithApp(<ValueInput type="Number" value={12} onChange={onChange} />);

    chooseType('Boolean');
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByLabelText('true')).toBeChecked();
  });

  it('shows the starting Date with its seconds and milliseconds', () => {
    renderWithApp(
      <ValueInput type="Date" value={{ $date: '2026-01-01T10:00:30.500Z' }} onChange={vi.fn()} />,
    );

    // The input normalises the text: a fraction of .500 shows as .5.
    const input = screen.getByLabelText<HTMLInputElement>('Value');
    expect(input.value).toMatch(/T\d{2}:\d{2}:30\.5$/);
    expect(input).toHaveAttribute('step', '0.001');
  });

  it('uses a step of one second for a Date without milliseconds', () => {
    renderWithApp(
      <ValueInput type="Date" value={{ $date: '2026-01-01T10:00:30.000Z' }} onChange={vi.fn()} />,
    );

    const input = screen.getByLabelText<HTMLInputElement>('Value');
    expect(input.value).toMatch(/T\d{2}:\d{2}:30$/);
    expect(input).toHaveAttribute('step', '1');
  });

  it('keeps the seconds and milliseconds of a Date when the day is edited', () => {
    const onChange = vi.fn();
    renderWithApp(
      <ValueInput type="Date" value={{ $date: '2026-01-01T10:00:30.500Z' }} onChange={onChange} />,
    );
    const input = screen.getByLabelText<HTMLInputElement>('Value');
    const edited = input.value.replace(/^\d{4}-\d{2}-\d{2}/, '2026-01-02');

    fireEvent.change(input, { target: { value: edited } });

    expect(edited).toMatch(/:30\.5$/);
    expect(onChange).toHaveBeenLastCalledWith({
      $date: new Date(edited).toISOString(),
    });
    expect(onChange).toHaveBeenLastCalledWith({ $date: expect.stringMatching(/:30\.500Z$/) });
  });

  it('reports the type the user picks, and not the starting type', () => {
    const onTypeChange = vi.fn();
    renderWithApp(
      <ValueInput type="String" value="x" onChange={vi.fn()} onTypeChange={onTypeChange} />,
    );
    expect(onTypeChange).not.toHaveBeenCalled();

    chooseType('Regex');
    expect(onTypeChange).toHaveBeenCalledTimes(1);
    expect(onTypeChange).toHaveBeenCalledWith('Regex');
  });
});
