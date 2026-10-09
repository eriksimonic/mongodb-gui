// @vitest-environment jsdom
import type { ConnectionStatus } from '@mongo-gui/core';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { renderWithApp } from '../../test-support/render';
import { PanelOpenerContext, type OpenPanel } from '../../state/panel-opener';
import { connectionNodeId } from '../../state/node-ids';
import { ConnectionTree } from './ConnectionTree';

const CONNECTED: ConnectionStatus = {
  state: 'connected',
  serverVersion: '8.0.4',
  topology: 'standalone',
  hosts: ['localhost:27017'],
};

function renderOpenConnected(openPanel: OpenPanel) {
  return renderWithApp(
    <PanelOpenerContext.Provider value={openPanel}>
      <ConnectionTree />
    </PanelOpenerContext.Provider>,
    {
      mock: { preset: 'unlocked' },
      initialState: {
        statuses: { [localConnectionId]: CONNECTED },
        expanded: { [connectionNodeId(localConnectionId)]: true },
      },
    },
  );
}

describe('ConnectionTree monitor children', () => {
  it('opens the monitor panel for the connection on double click of Monitoring', async () => {
    const openPanel = vi.fn<OpenPanel>();
    renderOpenConnected(openPanel);

    fireEvent.doubleClick(await screen.findByRole('treeitem', { name: 'Monitoring' }));

    expect(openPanel).toHaveBeenCalledWith({
      kind: 'monitor',
      connectionId: localConnectionId,
      connectionName: 'Local dev',
    });
  });

  it('offers Monitor in the connection context menu once the connection is open', async () => {
    const openPanel = vi.fn<OpenPanel>();
    renderOpenConnected(openPanel);

    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'Local dev' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Monitor' }));

    expect(openPanel).toHaveBeenCalledWith({
      kind: 'monitor',
      connectionId: localConnectionId,
      connectionName: 'Local dev',
    });
  });

  it('opens the operations panel with Enter on the Operations child', async () => {
    const openPanel = vi.fn<OpenPanel>();
    renderOpenConnected(openPanel);

    const operations = await screen.findByRole('treeitem', { name: 'Operations' });
    operations.focus();
    fireEvent.keyDown(operations, { key: 'Enter' });

    expect(openPanel).toHaveBeenCalledWith({
      kind: 'operations',
      connectionId: localConnectionId,
      connectionName: 'Local dev',
    });
  });
});
