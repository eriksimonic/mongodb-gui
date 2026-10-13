import { fireEvent, screen } from '@testing-library/react';

/** Opens a submenu of an open menu. Its items are not in the DOM until the pointer is over it. */
export async function openSubmenu(label: string): Promise<void> {
  fireEvent.mouseEnter(await screen.findByRole('menuitem', { name: label, hidden: true }));
}
