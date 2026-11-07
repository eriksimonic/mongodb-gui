// @vitest-environment jsdom
import type { TextRange } from '@mongo-gui/core';
import { act, fireEvent, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../test-support/render';
import { BuilderPanel } from './BuilderPanel';

const TEXT_NOTICE = 'Disabled items were cleared because the text changed.';
const MOVE_NOTICE = 'Disabled items were cleared because you moved to another statement.';
const fieldSource = {
  fieldsOf: () => Promise.resolve([{ path: 'status', types: ['String'], presence: 1 }]),
};

/** Set by the harness after it renders, so a test can change the text or cursor from outside. */
interface Control {
  setText?: (text: string) => void;
  setCursor?: (cursor: number) => void;
}

interface HarnessProps {
  readonly initial: string;
  readonly initialCursor?: number;
  readonly onReady: (handles: Control) => void;
  readonly onReplace: (range: TextRange, replacement: string) => void;
  /** False keeps the text as it was, so a test can send the parent's text later. */
  readonly applyEdits?: boolean;
  readonly defaultCollection?: string;
  readonly onRun?: (() => void) | undefined;
}

const attach = (control: Control) => (handles: Control) => Object.assign(control, handles);

/** Holds the text as the editor does. A write-back replaces the range, as Monaco does. */
function Harness({
  initial,
  initialCursor = 0,
  onReady,
  onReplace,
  applyEdits = true,
  defaultCollection = 'orders',
  onRun,
}: HarnessProps) {
  const [text, setText] = useState(initial);
  const [cursor, setCursor] = useState(initialCursor);
  useEffect(() => {
    onReady({ setText, setCursor });
  }, [onReady]);
  return (
    <BuilderPanel
      text={text}
      cursor={cursor}
      onReplace={(range, replacement) => {
        onReplace(range, replacement);
        if (applyEdits) {
          setText(
            (current) => current.slice(0, range.start) + replacement + current.slice(range.end),
          );
        }
      }}
      connectionId="conn-1"
      database="shop"
      source={fieldSource}
      defaultCollection={defaultCollection}
      onRun={onRun}
    />
  );
}

/** Renders the harness and returns its handles and the spy of the write-back calls. */
function mount(
  initial: string,
  extra: Partial<Omit<HarnessProps, 'initial' | 'onReady' | 'onReplace'>> = {},
) {
  const control: Control = {};
  const onReplace = vi.fn();
  renderWithApp(
    <Harness initial={initial} onReady={attach(control)} onReplace={onReplace} {...extra} />,
  );
  return { control, onReplace };
}

/** The range and text of the n-th write-back call. */
function writeAt(onReplace: ReturnType<typeof vi.fn>, n = 0): [TextRange, string] {
  return onReplace.mock.calls[n] as [TextRange, string];
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('BuilderPanel', () => {
  it('writes a find edit through the callback and keeps the form mounted', () => {
    const text = 'db.orders.find({ status: "open" })';
    const { onReplace } = mount(text);
    const limit = screen.getByLabelText('Limit');

    fireEvent.change(limit, { target: { value: '5' } });

    expect(onReplace).toHaveBeenCalledTimes(1);
    const [range, replacement] = writeAt(onReplace);
    expect(range).toEqual({ start: 0, end: text.length });
    expect(replacement).toContain('.limit(5)');
    expect(replacement).toContain('status');
    expect(screen.getByLabelText('Limit')).toBe(limit);
  });

  it('shows an unsupported statement read-only with its reason', () => {
    mount('db.orders.find({ status: open })');

    expect(
      screen.getByText('The builder cannot show this statement. Edit the text.'),
    ).toBeVisible();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByLabelText('Limit')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New find' })).toBeNull();
  });

  it('inserts a find template at the cursor', () => {
    const { onReplace } = mount('', { defaultCollection: 'orders' });

    fireEvent.click(screen.getByRole('button', { name: 'New find' }));

    expect(onReplace).toHaveBeenCalledTimes(1);
    const [range, replacement] = writeAt(onReplace);
    expect(range).toEqual({ start: 0, end: 0 });
    expect(replacement).toContain('db.orders.find(');
    expect(screen.getByLabelText('Enable query')).toBeChecked();
  });

  it('inserts an aggregate template at the cursor', () => {
    const { onReplace } = mount('', { defaultCollection: 'orders' });

    fireEvent.click(screen.getByRole('button', { name: 'New aggregate' }));

    const [, replacement] = writeAt(onReplace);
    expect(replacement).toContain('db.orders.aggregate(');
    expect(screen.getByText('The pipeline has no stages.')).toBeVisible();
  });

  it('names the template collection collection when defaultCollection is empty', () => {
    const { onReplace } = mount('', { defaultCollection: '' });

    fireEvent.click(screen.getByRole('button', { name: 'New find' }));
    expect(writeAt(onReplace, 0)[1]).toContain('db.collection.find(');
  });

  it('shows no Run button when onRun is not passed', () => {
    mount('db.orders.find({})');
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
  });

  it('calls onRun from the Run button', () => {
    const onRun = vi.fn();
    mount('db.orders.find({})', { onRun });

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('writes an aggregate edit through StageList and deletes a stage', () => {
    const { onReplace } = mount('db.orders.aggregate([{ $limit: 5 }])');

    fireEvent.change(screen.getByLabelText('Count'), { target: { value: '9' } });
    expect(writeAt(onReplace, 0)[1]).toContain('$limit: 9');

    fireEvent.click(screen.getByLabelText('Delete stage'));
    expect(writeAt(onReplace, 1)[1]).toBe('db.orders.aggregate([])');
    expect(screen.getByText('The pipeline has no stages.')).toBeVisible();
  });

  it('keeps the trailing semicolon and the range arithmetic across two statements', () => {
    const { control, onReplace } = mount('db.a.find({}).limit(1);\ndb.b.find({}).limit(7)');

    fireEvent.change(screen.getByLabelText('Limit'), { target: { value: '55' } });
    // The first range includes the `;`, so the replacement ends with one. The emitter writes
    // an empty filter as `find()`.
    expect(writeAt(onReplace, 0)).toEqual([{ start: 0, end: 23 }, 'db.a.find().limit(55);']);

    // The first statement is now 22 characters, so the second starts at 23.
    act(() => control.setCursor?.(30));
    expect(screen.getByLabelText('Limit')).toHaveDisplayValue('7');
    fireEvent.change(screen.getByLabelText('Limit'), { target: { value: '8' } });
    expect(writeAt(onReplace, 1)).toEqual([{ start: 23, end: 45 }, 'db.b.find().limit(8)']);

    // The first range moved with the write-back: it now runs from 0 to 22.
    act(() => control.setCursor?.(5));
    fireEvent.change(screen.getByLabelText('Limit'), { target: { value: '9' } });
    expect(writeAt(onReplace, 2)).toEqual([{ start: 0, end: 22 }, 'db.a.find().limit(9);']);
  });

  it('ignores an incoming text that equals its own write-back', () => {
    vi.useFakeTimers();
    try {
      const { control, onReplace } = mount('db.orders.find({}, { status: 1 })', {
        applyEdits: false,
      });
      fireEvent.click(screen.getByLabelText('Enable projection'));
      const [, written] = writeAt(onReplace);

      advance(100);
      act(() => control.setText?.(written));
      advance(1000);

      expect(screen.getByLabelText('Enable projection')).not.toBeChecked();
      expect(screen.queryByText(TEXT_NOTICE)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('keeps a disabled item after its own write-back', () => {
      const { onReplace } = mount('db.orders.find({}, { status: 1 })');
      expect(screen.getByLabelText('Enable projection')).toBeChecked();

      fireEvent.click(screen.getByLabelText('Enable projection'));
      expect(onReplace).toHaveBeenCalledTimes(1);
      const [, replacement] = writeAt(onReplace);
      expect(replacement).not.toContain('status');

      advance(1000);
      expect(screen.getByLabelText('Enable projection')).not.toBeChecked();
      expect(screen.queryByText(TEXT_NOTICE)).toBeNull();
    });

    it('clears disabled items after an outside change, shows the notice and remounts the form', () => {
      const { control } = mount('db.orders.find({}, { status: 1 })');
      fireEvent.click(screen.getByLabelText('Enable projection'));
      const before = screen.getByLabelText('Enable projection');
      expect(before).not.toBeChecked();

      act(() => control.setText?.('db.orders.find({ status: "x" })'));
      advance(299);
      expect(screen.getByLabelText('Enable projection')).toBe(before);
      expect(screen.queryByText(TEXT_NOTICE)).toBeNull();

      advance(1);
      const after = screen.getByLabelText('Enable projection');
      expect(after).not.toBe(before);
      expect(after).toBeChecked();
      expect(screen.getByText(TEXT_NOTICE)).toBeVisible();
    });

    it.each([
      [
        'a disabled Query panel',
        'db.orders.find({ status: "open" })',
        'Enable query',
        'db.orders.find({ status: "x" })',
      ],
      [
        'a disabled Projection panel',
        'db.orders.find({}, { status: 1 })',
        'Enable projection',
        'db.orders.find({ status: "x" })',
      ],
      [
        'a disabled Sort panel',
        'db.orders.find({}).sort({ status: 1 })',
        'Enable sort',
        'db.orders.find({ status: "x" })',
      ],
      [
        'a disabled sort row',
        'db.orders.find({}).sort({ status: 1 })',
        'Enable row',
        'db.orders.find({ status: "x" })',
      ],
      [
        'a disabled stage',
        'db.orders.aggregate([{ $limit: 5 }])',
        'Enable stage',
        'db.orders.aggregate([{ $skip: 2 }])',
      ],
    ])('shows the notice when an outside change clears %s', (_name, initial, checkbox, outside) => {
      const { control } = mount(initial);
      fireEvent.click(screen.getByLabelText(checkbox));

      act(() => control.setText?.(outside));
      advance(300);

      expect(screen.getByText(TEXT_NOTICE)).toBeVisible();
    });

    it('shows the notice when an outside change clears an unfinished stage', () => {
      const { control } = mount('db.orders.aggregate([])');
      fireEvent.click(screen.getByRole('button', { name: 'Add stage' }));
      fireEvent.click(screen.getByRole('menuitem', { name: '$unwind' }));

      act(() => control.setText?.('db.orders.aggregate([{ $skip: 2 }])'));
      advance(300);

      expect(screen.getByText(TEXT_NOTICE)).toBeVisible();
    });

    it('shows no notice when an outside change clears nothing', () => {
      const { control } = mount('db.orders.find({ status: "open" }).limit(1)');

      act(() => control.setText?.('db.orders.find({ status: "x" })'));
      advance(300);

      expect(screen.getByLabelText('Limit')).toHaveDisplayValue('');
      expect(screen.queryByText(TEXT_NOTICE)).toBeNull();
    });

    it('restarts the 300 ms wait on each outside change', () => {
      const { control } = mount('db.orders.find({}).limit(1)');

      act(() => control.setText?.('db.orders.find({}).limit(2)'));
      advance(200);
      act(() => control.setText?.('db.orders.find({}).limit(3)'));
      advance(299);
      expect(screen.getByLabelText('Limit')).toHaveDisplayValue('1');

      advance(1);
      expect(screen.getByLabelText('Limit')).toHaveDisplayValue('3');
    });

    it('uses the latest cursor and text when the cursor moves while an outside change waits', () => {
      const { control } = mount('db.a.find({}).limit(1);\ndb.b.find({}).limit(7)');

      act(() => control.setText?.('db.a.find({}).limit(2);\ndb.b.find({}).limit(9)'));
      advance(100);
      act(() => control.setCursor?.(30));
      advance(299);
      expect(screen.getByLabelText('Limit')).toHaveDisplayValue('1');

      advance(1);
      expect(screen.getByLabelText('Limit')).toHaveDisplayValue('9');
      expect(screen.queryByText(MOVE_NOTICE)).toBeNull();
    });

    it('switches to the statement under the cursor when the cursor moves to another one', () => {
      const { control } = mount('db.a.find({}).limit(1);\ndb.b.find({}).limit(7)');
      expect(screen.getByLabelText('Limit')).toHaveDisplayValue('1');

      act(() => control.setCursor?.(30));

      expect(screen.getByLabelText('Limit')).toHaveDisplayValue('7');
    });

    it('keeps dropped items when the cursor moves inside the statement', () => {
      const { control } = mount('db.orders.find({}, { status: 1 })');
      fireEvent.click(screen.getByLabelText('Enable projection'));

      act(() => control.setCursor?.(10));

      expect(screen.getByLabelText('Enable projection')).not.toBeChecked();
      expect(screen.queryByText(MOVE_NOTICE)).toBeNull();
    });

    it('clears dropped items when the cursor moves away, shows the notice, and loses them on the way back', () => {
      const { control } = mount('db.a.find({}, { status: 1 });\ndb.b.find({})');
      fireEvent.click(screen.getByLabelText('Enable projection'));

      act(() => control.setCursor?.(20));
      expect(screen.getByText(MOVE_NOTICE)).toBeVisible();
      expect(screen.queryByText(TEXT_NOTICE)).toBeNull();
      expect(screen.getByLabelText('Enable projection')).toBeChecked();

      act(() => control.setCursor?.(2));
      expect(screen.getByLabelText('Enable projection')).toBeChecked();
      expect(screen.queryByText(MOVE_NOTICE)).toBeNull();
    });

    it('shows no notice when the cursor moves to another statement and nothing is dropped', () => {
      const { control } = mount('db.a.find({ status: "open" });\ndb.b.find({})');

      act(() => control.setCursor?.(35));

      expect(screen.getByLabelText('Enable query')).toBeChecked();
      expect(screen.queryByText(MOVE_NOTICE)).toBeNull();
    });
  });
});
