// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { ProfilerOpenerContext } from '../../profiler/profiler-opener';
import { renderWithApp } from '../../test-support/render';
import { ConnectionTree } from './ConnectionTree';

describe('ConnectionTree', () => {
  it('loads databases when a connection is opened with the keyboard', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    const local = await screen.findByRole('treeitem', { name: 'Local dev' });
    local.focus();
    fireEvent.keyDown(local, { key: 'ArrowRight' });

    expect(await screen.findByRole('treeitem', { name: 'shop' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'analytics' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'logs' })).toBeInTheDocument();
  });

  it('shows collections when a database is expanded', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    const local = await screen.findByRole('treeitem', { name: 'Local dev' });
    local.focus();
    fireEvent.keyDown(local, { key: 'ArrowRight' });
    const shop = await screen.findByRole('treeitem', { name: 'shop' });
    shop.focus();
    fireEvent.keyDown(shop, { key: 'ArrowRight' });

    expect(await screen.findByRole('treeitem', { name: 'orders' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'paid_orders' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'sensor_readings' })).toBeInTheDocument();
  });

  it('gives one tab stop to the whole tree and moves it with the arrow keys', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    const local = await screen.findByRole('treeitem', { name: 'Local dev' });
    const staging = screen.getByRole('treeitem', { name: 'Staging' });
    expect(local).toHaveAttribute('tabindex', '0');
    expect(staging).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(local, { key: 'ArrowDown' });
    expect(staging).toHaveFocus();
    expect(staging).toHaveAttribute('tabindex', '0');
    expect(local).toHaveAttribute('tabindex', '-1');
    expect(staging).toHaveAttribute('aria-level', '1');
  });

  it('collapses with the Left arrow and returns focus to the parent', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    const local = await screen.findByRole('treeitem', { name: 'Local dev' });
    local.focus();
    fireEvent.keyDown(local, { key: 'ArrowRight' });
    const shop = await screen.findByRole('treeitem', { name: 'shop' });
    shop.focus();

    fireEvent.keyDown(shop, { key: 'ArrowLeft' });
    expect(local).toHaveFocus();
    fireEvent.keyDown(local, { key: 'ArrowLeft' });
    await waitFor(() => expect(local).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.queryByRole('treeitem', { name: 'shop' })).not.toBeInTheDocument();
  });

  it('connects a connection with Enter and shows the auth error', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    const staging = await screen.findByRole('treeitem', { name: 'Staging' });
    staging.focus();
    fireEvent.keyDown(staging, { key: 'Enter' });

    expect(await screen.findByText('Authentication failed')).toBeInTheDocument();
    expect(staging).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the context menu on right click', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'Local dev' }));

    expect(await screen.findByRole('menuitem', { name: 'Connect' })).toBeInTheDocument();
    expect(await screen.findByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Remove')).toBeInTheDocument();
  });

  it('opens the context menu from the keyboard with Shift+F10', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    const local = await screen.findByRole('treeitem', { name: 'Local dev' });
    local.focus();
    fireEvent.keyDown(local, { key: 'F10', shiftKey: true });

    expect(await screen.findByRole('menuitem', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('opens the profiler of a database from its Profiler node', async () => {
    const open = vi.fn();
    renderWithApp(
      <ProfilerOpenerContext.Provider value={{ open }}>
        <ConnectionTree />
      </ProfilerOpenerContext.Provider>,
      { mock: { preset: 'unlocked' } },
    );
    const local = await screen.findByRole('treeitem', { name: 'Local dev' });
    local.focus();
    fireEvent.keyDown(local, { key: 'ArrowRight' });
    const shop = await screen.findByRole('treeitem', { name: 'shop' });
    shop.focus();
    fireEvent.keyDown(shop, { key: 'ArrowRight' });

    const profiler = await screen.findByRole('treeitem', { name: 'Profiler' });
    profiler.focus();
    fireEvent.keyDown(profiler, { key: 'Enter' });

    expect(open).toHaveBeenCalledWith(localConnectionId, 'shop');
  });

  it('opens the profiler from the database context menu', async () => {
    const open = vi.fn();
    renderWithApp(
      <ProfilerOpenerContext.Provider value={{ open }}>
        <ConnectionTree />
      </ProfilerOpenerContext.Provider>,
      { mock: { preset: 'unlocked' } },
    );
    const local = await screen.findByRole('treeitem', { name: 'Local dev' });
    local.focus();
    fireEvent.keyDown(local, { key: 'ArrowRight' });

    fireEvent.contextMenu(await screen.findByRole('treeitem', { name: 'analytics' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open profiler' }));

    expect(open).toHaveBeenCalledWith(localConnectionId, 'analytics');
  });

  it('shows a hint when there are no connections', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    for (const connection of await api.rpc.connections.list()) {
      await api.rpc.connections.remove({ id: connection.id });
    }
    renderWithApp(<ConnectionTree />, { api });
    expect(await screen.findByText('No connections yet.')).toBeInTheDocument();
  });
});
