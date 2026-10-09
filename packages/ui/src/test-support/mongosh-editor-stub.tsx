import { useEffect, useRef } from 'react';
import { editorUiEvents } from '../editor/editor-events';
import type { MongoshEditorProps, RunRequest } from '../editor/MongoshEditor';

function requestFrom(element: HTMLTextAreaElement): RunRequest {
  const hasSelection = element.selectionEnd > element.selectionStart;
  return {
    code: element.value,
    cursor: element.selectionStart,
    selection: hasSelection
      ? { start: element.selectionStart, end: element.selectionEnd }
      : undefined,
  };
}

/**
 * Stands in for the Monaco editor in component tests, because Monaco needs a real layout engine.
 * Ctrl+Enter runs the selection or the statement at the cursor, and Ctrl+Shift+Enter runs all, as
 * the Monaco actions do. Insert events land at the selection, as they do in Monaco.
 */
export function MongoshEditor({
  tabId,
  label,
  value,
  onChange,
  onRun,
  onRunAll,
}: MongoshEditorProps) {
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(
    () =>
      editorUiEvents.subscribe((event) => {
        const element = area.current;
        if (event.tabId !== tabId || element === null) {
          return;
        }
        if (event.type === 'editor:command') {
          if (event.command === 'runAll') {
            onRunAll(element.value);
          } else {
            onRun(requestFrom(element));
          }
          return;
        }
        if (event.type !== 'editor:insert') {
          return;
        }
        const next = `${value.slice(0, element.selectionStart)}${event.text}${value.slice(element.selectionEnd)}`;
        onChange(next);
      }),
    [tabId, value, onChange, onRun, onRunAll],
  );
  return (
    <textarea
      ref={area}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) {
          return;
        }
        event.preventDefault();
        const element = event.currentTarget;
        if (event.shiftKey) {
          onRunAll(element.value);
          return;
        }
        onRun(requestFrom(element));
      }}
    />
  );
}
