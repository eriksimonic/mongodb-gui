// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import { renderWithApp } from '../test-support/render';
import { CopyDialog } from './CopyDialog';
import type { CopyVariant } from './copy-model';

vi.mock('../editor/FilterEditor', () => import('../test-support/filter-editor-stub'));

const OVERLAP = 'The copy writes to a collection it also reads, on the same server.';

interface Rendered {
  readonly api: UiApi;
  readonly onStarted: ReturnType<typeof vi.fn<(jobId: string) => void>>;
  readonly onClose: ReturnType<typeof vi.fn<() => void>>;
}

interface RenderOptions {
  /** Flags the local connection as production before the app loads it. */
  readonly production?: boolean;
  /** Makes the source database report one encrypted collection, which raises a strong finding. */
  readonly encryptedSource?: boolean;
}

/** Renders the dialog for the local connection. */
async function renderCopy(
  variant: CopyVariant,
  collections: readonly string[],
  options: RenderOptions = {},
): Promise<Rendered> {
  const api = createMockUiApi({ preset: 'unlocked' });
  await api.rpc.connections.connect({ id: localConnectionId });
  if (options.production === true) {
    await api.rpc.connections.update({ id: localConnectionId, patch: { production: true } });
  }
  if (options.encryptedSource === true) {
    const describe = api.rpc.backup.describeServer;
    vi.spyOn(api.rpc.backup, 'describeServer').mockImplementation(async (input) => {
      const info = await describe(input);
      if (input.scope?.kind !== 'database' || input.scope.database !== 'shop') {
        return info;
      }
      const others = info.namespaces.filter((item) => item.database !== 'shop');
      const orders = {
        database: 'shop',
        collection: 'orders',
        type: 'collection' as const,
        encrypted: true,
      };
      return { ...info, namespaces: [...others, { ...orders, documents: 2 }] };
    });
  }
  const onStarted = vi.fn<(jobId: string) => void>();
  const onClose = vi.fn<() => void>();
  renderWithApp(
    <CopyDialog
      sourceConnectionId={localConnectionId}
      sourceDatabase="shop"
      variant={variant}
      collections={collections}
      onStarted={onStarted}
      onClose={onClose}
    />,
    { api },
  );
  return { api, onStarted, onClose };
}

/** Moves the copy to another database on the same server, which clears the overlap block. */
async function copyToOtherDatabase() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Target database' }), {
    target: { value: 'shop_copy' },
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start copy' })).toBeEnabled());
}

