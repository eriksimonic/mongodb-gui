import type { Meta, StoryObj } from '@storybook/react-vite';
import type { CopyProgress } from '@mongo-gui/core';
import { AppRoot } from '../AppRoot';
import { createMockUiApi } from '../api/mock-rpc-client';
import { CopyProgressView } from './CopyProgressView';
import type { CopyItemState, CopyJob } from './copy-store';

const base: CopyProgress = {
  phase: 'copying',
  documents: 0,
  collectionsDone: 0,
  collectionsTotal: 3,
  failedDocuments: 0,
  skippedDocuments: 0,
  lines: [],
  elapsedMs: 0,
  done: false,
  cancelled: false,
};

function jobOf(
  progress: Partial<CopyProgress>,
  itemStates: readonly CopyItemState[],
  lines: readonly string[] = [],
  ended = false,
): CopyJob {
  const latest = { ...base, ...progress };
  return {
    jobId: 'story-job',
    items: [],
    itemStates,
    marks: [],
    progress: latest,
    result: ended ? latest : undefined,
    lines,
  };
}

const meta: Meta<typeof CopyProgressView> = {
  title: 'Copy/CopyProgressView',
  component: CopyProgressView,
  args: { job: undefined, onCancel: () => undefined },
  decorators: [
    (Story) => (
      <AppRoot api={createMockUiApi({ preset: 'unlocked' })}>
        <div style={{ width: 640, padding: 16 }}>
          <Story />
        </div>
      </AppRoot>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

/** A copy with one collection done, one being written and one queued. */
export const Running: Story = {
  args: {
    job: jobOf(
      {
        current: 'orders',
        documents: 48_000,
        totalDocuments: 120_000,
        skippedDocuments: 0,
        collectionsDone: 1,
        elapsedMs: 6200,
        notes: ['sensor_readings is a time series collection and is filled in place.'],
      },
      [
        { source: 'customers', target: 'customers', status: 'done', documents: 40_000, skipped: 0 },
        {
          source: 'orders',
          target: 'orders_copy',
          status: 'copying',
          documents: 8_000,
          skipped: 0,
        },
        { source: 'users', target: 'users', status: 'queued', documents: 0, skipped: 0 },
      ],
      ['copying shop.orders to orders_copy'],
    ),
  },
};

/** A finished copy in insert only mode, where some _id values already existed. */
export const FinishedWithSkipped: Story = {
  args: {
    job: jobOf(
      {
        phase: 'finished',
        documents: 120_000,
        totalDocuments: 120_000,
        skippedDocuments: 3_412,
        collectionsDone: 3,
        elapsedMs: 15_300,
      },
      [
        { source: 'customers', target: 'customers', status: 'done', documents: 40_000, skipped: 0 },
        { source: 'orders', target: 'orders', status: 'done', documents: 60_000, skipped: 3_412 },
        { source: 'users', target: 'users', status: 'done', documents: 20_000, skipped: 0 },
      ],
      [],
      true,
    ),
  },
};

/** A copy that stopped on a refused insert. The item it was writing shows as failed. */
export const Failed: Story = {
  args: {
    job: jobOf(
      {
        phase: 'finished',
        documents: 52_000,
        failedDocuments: 1,
        collectionsDone: 1,
        elapsedMs: 9100,
        error: { code: 'INTERNAL', message: 'The target refused the insert' },
      },
      [
        { source: 'customers', target: 'customers', status: 'done', documents: 40_000, skipped: 0 },
        { source: 'orders', target: 'orders', status: 'failed', documents: 12_000, skipped: 0 },
        { source: 'users', target: 'users', status: 'queued', documents: 0, skipped: 0 },
      ],
      [],
      true,
    ),
  },
};
