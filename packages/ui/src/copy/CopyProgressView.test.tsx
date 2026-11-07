// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import type { CopyProgress } from '@mongo-gui/core';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../test-support/render';
import { CopyProgressView } from './CopyProgressView';
import type { CopyItemState, CopyJob } from './copy-store';

function progressOf(overrides: Partial<CopyProgress> = {}): CopyProgress {
  return {
    phase: 'copying',
    documents: 0,
    processedDocuments: 0,
    collectionsDone: 0,
    collectionsTotal: 2,
    failedDocuments: 0,
    skippedDocuments: 0,
    lines: [],
    elapsedMs: 0,
    done: false,
    cancelled: false,
    ...overrides,
  };
}

const ORDERS_COPYING: CopyItemState = {
  source: 'orders',
  target: 'orders',
  status: 'copying',
  documents: 100,
  skipped: 0,
  processed: 100,
};
const USERS_QUEUED: CopyItemState = {
  source: 'users',
  target: 'users_copy',
  status: 'queued',
  documents: 0,
  skipped: 0,
  processed: 0,
};

/** A job with its latest event, its final event (when it ended) and its item states. */
function jobOf(options: {
  readonly progress: CopyProgress;
  readonly result?: CopyProgress;
  readonly itemStates?: readonly CopyItemState[];
  readonly lines?: readonly string[];
}): CopyJob {
  return {
    jobId: 'job-1',
    items: [],
    itemStates: [...(options.itemStates ?? [])],
    marks: [],
    progress: options.progress,
    result: options.result,
    lines: [...(options.lines ?? [])],
  };
}

function renderView(job: CopyJob | undefined, onCancel?: () => void) {
  return renderWithApp(<CopyProgressView job={job} onCancel={onCancel} />);
}

