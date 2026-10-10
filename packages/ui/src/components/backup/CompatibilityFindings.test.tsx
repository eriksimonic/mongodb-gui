// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import type { Finding } from '@mongo-gui/core';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../../test-support/render';
import { CompatibilityFindings } from './CompatibilityFindings';

const strong: Finding = {
  code: 'encrypted-collections',
  severity: 'strong',
  confirmable: false,
  message: 'Encrypted collections are not supported.',
};
const confirmable: Finding = {
  code: 'server-version-mismatch',
  severity: 'block',
  confirmable: true,
  message: 'The versions differ.',
};
const info: Finding = {
  code: 'tools-patch-differs',
  severity: 'info',
  confirmable: false,
  message: 'Patch versions differ.',
};
const warning: Finding = {
  code: 'sharded-dump',
  severity: 'warning',
  confirmable: false,
  message: 'Stop the balancer.',
  action: { kind: 'use-tools', version: '100.19.1' },
};

function renderFindings(findings: Finding[], overrides = {}) {
  const props = {
    findings,
    acknowledged: [],
    onAcknowledge: vi.fn(),
    connectionName: 'Local',
    confirmation: '',
    onConfirmationChange: vi.fn(),
    onUseTools: vi.fn(),
    ...overrides,
  };
  renderWithApp(<CompatibilityFindings {...props} />, { mock: { preset: 'unlocked' } });
  return props;
}

describe('CompatibilityFindings', () => {
  it('orders findings by severity and colours them', () => {
    renderFindings([info, warning, strong, confirmable]);
    const severities = [...document.querySelectorAll('[data-severity]')].map((node) =>
      node.getAttribute('data-severity'),
    );
    expect(severities).toEqual(['block', 'strong', 'warning', 'info']);
    expect(screen.getByText('The versions differ.').closest('.mantine-Alert-root')).toHaveAttribute(
      'data-severity',
      'block',
    );
  });

  it('asks for I understand on a strong finding', () => {
    const props = renderFindings([strong]);
    fireEvent.click(screen.getByLabelText('I understand'));
    expect(props.onAcknowledge).toHaveBeenCalledWith('encrypted-collections', true);
  });

  it('asks for the connection name on a confirmable block', () => {
    const props = renderFindings([confirmable]);
    fireEvent.change(screen.getByLabelText('Type Local to restore anyway'), {
      target: { value: 'Local' },
    });
    expect(props.onConfirmationChange).toHaveBeenCalledWith('Local');
  });

  it('runs the Use action', () => {
    const props = renderFindings([warning]);
    fireEvent.click(screen.getByRole('button', { name: 'Use 100.19.1' }));
    expect(props.onUseTools).toHaveBeenCalledWith('100.19.1');
  });

  it('opens the download dialog from the Download action', async () => {
    renderFindings([{ ...warning, action: { kind: 'download-tools', version: '100.15.0' } }]);
    fireEvent.click(screen.getByRole('button', { name: 'Download 100.15.0' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
