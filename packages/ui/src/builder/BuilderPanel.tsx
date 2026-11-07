import { Box, Button, Group, Stack, Text } from '@mantine/core';
import {
  type FieldInfo,
  type FindStatement,
  emitBuilderStatement,
  hasDroppedItems,
  parseStatementAt,
  type QueryStatement,
  type TextRange,
} from '@mongo-gui/core';
import { IconPlayerPlay } from '@tabler/icons-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useUiApi } from '../api/ui-api';
import type { CompletionSource } from '../editor/completion-source';
import { getFields } from './field-source';
import { FindBuilder } from './FindBuilder';
import { StageList } from './StageList';

/**
 * Props of the builder panel.
 *
 * Contract for the editor (task U8):
 * - `text` and `cursor` must update in the same render as the `onReplace` call that changed them.
 *   A text that lags behind a write-back makes the panel treat the lag as an outside change.
 * - The cursor must stay inside the replaced range after a write-back. A cursor outside it counts
 *   as a move to another statement, which re-parses and clears dropped items.
 * - An undo in Monaco of a panel edit changes `text` from outside. The panel re-parses it after
 *   300 ms and clears dropped items.
 */
export interface BuilderPanelProps {
  /** The whole editor text. */
  readonly text: string;
  /** The cursor offset in `text`. The panel shows the statement that contains it. */
  readonly cursor: number;
  /** Replaces `range` of the editor text with `replacement`. One call is one undo step. */
  readonly onReplace: (range: TextRange, replacement: string) => void;
  readonly connectionId: string;
  readonly database: string;
  /** The completion source of the editor. The panel reads its field samples and adds no cache. */
  readonly source: Pick<CompletionSource, 'fieldsOf'>;
  /** The collection the "New find" and "New aggregate" templates name. */
  readonly defaultCollection: string;
  /** Runs the statement. The Run button shows in the header only when this is passed. */
  readonly onRun?: (() => void) | undefined;
}

/** What the panel shows for the statement at the cursor. */
type View =
  | { readonly kind: 'empty' }
  | { readonly kind: 'unsupported'; readonly range: TextRange; readonly reason: string }
  | { readonly kind: 'statement'; readonly range: TextRange; readonly statement: QueryStatement };

/** What made a re-parse clear items: a text change from outside, or a cursor move to another statement. */
type ClearReason = 'text' | 'move';

/** The text a view was read from, or written by the panel. The view keeps its disabled items. */
interface Basis {
  readonly text: string;
  readonly view: View;
  /** Changes on every re-parse, so the forms read the statement again. */
  readonly generation: number;
  /** The reason the last re-parse dropped disabled or unfinished items. Null when it dropped none. */
  readonly notice: ClearReason | null;
}

const DEBOUNCE_MS = 300;
const CLEARED_NOTICE: Record<ClearReason, string> = {
  text: 'Disabled items were cleared because the text changed.',
  move: 'Disabled items were cleared because you moved to another statement.',
};
const NO_FIELDS: readonly FieldInfo[] = [];

function viewAt(text: string, offset: number): View {
  const parsed = parseStatementAt(text, offset);
  if (parsed === null) {
    return { kind: 'empty' };
  }
  if ('unsupported' in parsed) {
    return { kind: 'unsupported', range: parsed.range, reason: parsed.unsupported };
  }
  return { kind: 'statement', range: parsed.range, statement: parsed.statement };
}

/** True when the offset is inside the range of a statement view. The range end counts. */
function covers(view: View, offset: number): boolean {
  return view.kind !== 'empty' && offset >= view.range.start && offset <= view.range.end;
}

/** The notice for a re-parse that clears items. The statement the re-parse replaces decides it. */
function clearsItems(view: View): boolean {
  return view.kind === 'statement' && hasDroppedItems(view.statement);
}

function emptyFind(collection: string): FindStatement {
  return {
    kind: 'find',
    collection,
    filter: { kind: 'group', operator: 'and', items: [] },
    projection: [],
    sort: [],
    skip: null,
    limit: null,
  };
}

/**
 * The builder for the find or aggregate statement under the cursor. Every change is written back
 * to the text through `onReplace`. The panel does not re-parse its own write-back, so disabled
 * items stay. A text change from outside the panel is re-parsed after 300 ms and clears them.
 */
