// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import type { LogLine } from '@mongo-gui/core';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../test-support/render';
import { connectedMockApi } from '../api/connected-mock';
import { localConnectionId } from '../api/mock-fixtures';
import { createDiagnosticsStore, type DiagnosticsClient } from './diagnostics-store';
import { LogsTab } from './LogsTab';

/** A log of n lines in the order getLog returns them, oldest first. */
function logLines(n: number, from = 0): LogLine[] {
  return Array.from({ length: n }, (_, index) => {
    const number = from + index;
    return {
      ts: '2026-10-10T08:00:00.000Z',
      severity: 'I',
      component: 'NETWORK',
      message: `Connection ${number}`,
      attributes: { n: number },
      raw: `{"msg":"Connection ${number}"}`,
    };
  });
}

function clientReturning(lines: () => LogLine[]): DiagnosticsClient {
  const getLog = vi.fn(async () => ({
    kind: 'global' as const,
    total: lines().length,
    lines: lines(),
  }));
  return { getLog } as unknown as DiagnosticsClient;
}

describe('LogsTab with a long log', () => {
  it('renders a bounded number of rows for 10,000 lines', async () => {
    const api = await connectedMockApi();
    const store = createDiagnosticsStore(
      { connectionId: localConnectionId },
      clientReturning(() => logLines(10000)),
    );
    renderWithApp(<LogsTab store={store} kind="global" />, { api });

    await screen.findByText(/Showing 10000 of 10000 lines/);
    // The header row plus the rows that fit the viewport and the overscan, never all 10,000.
    const rows = screen.getAllByRole('row');
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.length).toBeLessThan(120);
    // The newest line is first in the list.
    expect(screen.getByText('Connection 9999')).toBeInTheDocument();
    expect(screen.queryByText('Connection 0')).not.toBeInTheDocument();
  });
});
