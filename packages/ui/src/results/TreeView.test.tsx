// @vitest-environment jsdom
import '../test-support/browser-shims';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../theme/AppProviders';
import type { JsonObject } from './result-model';
import { TreeView } from './TreeView';

const DOCUMENTS: JsonObject[] = [{ _id: { region: 'eu', seq: 7 }, status: 'paid' }];

function renderTree(onUnsetField = vi.fn(() => Promise.resolve()), onOpenDocument = vi.fn()) {
  render(
    <AppProviders>
      <TreeView
        documents={DOCUMENTS}
        editable
        editabilityNote="Only a plain find can be edited."
        onOpenDocument={onOpenDocument}
        onSetField={() => Promise.resolve()}
        onUnsetField={onUnsetField}
      />
    </AppProviders>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
  return onUnsetField;
}

describe('TreeView actions', () => {
  it('offers Edit and Remove on a top-level field', () => {
    renderTree();
    expect(screen.getByRole('button', { name: 'Edit status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove status' })).toBeInTheDocument();
  });

  it('offers neither Edit nor Remove on _id or on a sub-field of a compound _id', () => {
    renderTree();
    expect(screen.queryByRole('button', { name: 'Edit _id' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove _id' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit _id.region' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove _id.seq' })).toBeNull();
  });

  it('asks for confirmation before removing a field, and removes it on confirm', async () => {
    const onUnsetField = renderTree();
    fireEvent.click(screen.getByRole('button', { name: 'Remove status' }));
    expect(onUnsetField).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Remove field' });
    expect(dialog).toHaveTextContent('Remove status from document 1');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(onUnsetField).toHaveBeenCalledWith(0, 'status'));
  });

  it('does not remove the field when the confirmation is cancelled', async () => {
    const onUnsetField = renderTree();
    fireEvent.click(screen.getByRole('button', { name: 'Remove status' }));
    await screen.findByRole('dialog', { name: 'Remove field' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onUnsetField).not.toHaveBeenCalled();
  });
});

describe('TreeView double-click', () => {
  it('opens the document when its top-level row is double-clicked', () => {
    const onOpenDocument = vi.fn();
    renderTree(undefined, onOpenDocument);

    fireEvent.doubleClick(screen.getByRole('treeitem', { name: '#1' }));

    expect(onOpenDocument).toHaveBeenCalledWith(0);
  });

  it('keeps the inline edit on a leaf and does not open the document', () => {
    const onOpenDocument = vi.fn();
    renderTree(undefined, onOpenDocument);

    fireEvent.doubleClick(screen.getByText('status'));

    expect(onOpenDocument).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'New value for status' })).toBeInTheDocument();
  });

  it('does not open the document from a button in the top-level row', () => {
    const onOpenDocument = vi.fn();
    renderTree(undefined, onOpenDocument);

    // The document row has an empty path, so its copy button reads "Copy path" with no suffix.
    fireEvent.doubleClick(screen.getAllByRole('button', { name: /^Copy path/ })[0] as HTMLElement);

    expect(onOpenDocument).not.toHaveBeenCalled();
  });
});
