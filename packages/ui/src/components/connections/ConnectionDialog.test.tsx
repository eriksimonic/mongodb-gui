// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { renderWithApp } from '../../test-support/render';
import { ConnectionDialog } from './ConnectionDialog';

describe('ConnectionDialog', () => {
  it('round trips the URI through form mode', async () => {
    renderWithApp(
      <ConnectionDialog connectionId={undefined} initialMode="uri" onClose={() => undefined} />,
    );
    fireEvent.change(screen.getByLabelText('Connection URI'), {
      target: { value: 'mongodb://app:p%40ss@localhost:27017/?authSource=admin' },
    });

    fireEvent.click(screen.getByLabelText('Form'));
    expect(screen.getByLabelText('User name')).toHaveValue('app');
    expect(screen.getByLabelText('Password')).toHaveValue('p@ss');
    expect(screen.getByLabelText('Auth database')).toHaveValue('admin');

    fireEvent.change(screen.getByLabelText('Host 1'), {
      target: { value: 'db.example.net:27017' },
    });
    fireEvent.click(screen.getByLabelText('URI'));
    expect(screen.getByLabelText('Connection URI')).toHaveValue(
      'mongodb://app:p%40ss@db.example.net:27017/?authSource=admin',
    );
  });

  it('builds the URI from typed form fields and encodes the password', async () => {
    renderWithApp(
      <ConnectionDialog connectionId={undefined} initialMode="form" onClose={() => undefined} />,
    );
    fireEvent.change(screen.getByLabelText('User name'), { target: { value: 'ops' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a:b/c' } });

    fireEvent.click(screen.getByLabelText('URI'));
    expect(screen.getByLabelText('Connection URI')).toHaveValue(
      'mongodb://ops:a%3Ab%2Fc@localhost:27017/',
    );
  });

  it('shows the password as asterisks in the URI preview', async () => {
    renderWithApp(
      <ConnectionDialog connectionId={undefined} initialMode="uri" onClose={() => undefined} />,
    );
    fireEvent.change(screen.getByLabelText('Connection URI'), {
      target: { value: 'mongodb://app:secret@localhost:27017/' },
    });
    expect(screen.getByText('mongodb://app:***@localhost:27017/')).toBeInTheDocument();
  });

  it('reports a successful test connection inline', async () => {
    renderWithApp(
      <ConnectionDialog connectionId={undefined} initialMode="uri" onClose={() => undefined} />,
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connected. Server 8.0.4, standalone.')).toBeInTheDocument();
  });

  it('loads an existing connection for editing', async () => {
    renderWithApp(<ConnectionDialog connectionId={localConnectionId} onClose={() => undefined} />, {
      mock: { preset: 'unlocked' },
    });
    expect(await screen.findByDisplayValue('Local dev')).toBeInTheDocument();
    expect(screen.getByLabelText('Connection URI')).toHaveValue(
      'mongodb://app:secret@localhost:27017/?authSource=admin',
    );
  });
});