describe('CopyDialog', () => {
  it('blocks the default copy onto the same collection on the same server', async () => {
    await renderCopy('one', ['orders']);
    await screen.findByText(OVERLAP);
    expect(screen.getByRole('button', { name: 'Start copy' })).toBeDisabled();
  });

  it('copies one collection under its own name when the database changes', async () => {
    await renderCopy('one', ['orders']);
    expect(screen.getByRole('textbox', { name: 'Source collection' })).toHaveValue('orders');
    expect(screen.getByRole('textbox', { name: 'Target collection' })).toHaveValue('orders');
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    await copyToOtherDatabase();
  });

  it('lists a checkbox per collection and copies only the checked ones', async () => {
    const { api, onStarted, onClose } = await renderCopy('many', ['orders', 'users']);
    expect(screen.getByRole('checkbox', { name: 'orders' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'users' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'users' }));
    expect(screen.getByRole('textbox', { name: 'Target collection for users' })).toBeDisabled();
    await copyToOtherDatabase();

    const start = vi.spyOn(api.rpc.copy, 'start');
    fireEvent.click(screen.getByRole('button', { name: 'Start copy' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(expect.any(String)));
    expect(start.mock.calls[0]?.[0]).toEqual({
      sourceConnectionId: localConnectionId,
      targetConnectionId: localConnectionId,
      sourceDatabase: 'shop',
      targetDatabase: 'shop_copy',
      items: [{ source: 'orders', target: 'orders' }],
      mode: 'replace',
      acknowledged: [],
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers every collection of a database, all checked', async () => {
    await renderCopy('database', ['orders', 'users']);
    const dialog = screen.getByRole('dialog', { name: 'Copy database shop' });
    const boxes = within(dialog).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect(box).toBeChecked();
    }
  });

  it('blocks Start while two checked items write to the same name', async () => {
    await renderCopy('many', ['orders', 'users']);
    await copyToOtherDatabase();
    fireEvent.change(screen.getByRole('textbox', { name: 'Target collection for users' }), {
      target: { value: 'orders' },
    });
    expect(screen.getAllByText('Two items write to orders')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Start copy' })).toBeDisabled();
  });

  it('opens the filter editor and blocks Start on invalid extended JSON', async () => {
    await renderCopy('one', ['orders']);
    await copyToOtherDatabase();
    const toggle = screen.getByRole('button', { name: 'Filter for orders' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const filter = screen.getByRole('textbox', { name: 'Extended JSON filter for orders' });
    fireEvent.change(filter, { target: { value: '{"status": ' } });
    expect(screen.getByRole('button', { name: 'Start copy' })).toBeDisabled();

    fireEvent.change(filter, { target: { value: '{"status": "paid"}' } });
    expect(screen.getByRole('button', { name: 'Start copy' })).toBeEnabled();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('textbox', { name: 'Extended JSON filter for orders' })).toBeNull();
  });

  it('sends the renamed target, the filter and the mode', async () => {
    const { api, onStarted } = await renderCopy('one', ['orders']);
    await copyToOtherDatabase();
    fireEvent.change(screen.getByRole('textbox', { name: 'Target collection' }), {
      target: { value: 'orders_copy' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Filter for orders' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Extended JSON filter for orders' }), {
      target: { value: ' {"status": "paid"} ' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Merge' }));

    const start = vi.spyOn(api.rpc.copy, 'start');
    fireEvent.click(screen.getByRole('button', { name: 'Start copy' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      targetDatabase: 'shop_copy',
      items: [{ source: 'orders', target: 'orders_copy', filter: '{"status": "paid"}' }],
      mode: 'merge',
    });
  });

  it('explains the mode that is selected', async () => {
    await renderCopy('one', ['orders']);
    expect(
      screen.getByText(
        'Restores into a temporary collection, then swaps it in. A cancel keeps the old data.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Insert only' }));
    expect(
      screen.getByText('Skips documents whose _id already exists in the target.'),
    ).toBeInTheDocument();
  });

  it('asks for the typed database name before copying into a production connection', async () => {
    const { api, onStarted } = await renderCopy('one', ['orders'], { production: true });
    fireEvent.change(screen.getByRole('textbox', { name: 'Target database' }), {
      target: { value: 'shop_copy' },
    });

    const typed = await screen.findByRole('textbox', { name: 'Type shop_copy to confirm' });
    expect(screen.getByRole('button', { name: 'Start copy' })).toBeDisabled();
    fireEvent.change(typed, { target: { value: 'shop_copy' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start copy' })).toBeEnabled());

    const start = vi.spyOn(api.rpc.copy, 'start');
    fireEvent.click(screen.getByRole('button', { name: 'Start copy' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      targetConnectionId: localConnectionId,
      confirmation: 'shop_copy',
    });
  });

  it('keeps the dialog open and shows the error when the server refuses the start', async () => {
    const { api, onStarted, onClose } = await renderCopy('one', ['orders']);
    await copyToOtherDatabase();
    vi.spyOn(api.rpc.copy, 'start').mockRejectedValueOnce(new Error('Tools 100.9 are too old'));
    fireEvent.click(screen.getByRole('button', { name: 'Start copy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tools 100.9 are too old');
    expect(onStarted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start copy' })).toBeEnabled();
  });

  it('blocks Start on a strong finding until the user ticks the acknowledge box', async () => {
    const { api, onStarted } = await renderCopy('one', ['orders'], { encryptedSource: true });
    fireEvent.change(screen.getByRole('textbox', { name: 'Target database' }), {
      target: { value: 'shop_copy' },
    });
    await screen.findByText(/Queryable Encryption/);
    const start = screen.getByRole('button', { name: 'Start copy' });
    expect(start).toBeDisabled();

    const acknowledge = screen.getByRole('checkbox', { name: 'I understand' });
    fireEvent.click(acknowledge);
    await waitFor(() => expect(start).toBeEnabled());

    const copyStart = vi.spyOn(api.rpc.copy, 'start');
    fireEvent.click(start);
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(copyStart.mock.calls[0]?.[0]).toMatchObject({
      acknowledged: ['encrypted-collections'],
    });
  });
});
