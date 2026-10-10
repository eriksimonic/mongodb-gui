import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { localConnectionId } from '../../api/mock-fixtures';
import { bsonSampleDocuments } from '../../api/mock-bson-fixtures';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { AppRoot } from '../../AppRoot';
import type { AppData } from '../../state/app-store';
import {
  EMPTY_EDITORS,
  openTab,
  resultFromEvaluation,
  finishRun,
  beginRun,
  type ResultView,
} from '../../state/editors';
import { EditorView } from './EditorView';

const TAB_ID = 'story-tab';
const STATEMENT = 'db.bson_samples.find()';
const DATABASE = 'analytics';

interface StoryOptions {
  readonly view?: ResultView;
  readonly text?: string;
  readonly result?: 'cursor' | 'value' | 'none';
  readonly error?: boolean;
}

/** An editors slice with a tab that already holds a finished run, so the views show without a server. */
function seededEditors(options: StoryOptions): AppData['editors'] {
  const text = options.text ?? STATEMENT;
  let state = openTab(EMPTY_EDITORS, {
    id: TAB_ID,
    connectionId: localConnectionId,
    database: DATABASE,
    text,
    view: options.view ?? 'table',
  });
  if (options.error === true) {
    return finishRun(state, TAB_ID, {
      error: { code: 'VALIDATION', message: 'Unexpected end of input' },
    });
  }
  if (options.result === 'none' || (options.result === undefined && text === '')) {
    return state;
  }
  state = beginRun(state, TAB_ID, 'story-run', 0);
  const outcome =
    options.result === 'value'
      ? resultFromEvaluation({
          statement: 'db.bson_samples.countDocuments()',
          database: DATABASE,
          evaluation: {
            requestId: 'story-run',
            result: { type: 'number', printableEjson: '{"$numberInt":"12"}', hasMore: false },
            elapsedMs: 3,
          },
        })
      : resultFromEvaluation({
          statement: STATEMENT,
          database: DATABASE,
          evaluation: {
            requestId: 'story-run',
            result: {
              type: 'Cursor',
              printableEjson: JSON.stringify({
                cursorHasMore: false,
                documents: bsonSampleDocuments(12),
              }),
              hasMore: false,
            },
            elapsedMs: 18,
          },
        });
  return finishRun(state, TAB_ID, outcome);
}

function withEditor(options: StoryOptions) {
  return (Story: () => ReactElement) => (
    <AppRoot
      api={createMockUiApi({ preset: 'unlocked' })}
      initialState={{ editors: seededEditors(options) }}
    >
      <div style={{ height: 620, display: 'flex', flexDirection: 'column' }}>
        <Story />
      </div>
    </AppRoot>
  );
}

const meta: Meta<typeof EditorView> = {
  title: 'Screens/EditorView',
  component: EditorView,
  args: { tabId: TAB_ID },
};

export default meta;

type Story = StoryObj<typeof meta>;

/** The headline view: documents in a grid, with paging and the column chooser. */
export const TableResults: Story = {
  decorators: [withEditor({ view: 'table' })],
};

/** The same documents as an expandable tree with type badges. */
export const TreeResults: Story = {
  decorators: [withEditor({ view: 'tree' })],
};

/** The same documents as read-only mongosh syntax. */
export const JsonResults: Story = {
  decorators: [withEditor({ view: 'json' })],
};

/** A tab with no run yet. */
export const Empty: Story = {
  decorators: [withEditor({ text: '', result: 'none' })],
};

/** A run that stopped on an error. */
export const ErrorState: Story = {
  decorators: [withEditor({ error: true })],
};

/** A statement that returns a value rather than documents. It shows as JSON with its summary line. */
export const NonCursorResult: Story = {
  decorators: [withEditor({ text: 'db.bson_samples.countDocuments()', result: 'value' })],
};
