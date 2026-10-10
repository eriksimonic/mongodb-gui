// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { renderWithApp } from '../../test-support/render';
import { connectedMockApi } from '../../api/connected-mock';
import { CreateIndexDialog } from './CreateIndexDialog';

vi.mock('../../editor/JsonEditor', () => import('../../test-support/json-editor-stub'));

const target = {
  connectionId: localConnectionId,
  database: 'shop',
  collection: 'customers',
  onClose: () => undefined,
};

describe('CreateIndexDialog', () => {
  it('keeps Create index disabled until a field is named', async () => {
    const api = await connectedMockApi();
    renderWithApp(<CreateIndexDialog {...target} />, { api });

    expect(screen.getByRole('button', { name: 'Create index' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Field 1' }), {
      target: { value: 'region' },
    });
    expect(screen.getByRole('button', { name: 'Create index' })).toBeEnabled();
  });

  it('sends the keys and options the builder produced', async () => {
    const api = await connectedMockApi();
    const spy = vi.spyOn(api.rpc.management, 'createIndex');
    const onClose = vi.fn();
    renderWithApp(<CreateIndexDialog {...target} onClose={onClose} />, { api });

    fireEvent.change(screen.getByRole('textbox', { name: 'Field 1' }), {
      target: { value: 'region' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Field 2' }), {
      target: { value: 'city' },
    });
    fireEvent.click(screen.getAllByLabelText('Order of field 2')[0] as HTMLElement);
    const options = screen.getAllByLabelText('Order of field 2')[1] as HTMLElement;
    fireEvent.click(await within(options).findByText('Descending (-1)'));
    fireEvent.click(screen.getByLabelText('Unique'));
    fireEvent.change(screen.getByLabelText('Index name'), { target: { value: 'region_city' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create index' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith({
      connectionId: localConnectionId,
      database: 'shop',
      collection: 'customers',
      keys: { region: 1, city: -1 },
      options: { name: 'region_city', unique: true },
    });
  });

  it('replaces an index by dropping it and then creating the new definition', async () => {
    const api = await connectedMockApi();
    const drop = vi.spyOn(api.rpc.management, 'dropIndex');
    const create = vi.spyOn(api.rpc.management, 'createIndex');
    const onClose = vi.fn();
    renderWithApp(
      <CreateIndexDialog
        {...target}
        editing={{ name: 'email_1', key: { email: 1 }, unique: true }}
        onClose={onClose}
      />,
      { api },
    );

    expect(screen.getByText('Edit index email_1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replace index' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(drop).toHaveBeenCalledWith({
      connectionId: localConnectionId,
      database: 'shop',
      collection: 'customers',
      name: 'email_1',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ keys: { email: 1 }, options: { name: 'email_1', unique: true } }),
    );
  });

  it('says the old index was dropped when the create fails after the drop', async () => {
    const api = await connectedMockApi();
    vi.spyOn(api.rpc.management, 'createIndex').mockRejectedValueOnce(new Error('Bad definition'));
    const onClose = vi.fn();
    renderWithApp(
      <CreateIndexDialog
        {...target}
        editing={{ name: 'email_1', key: { email: 1 } }}
        onClose={onClose}
      />,
      { api },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Replace index' }));

    expect(await screen.findByText(/The index email_1 was dropped/)).toBeInTheDocument();
    expect(screen.getByText(/Bad definition/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('previews the createIndexes command as the builder reads it', async () => {
    const api = await connectedMockApi();
    renderWithApp(<CreateIndexDialog {...target} />, { api });

    fireEvent.change(screen.getByRole('textbox', { name: 'Field 1' }), {
      target: { value: 'email' },
    });
    const preview = screen.getByLabelText('createIndexes command preview') as HTMLTextAreaElement;
    expect(JSON.parse(preview.value)).toEqual({
      createIndexes: 'customers',
      indexes: [{ key: { email: 1 } }],
    });
  });

  it('offers the sampled top-level keys as field suggestions', async () => {
    const api = await connectedMockApi();
    renderWithApp(<CreateIndexDialog {...target} />, { api });

    fireEvent.focus(screen.getByRole('textbox', { name: 'Field 1' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Field 1' }), {
      target: { value: 'cust' },
    });
    expect(await screen.findByText('customerId')).toBeInTheDocument();
  });

  it('shows the text weights only when a text key is chosen', async () => {
    const api = await connectedMockApi();
    renderWithApp(<CreateIndexDialog {...target} />, { api });

    expect(screen.queryByLabelText('Text weights')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Field 1' }), {
      target: { value: 'bio' },
    });
    fireEvent.click(screen.getAllByLabelText('Order of field 1')[0] as HTMLElement);
    fireEvent.click(await screen.findByText('Text'));
    expect(screen.getByLabelText('Text weights')).toBeInTheDocument();
  });
});
