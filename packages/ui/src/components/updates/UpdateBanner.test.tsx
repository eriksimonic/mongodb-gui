// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { UpdateState } from '@mongo-gui/core';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../../test-support/render';
import { UpdateBanner } from './UpdateBanner';

const RELEASE_URL = 'https://github.com/eriksimonic/mongodb-mager/releases/tag/v0.2.0';
const BASE = { current: '0.1.0', canInstall: true };
const AVAILABLE_INFO = { version: '0.2.0', downloadUrl: RELEASE_URL };

const available: UpdateState = { ...BASE, phase: 'available', available: AVAILABLE_INFO };
const notifyOnly: UpdateState = { ...BASE, phase: 'notify-only', available: AVAILABLE_INFO };
const downloading: UpdateState = {
  ...BASE,
  phase: 'downloading',
  available: AVAILABLE_INFO,
  progress: { percent: 40 },
};
const downloaded: UpdateState = { ...BASE, phase: 'downloaded', available: AVAILABLE_INFO };
const failed: UpdateState = {
  ...BASE,
  phase: 'error',
  error: { code: 'INTERNAL', message: 'Could not check for updates.' },
};
const idle: UpdateState = { ...BASE, phase: 'idle', lastCheckedAt: '2026-10-09T12:00:00.000Z' };

describe('UpdateBanner', () => {
  it('shows the version, release notes, download and dismiss for an installable update', async () => {
    renderWithApp(<UpdateBanner />, { mock: { updates: { states: [available] } } });

    expect(await screen.findByText('Version 0.2.0 is available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Release notes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download from GitHub' })).toBeNull();
  });

  it('shows the release notes as plain text in a popover when the update has notes', async () => {
    renderWithApp(<UpdateBanner />, {
      mock: {
        updates: {
          states: [
            {
              ...BASE,
              phase: 'available',
              available: { ...AVAILABLE_INFO, notes: 'Fixed <b>login</b>.' },
            },
          ],
        },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Release notes' }));

    expect(await screen.findByText('Fixed <b>login</b>.')).toBeInTheDocument();
    expect(screen.getByText('Fixed <b>login</b>.').querySelector('b')).toBeNull();
  });

  it('retries a failed download by downloading again', async () => {
    const failedDownload: UpdateState = {
      ...BASE,
      phase: 'error',
      available: AVAILABLE_INFO,
      error: { code: 'INTERNAL', message: 'Could not download the update.' },
    };
    const { api } = renderWithApp(<UpdateBanner />, {
      mock: { updates: { states: [failedDownload, downloading] } },
    });
    const download = vi.spyOn(api.rpc.updates, 'download');
    const check = vi.spyOn(api.rpc.updates, 'check');

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Downloading version 0.2.0, 40%')).toBeInTheDocument();
    expect(download).toHaveBeenCalledTimes(1);
    expect(check).not.toHaveBeenCalled();
  });

  it('starts the download and shows progress', async () => {
    renderWithApp(<UpdateBanner />, {
      mock: { updates: { states: [available, downloading] } },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));

    expect(await screen.findByText('Downloading version 0.2.0, 40%')).toBeInTheDocument();
    expect(screen.getByLabelText('Download progress')).toBeInTheDocument();
  });

  it('opens the release page from the notify-only link', async () => {
    const { api } = renderWithApp(<UpdateBanner />, {
      mock: { updates: { states: [notifyOnly] } },
    });
    const openExternal = vi.spyOn(api.rpc.app, 'openExternal');

    fireEvent.click(await screen.findByRole('button', { name: 'Download from GitHub' }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith({ url: RELEASE_URL }));
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    // The notify-only banner has one link to GitHub, so it has no second release notes button.
    expect(screen.queryByRole('button', { name: 'Release notes' })).toBeNull();
  });

  it('opens the release page from release notes', async () => {
    const { api } = renderWithApp(<UpdateBanner />, {
      mock: { updates: { states: [available] } },
    });
    const openExternal = vi.spyOn(api.rpc.app, 'openExternal');

    fireEvent.click(await screen.findByRole('button', { name: 'Release notes' }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith({ url: RELEASE_URL }));
  });

  it('offers a restart once the update is downloaded, and Later hides it', async () => {
    renderWithApp(<UpdateBanner />, {
      mock: { updates: { states: [downloaded, idle] } },
    });

    expect(await screen.findByText('Version 0.2.0 is ready to install')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart to update' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(screen.queryByText('Version 0.2.0 is ready to install')).toBeNull());
  });

  it('dismisses an available update', async () => {
    renderWithApp(<UpdateBanner />, {
      mock: { updates: { states: [available, idle] } },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(screen.queryByText('Version 0.2.0 is available')).toBeNull());
  });

  it('shows a compact error and retries the check', async () => {
    renderWithApp(<UpdateBanner />, {
      mock: { updates: { states: [failed, idle] } },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check for updates.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('renders nothing while idle', async () => {
    renderWithApp(<UpdateBanner />, { mock: { updates: { states: [idle] } } });
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders nothing in a development build', async () => {
    renderWithApp(<UpdateBanner />, {
      mock: { updates: { states: [{ ...BASE, phase: 'dev' }] } },
    });
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
    expect(screen.queryByRole('status')).toBeNull();
  });
});
