// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { renderWithApp } from '../../test-support/render';
import { connectedMockApi } from '../../api/connected-mock';
import { ValidationPanel } from './ValidationPanel';

vi.mock('../../editor/JsonEditor', () => import('../../test-support/json-editor-stub'));

const panel = { connectionId: localConnectionId, database: 'shop', collection: 'orders' };

function validatorField(): HTMLTextAreaElement {
  return screen.getByLabelText('Validator as EJSON') as HTMLTextAreaElement;
}

describe('ValidationPanel', () => {
  it('loads the stored validator as EJSON with its level and action', async () => {
    const api = await connectedMockApi();
    renderWithApp(<ValidationPanel {...panel} />, { api });

    await waitFor(() => expect(validatorField().value).toContain('"$jsonSchema"'));
    expect(screen.getByDisplayValue('Strict, every insert and update')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Error, reject the write')).toBeInTheDocument();
  });

  it('saves the edited validator and reports success', async () => {
    const api = await connectedMockApi();
    const spy = vi.spyOn(api.rpc.management, 'setValidation');
    renderWithApp(<ValidationPanel {...panel} />, { api });

    await waitFor(() => expect(validatorField().value).toContain('$jsonSchema'));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(validatorField(), { target: { value: '{"qty":{"$type":"int"}}' } });
    fireEvent.click(save);

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith({
      connectionId: localConnectionId,
      database: 'shop',
      collection: 'orders',
      rules: {
        validatorEjson: '{"qty":{"$type":"int"}}',
        validationLevel: 'strict',
        validationAction: 'error',
      },
    });
  });

  it('refuses to save text that is not a JSON object and names the problem', async () => {
    const api = await connectedMockApi();
    const spy = vi.spyOn(api.rpc.management, 'setValidation');
    renderWithApp(<ValidationPanel {...panel} />, { api });

    await waitFor(() => expect(validatorField().value).toContain('$jsonSchema'));
    fireEvent.change(validatorField(), { target: { value: '[1]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('The value must be a JSON object')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('checks the draft against the sample and lists the failing ids', async () => {
    const api = await connectedMockApi();
    const spy = vi.spyOn(api.rpc.management, 'checkValidation');
    renderWithApp(<ValidationPanel {...panel} />, { api });

    await waitFor(() => expect(validatorField().value).toContain('$jsonSchema'));
    fireEvent.change(validatorField(), {
      target: { value: '{"$jsonSchema":{"required":["missingField"]}}' },
    });
    fireEvent.change(screen.getByLabelText('Sample size'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check against sample' }));

    expect(
      await screen.findByText('100 sampled documents fail the validator.'),
    ).toBeInTheDocument();
    const ids = screen.getByLabelText('Failing _id values') as HTMLTextAreaElement;
    expect(ids.value.split('\n')).toHaveLength(20);
    expect(ids.value).toContain('{"$oid":"000000000000000000000001"}');
    expect(screen.getByRole('button', { name: 'Copy ids' })).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        sampleSize: 100,
        validatorEjson: '{"$jsonSchema":{"required":["missingField"]}}',
      }),
    );
  });

  it('reports a sample that passes the draft validator', async () => {
    const api = await connectedMockApi();
    renderWithApp(<ValidationPanel {...panel} />, { api });

    await waitFor(() => expect(validatorField().value).toContain('$jsonSchema'));
    fireEvent.change(validatorField(), { target: { value: '{}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check against sample' }));

    expect(await screen.findByText('The sample passes the validator.')).toBeInTheDocument();
  });
});
