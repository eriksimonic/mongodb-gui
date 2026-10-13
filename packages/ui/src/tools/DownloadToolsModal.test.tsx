// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppErrorException, appError } from '@mongo-gui/core';
import { renderWithApp } from '../test-support/render';
import { createMockUiApi } from '../api/mock-rpc-client';
import { DownloadToolsModal } from './DownloadToolsModal';

function renderModal(props: { presetVersion?: string; onDone?: (v: string) => void } = {}) {
  const onDone = props.onDone ?? (() => undefined);
  return renderWithApp(
    <DownloadToolsModal
      opened
      onClose={() => undefined}
      onDone={onDone}
      presetVersion={props.presetVersion}
    />,
    { mock: { preset: 'unlocked' } },
  );
}

describe('DownloadToolsModal', () => {
  it('disables installed versions', async () => {
    renderModal();
    fireEvent.click(await screen.findByRole('textbox', { name: 'Version' }));
    const option = await screen.findByRole('option', { name: '100.19.1 (installed)' });
    expect(option).toHaveAttribute('data-combobox-disabled', 'true');
  });

  it('starts with the preset version', async () => {
    renderModal({ presetVersion: '100.15.0' });
    expect(await screen.findByRole('textbox', { name: 'Version' })).toHaveValue('100.15.0');
    expect(await screen.findByText('Download size 56 MB')).toBeInTheDocument();
  });

  it('reports the finished version', async () => {
    const onDone = vi.fn();
    renderModal({ presetVersion: '100.15.0', onDone });
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    expect(
      await screen.findByRole('progressbar', { name: 'Download progress' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('100.15.0'), { timeout: 4000 });
  });

  it('cancels a running download', async () => {
    renderModal({ presetVersion: '100.15.0' });
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
  });

  it('shows a failed start in a red alert', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    vi.spyOn(api.rpc.tools, 'download').mockRejectedValue(
      new AppErrorException(appError('INTERNAL', 'The feed is unreachable.')),
    );
    renderWithApp(
      <DownloadToolsModal
        opened
        onClose={() => undefined}
        onDone={() => undefined}
        presetVersion="100.15.0"
      />,
      { api },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The feed is unreachable.')).toBeInTheDocument();
  });
});
