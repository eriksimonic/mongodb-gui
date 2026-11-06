// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoot } from '../AppRoot';
import { createMockUiApi } from '../api/mock-rpc-client';
import { renderWithApp } from '../test-support/render';
import { TypedNameConfirm } from './TypedNameConfirm';

describe('TypedNameConfirm', () => {
  it('reports a match only when the typed text equals the expected name exactly', () => {
    const onMatchChange = vi.fn();
    renderWithApp(<TypedNameConfirm expected="shop" onMatchChange={onMatchChange} />);
    const input = screen.getByLabelText('Type shop to confirm');
    expect(onMatchChange).toHaveBeenLastCalledWith(false);

    fireEvent.change(input, { target: { value: 'sho' } });
    expect(onMatchChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(input, { target: { value: 'Shop' } });
    expect(onMatchChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(input, { target: { value: 'shop ' } });
    expect(onMatchChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(input, { target: { value: 'shop' } });
    expect(onMatchChange).toHaveBeenLastCalledWith(true);
  });

  it('reports no match again when the expected name changes', () => {
    const onMatchChange = vi.fn();
    const api = createMockUiApi();
    const view = (expected: string) => (
      <AppRoot api={api}>
        <TypedNameConfirm expected={expected} onMatchChange={onMatchChange} />
      </AppRoot>
    );
    const { rerender } = render(view('shop'));
    fireEvent.change(screen.getByLabelText('Type shop to confirm'), {
      target: { value: 'shop' },
    });
    expect(onMatchChange).toHaveBeenLastCalledWith(true);

    rerender(view('shop_copy'));
    expect(onMatchChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByLabelText('Type shop_copy to confirm')).toHaveValue('shop');
  });

  it('never reports a match for an empty expected name', () => {
    const onMatchChange = vi.fn();
    renderWithApp(<TypedNameConfirm expected="" onMatchChange={onMatchChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
    expect(onMatchChange).toHaveBeenCalledWith(false);
    expect(onMatchChange).not.toHaveBeenCalledWith(true);
  });

  it('reports no match when it unmounts after a match', () => {
    const onMatchChange = vi.fn();
    const { unmount } = renderWithApp(
      <TypedNameConfirm expected="shop" onMatchChange={onMatchChange} />,
    );
    fireEvent.change(screen.getByLabelText('Type shop to confirm'), {
      target: { value: 'shop' },
    });
    expect(onMatchChange).toHaveBeenLastCalledWith(true);

    unmount();
    expect(onMatchChange).toHaveBeenLastCalledWith(false);
  });
});
