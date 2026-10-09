// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../test-support/render';
import { PanelMenu } from './PanelCard';

function renderMenu(move: { left?: () => void; right?: () => void }) {
  renderWithApp(
    <PanelMenu
      title="Memory"
      width={1}
      tall={false}
      onClose={vi.fn()}
      onWidth={vi.fn()}
      onHeight={vi.fn()}
      onAbout={vi.fn()}
      onMoveLeft={move.left}
      onMoveRight={move.right}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Options for Memory' }));
}

describe('PanelMenu move items', () => {
  it('enables both moves in the middle of the dashboard and runs them', () => {
    const left = vi.fn();
    const right = vi.fn();
    renderMenu({ left, right });
    expect(screen.getByRole('menuitem', { name: 'Move left' })).not.toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Move right' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move right' }));
    // The menu closes after an item runs, so reopen it for the other move.
    fireEvent.click(screen.getByRole('button', { name: 'Options for Memory' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move left' }));
    expect(left).toHaveBeenCalledTimes(1);
    expect(right).toHaveBeenCalledTimes(1);
  });

  it('disables Move left for the first panel', () => {
    renderMenu({ right: vi.fn() });
    expect(screen.getByRole('menuitem', { name: 'Move left' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Move right' })).not.toBeDisabled();
  });

  it('disables Move right for the last panel', () => {
    renderMenu({ left: vi.fn() });
    expect(screen.getByRole('menuitem', { name: 'Move left' })).not.toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Move right' })).toBeDisabled();
  });
});
