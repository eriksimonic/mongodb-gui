// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithApp } from '../../test-support/render';
import { ConnectionTree } from './ConnectionTree';

/** Opens Local dev, which the mock runs as a three-member replica set, and waits for the members. */
async function openReplicaSet(): Promise<void> {
  renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked', replication: true } });
  const local = await screen.findByRole('treeitem', { name: 'Local dev' });
  local.focus();
  fireEvent.keyDown(local, { key: 'ArrowRight' });
  await screen.findByRole('treeitem', { name: 'localhost:27018' });
}

describe('ConnectionTree replica set node', () => {
  it('lists the members with their state under the set node', async () => {
    await openReplicaSet();

    const node = screen.getByRole('treeitem', { name: 'Replica set rs0' });
    const primary = screen.getByRole('treeitem', { name: 'localhost:27017' });
    const arbiter = screen.getByRole('treeitem', { name: 'localhost:27019' });
    expect(node).toHaveAttribute('aria-expanded', 'true');
    expect(primary).toHaveAttribute('aria-level', '3');
    expect(primary).toHaveAttribute('title', 'PRIMARY · this connection');
    expect(within(primary).getByText('PRIMARY · this')).toBeInTheDocument();
    expect(arbiter).toHaveAttribute('title', 'ARBITER');
    expect(screen.getByRole('treeitem', { name: 'localhost:27018' })).toHaveAttribute(
      'title',
      'SECONDARY · 2.5 s behind',
    );
  });

  it('connects directly to a member from its menu and shows the new connection', async () => {
    await openReplicaSet();
    fireEvent.contextMenu(screen.getByRole('treeitem', { name: 'localhost:27018' }));
    fireEvent.click(await screen.findByText('Connect directly'));

    const direct = await screen.findByRole('treeitem', { name: 'Local dev · localhost:27018' });
    await waitFor(() => expect(direct).toHaveAttribute('aria-expanded', 'true'));
  });

  it('collapses the set node and remembers that', async () => {
    await openReplicaSet();
    const node = screen.getByRole('treeitem', { name: 'Replica set rs0' });
    node.focus();
    fireEvent.keyDown(node, { key: 'ArrowLeft' });

    await waitFor(() =>
      expect(screen.queryByRole('treeitem', { name: 'localhost:27018' })).not.toBeInTheDocument(),
    );
    expect(node).toHaveAttribute('aria-expanded', 'false');
  });
});
