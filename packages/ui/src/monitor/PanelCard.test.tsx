// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../test-support/render';
import { PanelMenu } from './PanelCard';

describe('PanelMenu', () => {
  it('offers the description and close, and runs them', () => {
    const onClose = vi.fn();
    const onAbout = vi.fn();
    renderWithApp(<PanelMenu title="Memory" onClose={onClose} onAbout={onAbout} />);
    fireEvent.click(screen.getByRole('button', { name: 'Options for Memory' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'About this panel' }));
    expect(onAbout).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Options for Memory' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close panel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
