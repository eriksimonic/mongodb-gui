// @vitest-environment jsdom
import { AppErrorException, appError } from '@mongo-gui/core';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { connectedMockApi } from '../../api/connected-mock';
import { localConnectionId } from '../../api/mock-fixtures';
import { renderWithApp } from '../../test-support/render';
import { CreateDatabaseDialog } from './CreateDatabaseDialog';
import { DestructiveDialog } from './DestructiveDialog';

describe('CreateDatabaseDialog', () => {
  it('submits from the form, so Enter in a field creates the database', async () => {
    const api = await connectedMockApi();
    const spy = vi.spyOn(api.rpc.management, 'createDatabase');
    const onClose = vi.fn();
    renderWithApp(<CreateDatabaseDialog connectionId={localConnectionId} onClose={onClose} />, {
      api,
    });

    fireEvent.change(screen.getByLabelText('Database name'), { target: { value: 'marketing' } });
    fireEvent.change(screen.getByLabelText('Initial collection name'), {
      target: { value: 'campaigns' },
    });
    const field = screen.getByLabelText('Initial collection name');
    fireEvent.submit(field.closest('form') as HTMLFormElement);

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith({
      connectionId: localConnectionId,
      database: 'marketing',
      initialCollection: 'campaigns',
    });
  });

  it('shows the server detail when the create is refused', async () => {
    const api = await connectedMockApi();
    vi.spyOn(api.rpc.management, 'createDatabase').mockRejectedValue(
      new AppErrorException(
        appError('COMMAND_FAILED', 'The server rejected the command', 'Namespace not allowed'),
      ),
    );
    renderWithApp(<CreateDatabaseDialog connectionId={localConnectionId} onClose={vi.fn()} />, {
      api,
    });

    fireEvent.change(screen.getByLabelText('Database name'), { target: { value: 'marketing' } });
    fireEvent.change(screen.getByLabelText('Initial collection name'), {
      target: { value: 'campaigns' },
    });
    fireEvent.submit(
      screen.getByLabelText('Initial collection name').closest('form') as HTMLFormElement,
    );

    expect(await screen.findByText('Namespace not allowed')).toBeInTheDocument();
    expect(screen.queryByText('The server rejected the command')).not.toBeInTheDocument();
  });
});

describe('DestructiveDialog', () => {
  it('does not confirm on Enter, so a drop needs the button press', async () => {
    const onConfirm = vi.fn(() => Promise.resolve());
    renderWithApp(
      <DestructiveDialog
        title="Drop orders"
        description="Drop it?"
        confirmLabel="Drop collection"
        typedConfirmation="orders"
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );
    const typed = screen.getByLabelText('Type orders to confirm');
    fireEvent.change(typed, { target: { value: 'orders' } });
    fireEvent.keyDown(typed, { key: 'Enter' });

    expect(onConfirm).not.toHaveBeenCalled();
  });
});