export function BuilderPanel({
  text,
  cursor,
  onReplace,
  connectionId,
  database,
  source,
  defaultCollection,
  onRun,
}: BuilderPanelProps) {
  const { rpc } = useUiApi();
  const [basis, setBasis] = useState<Basis>(() => ({
    text,
    view: viewAt(text, cursor),
    generation: 0,
    notice: null,
  }));
  const [cursorSeen, setCursorSeen] = useState(cursor);
  const [loaded, setLoaded] = useState<{ collection: string; fields: FieldInfo[] }>();
  const { view } = basis;
  const collection = view.kind === 'statement' ? view.statement.collection : undefined;
  const fields =
    collection !== undefined && loaded?.collection === collection ? loaded.fields : NO_FIELDS;
  const pending = text !== basis.text;

  // A cursor move to another statement switches the panel now. A move inside the statement keeps
  // the panel state. Only a cursor move while the text is in sync counts. Otherwise the debounce
  // below re-parses with the latest cursor.
  if (cursor !== cursorSeen) {
    setCursorSeen(cursor);
    if (!pending && !covers(view, cursor)) {
      const next = viewAt(text, cursor);
      if (next.kind !== 'empty' || view.kind !== 'empty') {
        setBasis({
          text,
          view: next,
          generation: basis.generation + 1,
          notice: clearsItems(view) ? 'move' : null,
        });
      }
    }
  }

  // A text change from outside waits 300 ms, then re-parses. Another change restarts the wait.
  useEffect(() => {
    if (!pending) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setBasis({
        text,
        view: viewAt(text, cursor),
        generation: basis.generation + 1,
        notice: clearsItems(view) ? 'text' : null,
      });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [pending, text, cursor, basis.generation, view]);

  useEffect(() => {
    if (collection === undefined) {
      return undefined;
    }
    let active = true;
    void getFields(source, rpc, connectionId, database, collection).then((sampled) => {
      if (active) {
        setLoaded({ collection, fields: sampled });
      }
    });
    return () => {
      active = false;
    };
  }, [source, rpc, connectionId, database, collection]);

  /** Writes a statement over `range` of the text. A statement that emits the same text keeps the text. */
  function write(statement: QueryStatement, range: TextRange): void {
    const doc = basis.text;
    const old = doc.slice(range.start, range.end);
    // The statement range includes a trailing `;`. The emitter writes none, so the panel keeps it.
    const out = emitBuilderStatement(statement) + (old.endsWith(';') ? ';' : '');
    const next: View = {
      kind: 'statement',
      statement,
      range: { start: range.start, end: range.start + out.length },
    };
    if (out === old) {
      setBasis({ ...basis, view: next });
      return;
    }
    onReplace(range, out);
    setBasis({
      text: doc.slice(0, range.start) + out + doc.slice(range.end),
      view: next,
      generation: basis.generation,
      notice: null,
    });
  }

  function insertTemplate(statement: QueryStatement): void {
    write(statement, { start: cursor, end: cursor });
  }

  const name = defaultCollection === '' ? 'collection' : defaultCollection;

  let body: ReactNode;
  if (view.kind === 'empty') {
    body = (
      <Stack gap="xs">
        <Text size="sm" c="dimmed">
          No find or aggregate statement is under the cursor.
        </Text>
        <Group gap="xs">
          <Button size="xs" variant="default" onClick={() => insertTemplate(emptyFind(name))}>
            New find
          </Button>
          <Button
            size="xs"
            variant="default"
            onClick={() => insertTemplate({ kind: 'aggregate', collection: name, stages: [] })}
          >
            New aggregate
          </Button>
        </Group>
      </Stack>
    );
  } else if (view.kind === 'unsupported') {
    body = (
      <Stack gap={2}>
        <Text size="sm">The builder cannot show this statement. Edit the text.</Text>
        <Text size="xs" c="dimmed">
          {view.reason}
        </Text>
      </Stack>
    );
  } else if (view.statement.kind === 'find') {
    const { range, statement } = view;
    body = (
      <FindBuilder
        key={basis.generation}
        statement={statement}
        fields={fields}
        onChange={(next) => write(next, range)}
      />
    );
  } else {
    const { range, statement } = view;
    body = (
      <StageList
        key={basis.generation}
        stages={statement.stages}
        fields={fields}
        onChange={(stages) => write({ ...statement, stages }, range)}
      />
    );
  }

  return (
    <Stack gap="xs" px="calc(14px * var(--mg-font-scale, 1))" py="xs" aria-label="Query builder">
      {onRun !== undefined && (
        <Group justify="flex-end">
          <Button size="xs" leftSection={<IconPlayerPlay size={14} />} onClick={onRun}>
            Run
          </Button>
        </Group>
      )}
      {basis.notice !== null && (
        <Text size="xs" c="dimmed" role="status">
          {CLEARED_NOTICE[basis.notice]}
        </Text>
      )}
      <Box inert={pending}>{body}</Box>
    </Stack>
  );
}
