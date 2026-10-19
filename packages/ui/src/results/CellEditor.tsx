import { Text } from '@mantine/core';
import { useGridCellEditor, type CustomCellEditorProps } from 'ag-grid-react';
import { useRef, useState } from 'react';
import { errorText } from '../kit/notify-error';
import { editTextOf, editTypeOf, valueFromEdit, type JsonObject } from './result-model';

/** One grid row: a loaded document and its position in the result. */
export interface Row {
  readonly index: number;
  readonly doc: JsonObject;
}

export interface CellEditorParams {
  readonly onSetField: (edit: {
    readonly documentIndex: number;
    readonly path: string;
    readonly value: unknown;
  }) => Promise<void>;
}

/** A key that starts an edit with its own character, as in a spreadsheet. */
function typedCharacter(eventKey: string | null): string | undefined {
  return eventKey !== null && eventKey.length === 1 ? eventKey : undefined;
}

/**
 * Edits one scalar cell as text. Enter or leaving the cell converts the text to the type the cell
 * has and writes it. The grid never stores the value, because the document lives in the app state
 * and `onSetField` updates it. A text that does not fit the type stays open with the reason.
 */
export function CellEditor(props: CustomCellEditorProps<Row, unknown> & CellEditorParams) {
  const { value, eventKey, data, column, stopEditing, onSetField } = props;
  const type = editTypeOf(value);
  const original = editTextOf(value);
  const [text, setText] = useState(typedCharacter(eventKey) ?? original);
  const [error, setError] = useState<string | undefined>(undefined);
  const finished = useRef(false);
  const busy = useRef(false);

  useGridCellEditor({ isCancelAfterEnd: () => true });

  function cancel(): void {
    finished.current = true;
    stopEditing(true);
  }

  async function commit(onBlur: boolean): Promise<void> {
    if (finished.current || busy.current) {
      return;
    }
    if (type === undefined || data === undefined || text === original) {
      cancel();
      return;
    }
    const converted = valueFromEdit(type, text);
    if (!converted.ok) {
      if (onBlur) {
        cancel();
      } else {
        setError(converted.message);
      }
      return;
    }
    busy.current = true;
    try {
      await onSetField({
        documentIndex: data.index,
        path: column.getColId(),
        value: converted.value,
      });
      cancel();
    } catch (failure) {
      if (onBlur) {
        cancel();
      } else {
        setError(errorText(failure));
      }
    } finally {
      busy.current = false;
    }
  }

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <input
        autoFocus
        aria-label={`Edit ${column.getColId()}`}
        aria-invalid={error !== undefined}
        value={text}
        style={{ width: '100%', height: '100%', font: 'inherit', padding: '0 8px' }}
        onFocus={(event) => {
          if (typedCharacter(eventKey) === undefined) {
            event.currentTarget.select();
          }
        }}
        onChange={(event) => {
          setText(event.currentTarget.value);
          setError(undefined);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.stopPropagation();
            void commit(false);
          } else if (event.key === 'Escape') {
            event.stopPropagation();
            cancel();
          }
        }}
        onBlur={() => void commit(true)}
      />
      {error === undefined ? null : (
        <Text
          size="xs"
          c="red"
          role="alert"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 10,
            padding: '2px 8px',
            background: 'var(--mantine-color-body)',
            border: '1px solid var(--mantine-color-red-6)',
          }}
        >
          {error}
        </Text>
      )}
    </div>
  );
}
