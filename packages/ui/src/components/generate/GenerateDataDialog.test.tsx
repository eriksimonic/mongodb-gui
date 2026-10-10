// @vitest-environment jsdom
import '../../test-support/browser-shims';
import '@testing-library/jest-dom/vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { localConnectionId } from '../../api/mock-fixtures';
import { renderWithApp } from '../../test-support/render';
import { GenerateDataDialog } from './GenerateDataDialog';
import { useGenerateDialog } from './generate-store';

function openDialog(): void {
  useGenerateDialog.getState().open({
    connectionId: localConnectionId,
    database: 'shop',
    collection: 'orders',
  });
}

function renderDialog() {
  return renderWithApp(<GenerateDataDialog />, { mock: { preset: 'unlocked' } });
}

afterEach(() => {
  useGenerateDialog.setState({ target: undefined });
});

describe('GenerateDataDialog', () => {
  it('adds a field and changes the generator of a row', async () => {
    openDialog();
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: 'Generate data' });
    const before = within(dialog).getAllByLabelText('Name').length;

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add field' }));
    const names = within(dialog).getAllByLabelText('Name');
    expect(names).toHaveLength(before + 1);

    // The label also names the list box, so only the inputs are the generator selects.
    const generators = within(dialog)
      .getAllByLabelText('Generator')
      .filter((node) => node.tagName === 'INPUT');
    const last = generators[generators.length - 1];
    if (last === undefined) {
      throw new Error('the new row has no generator');
    }
    // The starter field "active" is already a boolean, so the new row adds one more option.
    const probabilitiesBefore = within(dialog).queryAllByLabelText('True probability').length;
    fireEvent.click(last);
    fireEvent.click(await screen.findByRole('option', { name: 'Boolean' }));

    expect(within(dialog).getAllByLabelText('True probability')).toHaveLength(
      probabilitiesBefore + 1,
    );
  });

  it('previews three sample documents', async () => {
    openDialog();
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: 'Generate data' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }));

    expect(within(dialog).getAllByText(/"_id"/)).toHaveLength(3);
  });

  it('starts a job, shows progress and reports the finish', async () => {
    openDialog();
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: 'Generate data' });

    fireEvent.change(within(dialog).getByLabelText('Documents'), { target: { value: '2000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));

    expect(
      await within(dialog).findByText(/Inserted 2000 documents/, undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
  });

  it('shows the problem and does not start when a field is invalid', async () => {
    openDialog();
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: 'Generate data' });

    fireEvent.change(within(dialog).getAllByLabelText('Name')[0] ?? document.body, {
      target: { value: 'a..b' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Fields:');
    expect(within(dialog).queryByText(/inserted/)).not.toBeInTheDocument();
  });
});