describe('CopyProgressView while the job runs', () => {
  it('shows the collection being copied, the bar and the counts', () => {
    renderView(
      jobOf({
        progress: progressOf({
          current: 'orders',
          documents: 100,
          processedDocuments: 100,
          totalDocuments: 200,
          skippedDocuments: 3,
          collectionsDone: 0,
          elapsedMs: 1500,
        }),
        itemStates: [ORDERS_COPYING, USERS_QUEUED],
      }),
    );

    expect(screen.getByText('Copying orders')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: 'Copy progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(
      screen.getByText(/100 of 200 processed, 3 skipped, 0 of 2 collections/),
    ).toBeInTheDocument();
  });

  it('shows a row per collection with its documents, skips and status', () => {
    renderView(
      jobOf({
        progress: progressOf({ current: 'orders' }),
        itemStates: [ORDERS_COPYING, USERS_QUEUED],
      }),
    );

    const table = screen.getByRole('table', { name: 'Collections' });
    const [ordersRow, usersRow] = within(table).getAllByRole('row').slice(1);
    if (ordersRow === undefined || usersRow === undefined) {
      throw new Error('Expected a row for each collection');
    }
    expect(within(ordersRow).getByText('orders')).toBeInTheDocument();
    expect(within(ordersRow).getByText('Copying')).toBeInTheDocument();
    expect(within(ordersRow).getByText('100')).toBeInTheDocument();
    expect(within(usersRow).getByText('users to users_copy')).toBeInTheDocument();
    expect(within(usersRow).getByText('Queued')).toBeInTheDocument();
    expect(
      within(usersRow).getByRole('progressbar', { name: 'Progress for users to users_copy' }),
    ).toHaveAttribute('aria-valuenow', '0');
  });

  it('calls onCancel from the cancel button', () => {
    const onCancel = vi.fn();
    renderView(jobOf({ progress: progressOf({ current: 'orders' }) }), onCancel);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('says the copy is starting before the first event', () => {
    renderView(undefined);

    expect(screen.getByText('Starting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('shows the log lines only after the log is opened', () => {
    renderView(
      jobOf({
        progress: progressOf({ current: 'orders' }),
        lines: ['copying shop.orders', 'wrote 100 documents'],
      }),
    );

    const toggle = screen.getByRole('button', { name: 'Show log' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Hide log' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByTestId('copy-log')).toHaveTextContent('copying shop.orders');
    expect(screen.getByTestId('copy-log')).toHaveTextContent('wrote 100 documents');
  });

  it('shows the notes as warnings while the job runs', () => {
    renderView(
      jobOf({
        progress: progressOf({
          current: 'orders',
          notes: ['sensor_readings was filled in place'],
        }),
      }),
    );

    expect(screen.getByText('sensor_readings was filled in place')).toBeInTheDocument();
  });
});

describe('CopyProgressView live progress', () => {
  it('fills the bar from processed documents while the tool has restored none', () => {
    renderView(
      jobOf({
        progress: progressOf({
          current: 'orders',
          documents: 0,
          processedDocuments: 500,
          totalDocuments: 1000,
        }),
        itemStates: [{ ...ORDERS_COPYING, documents: 0, processed: 500, total: 1000 }],
      }),
    );

    expect(screen.getByRole('progressbar', { name: 'Copy progress' })).toHaveAttribute(
      'aria-valuenow',
      '50',
    );
    expect(screen.getByText(/500 of 1,000 processed, 0 restored, 0 skipped/)).toBeInTheDocument();
  });

  it('shows an indeterminate top bar while running without a total', () => {
    renderView(jobOf({ progress: progressOf({ current: 'orders', processedDocuments: 500 }) }));

    const bar = screen.getByRole('progressbar', { name: 'Copy progress' });
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByText(/500 processed, 0 restored, 0 skipped/)).toBeInTheDocument();
  });

  it('keeps the exact restored count in the text when it differs from processed', () => {
    renderView(
      jobOf({
        progress: progressOf({
          current: 'orders',
          documents: 400,
          skippedDocuments: 600,
          processedDocuments: 1000,
          totalDocuments: 1000,
        }),
      }),
    );

    expect(
      screen.getByText(/1,000 of 1,000 processed, 400 restored, 600 skipped/),
    ).toBeInTheDocument();
  });

  it('shows the copying item as a share of its own total', () => {
    renderView(
      jobOf({
        progress: progressOf({ current: 'orders', currentTotal: 1000, processedDocuments: 250 }),
        itemStates: [{ ...ORDERS_COPYING, processed: 250, total: 1000 }, USERS_QUEUED],
      }),
    );

    expect(screen.getByRole('progressbar', { name: 'Progress for orders' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    );
  });

  it('shows the copying item as indeterminate when its total is unknown', () => {
    renderView(
      jobOf({
        progress: progressOf({ current: 'orders', processedDocuments: 250 }),
        itemStates: [{ ...ORDERS_COPYING, processed: 250 }, USERS_QUEUED],
      }),
    );

    const row = screen.getByRole('progressbar', { name: 'Progress for orders' });
    expect(row).not.toHaveAttribute('aria-valuenow');
  });

  it('fills a done item and leaves a queued item at 0', () => {
    renderView(
      jobOf({
        progress: progressOf({ current: 'users_copy', collectionsDone: 1 }),
        itemStates: [{ ...ORDERS_COPYING, status: 'done', processed: 100 }, USERS_QUEUED],
      }),
    );

    expect(screen.getByRole('progressbar', { name: 'Progress for orders' })).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
    expect(
      screen.getByRole('progressbar', { name: 'Progress for users to users_copy' }),
    ).toHaveAttribute('aria-valuenow', '0');
  });
});

describe('CopyProgressView when the job ends', () => {
  it('summarises a finished copy with the skipped count and the duration', () => {
    const result = progressOf({
      phase: 'finished',
      done: true,
      documents: 300,
      skippedDocuments: 12,
      collectionsDone: 2,
      collectionsTotal: 2,
      elapsedMs: 4200,
    });
    renderView(
      jobOf({
        progress: result,
        result,
        itemStates: [
          { ...ORDERS_COPYING, status: 'done', documents: 200, skipped: 12 },
          { ...USERS_QUEUED, status: 'done', documents: 100, skipped: 0 },
        ],
      }),
    );

    expect(screen.getByText('Copy finished')).toBeInTheDocument();
    expect(
      screen.getByText('Copied 300 documents in 2 of 2 collections. 12 skipped. Took 4.2 s.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Copy progress' })).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('reports a failed copy with its error and marks the item that failed', () => {
    const result = progressOf({
      phase: 'finished',
      done: true,
      documents: 40,
      failedDocuments: 2,
      collectionsDone: 0,
      error: { code: 'INTERNAL', message: 'The target refused the insert' },
    });
    renderView(
      jobOf({
        progress: result,
        result,
        itemStates: [{ ...ORDERS_COPYING, status: 'failed', documents: 40, skipped: 0 }],
      }),
    );

    expect(screen.getByText('The copy failed')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The target refused the insert');
    expect(screen.getByRole('alert')).toHaveTextContent('Processed 40 documents before the stop');
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('reports a cancelled copy when only the cancelled flag is set', () => {
    const result = progressOf({
      phase: 'finished',
      done: true,
      cancelled: true,
      collectionsDone: 1,
    });
    renderView(
      jobOf({
        progress: result,
        result,
        itemStates: [{ ...ORDERS_COPYING, status: 'done', documents: 100, skipped: 0 }],
      }),
    );

    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Collections that finished stay in the target. The collection being written when the job stopped may be partly filled.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports a cancelled copy when the service also sends a CANCELLED error', () => {
    const result = progressOf({
      phase: 'finished',
      done: true,
      cancelled: true,
      error: { code: 'CANCELLED', message: 'The copy was cancelled' },
    });
    renderView(jobOf({ progress: result, result }));

    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByText('The copy was cancelled')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the notes of the final event as warnings', () => {
    const result = progressOf({
      phase: 'finished',
      done: true,
      collectionsDone: 2,
      notes: ['sensor_readings was filled in place'],
    });
    renderView(jobOf({ progress: result, result }));

    expect(screen.getByText('sensor_readings was filled in place')).toBeInTheDocument();
  });

  it('shows the notes of the final event even when the latest progress has none', () => {
    const latest = progressOf({ current: 'orders', collectionsDone: 1 });
    const result = progressOf({
      phase: 'finished',
      done: true,
      collectionsDone: 2,
      notes: ['sensor_readings was filled in place'],
    });
    renderView(jobOf({ progress: latest, result }));

    expect(screen.getByText('sensor_readings was filled in place')).toBeInTheDocument();
  });

  it('labels the counts of a cancelled copy as processed and keeps the finished collections', () => {
    const result = progressOf({
      phase: 'finished',
      done: true,
      cancelled: true,
      documents: 100,
      collectionsDone: 1,
      error: { code: 'CANCELLED', message: 'The copy was cancelled' },
    });
    renderView(jobOf({ progress: result, result }));

    expect(
      screen.getByText(
        'Processed 100 documents before the stop in 1 of 2 collections. 0 skipped. Took 0.0 s.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Collections that finished stay in the target. The collection being written when the job stopped may be partly filled.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/partly written/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Copied/)).not.toBeInTheDocument();
  });

  it('warns that the target may be partly written when a stopped copy has notes', () => {
    const notes = [
      'sensor_readings is written in place, because the source is a time series collection. A cancel leaves it partly filled.',
    ];
    const result = progressOf({
      phase: 'finished',
      done: true,
      cancelled: true,
      documents: 50,
      collectionsDone: 0,
      notes,
    });
    renderView(jobOf({ progress: result, result }));

    expect(screen.getByText(notes[0] ?? '')).toBeInTheDocument();
    expect(
      screen.getByText('The target may be partly written. Read the warnings above.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        'Collections that finished stay in the target. The collection being written when the job stopped may be partly filled.',
      ),
    ).not.toBeInTheDocument();
  });

  it('warns that the target may be partly written when a failed copy has notes', () => {
    const result = progressOf({
      phase: 'finished',
      done: true,
      documents: 20,
      notes: ['sensor_readings is a time series collection. Its counts are buckets, not points.'],
      error: { code: 'INTERNAL', message: 'The target refused the insert' },
    });
    renderView(jobOf({ progress: result, result }));

    expect(
      screen.getByText('The target may be partly written. Read the warnings above.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        'Collections that finished stay in the target. The collection being written when the job stopped may be partly filled.',
      ),
    ).not.toBeInTheDocument();
  });
});
