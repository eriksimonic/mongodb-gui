// @vitest-environment jsdom
import '../../test-support/browser-shims';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { IndexInfo } from '@mongo-gui/core';
import { connectedMockApi } from '../../api/connected-mock';
import { localConnectionId } from '../../api/mock-fixtures';
import { indexScenarios } from '../../api/mock-index-scenarios';
import { renderWithApp } from '../../test-support/render';
import { IndexesPanel } from './IndexesPanel';

vi.mock('../../editor/JsonEditor', () => import('../../test-support/json-editor-stub'));

const panel = { connectionId: localConnectionId, database: 'shop', collection: 'orders' };
const NAME_COLUMN = 0;
const KEYS_COLUMN = 1;
const PROPERTIES_COLUMN = 2;
const SIZE_COLUMN = 3;
const USAGE_COLUMN = 4;

/** The rows the panel shows for the scenarios. The row is found by its name cell. */
async function renderScenarios(indexes: readonly IndexInfo[] = indexScenarios) {
  const api = await connectedMockApi();
  vi.spyOn(api.rpc.collections, 'indexes').mockResolvedValue([...indexes]);
  renderWithApp(<IndexesPanel {...panel} />, { api });
  return api;
}

async function rowOf(name: string): Promise<HTMLElement> {
  const cell = await screen.findByText(name, { selector: 'td' });
  const row = cell.closest('tr');
  if (row === null) {
    throw new Error(`no row for ${name}`);
  }
  return row;
}

function cellOf(row: HTMLElement, column: number): HTMLElement {
  const cell = row.querySelectorAll<HTMLElement>('td')[column];
  if (cell === undefined) {
    throw new Error(`row has no column ${column}`);
  }
  return cell;
}

interface ShownKey {
  readonly text: string;
  readonly direction: string | undefined;
}

/** What the Keys cell shows. A direction is the aria-label of its arrow icon. */
function shownKeys(row: HTMLElement): ShownKey[] {
  return Array.from(cellOf(row, KEYS_COLUMN).querySelectorAll('.mantine-Badge-root')).map(
    (badge) => ({
      text: (badge.textContent ?? '').trim(),
      direction: badge.querySelector('svg[aria-label]')?.getAttribute('aria-label') ?? undefined,
    }),
  );
}

/**
 * The key spec in key order. A text index comes from the server as `_fts` and `_ftsx`, which show
 * as the weighted fields.
 */
function expectedKeys(index: IndexInfo): ShownKey[] {
  return Object.entries(index.key).flatMap(([field, value]): ShownKey[] => {
    if (field === '_ftsx') {
      return [];
    }
    if (field === '_fts') {
      return Object.keys(index.weights ?? {}).map((weighted) => ({
        text: `${weighted} text`,
        direction: undefined,
      }));
    }
    if (value === 1) {
      return [{ text: field, direction: 'ascending' }];
    }
    if (value === -1) {
      return [{ text: field, direction: 'descending' }];
    }
    return [{ text: `${field} ${value}`, direction: undefined }];
  });
}

function shownBadges(row: HTMLElement): string[] {
  return Array.from(cellOf(row, PROPERTIES_COLUMN).querySelectorAll('.mantine-Badge-root'))
    .map((badge) => (badge.textContent ?? '').trim())
    .sort();
}

function scenario(name: string): IndexInfo {
  const found = indexScenarios.find((index) => index.name === name);
  if (found === undefined) {
    throw new Error(`no scenario named ${name}`);
  }
  return found;
}

describe('IndexesPanel scenarios: names and keys', () => {
  it.each(indexScenarios.map((index) => [index.name, index] as const))(
    'shows the name and every key field with its direction or type for %s',
    async (_name, index) => {
      await renderScenarios();
      const row = await rowOf(index.name);
      expect(cellOf(row, NAME_COLUMN).textContent).toBe(index.name);
      expect(shownKeys(row)).toEqual(expectedKeys(index));
    },
  );

  it('shows the size with a unit and the usage for each scenario that has them', async () => {
    await renderScenarios();
    expect(cellOf(await rowOf('_id_'), SIZE_COLUMN).textContent).toBe('20.0 KB');
    expect(cellOf(await rowOf('status_1_createdAt_-1_customerId_1'), SIZE_COLUMN).textContent).toBe(
      '36.0 KB',
    );
    expect(cellOf(await rowOf('createdAt_-1'), USAGE_COLUMN).textContent).toBe(
      '0 ops since 2026-10-01',
    );
    expect(
      cellOf(await rowOf('status_1_createdAt_-1_customerId_1'), USAGE_COLUMN).textContent,
    ).toBe('412 ops since 2026-10-01');
    expect(cellOf(await rowOf('status_1'), USAGE_COLUMN).textContent).toBe('No usage data');
  });

  it('shows the long name in full and the eight keys in order', async () => {
    await renderScenarios();
    const long = scenario(
      'orders_status_1_customerId_1_createdAt_-1_shippingRegion_1_totalCents_-1_currency_1_channel_1_warehouseCode_1',
    );
    const row = await rowOf(long.name);
    expect(cellOf(row, NAME_COLUMN).textContent).toBe(long.name);
    expect(shownKeys(row)).toHaveLength(8);
    expect(shownKeys(row).map((key) => key.text)).toEqual(Object.keys(long.key));
  });

  it('keeps the _id index without a drop, a hide or an edit action', async () => {
    await renderScenarios();
    const row = await rowOf('_id_');
    expect(within(row).getByRole('button', { name: 'Drop' })).toBeDisabled();
    expect(within(row).getByRole('button', { name: 'Hide' })).toBeDisabled();
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeDisabled();
  });

  it('offers Drop, Hide and Edit on every other scenario', async () => {
    await renderScenarios();
    const row = await rowOf('email_1');
    expect(within(row).getByRole('button', { name: 'Drop' })).toBeEnabled();
    expect(within(row).getByRole('button', { name: 'Hide' })).toBeEnabled();
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeEnabled();
  });

  it('labels a hidden index with Unhide', async () => {
    await renderScenarios();
    const row = await rowOf('legacyRef_1');
    expect(within(row).getByRole('button', { name: 'Unhide' })).toBeEnabled();
  });
});

interface BadgeCase {
  readonly name: string;
  readonly badges: readonly string[];
}

const BADGE_CASES: readonly BadgeCase[] = [
  { name: '_id_', badges: [] },
  { name: 'status_1', badges: [] },
  { name: 'createdAt_-1', badges: [] },
  { name: 'status_1_createdAt_-1_customerId_1', badges: [] },
  { name: 'email_1', badges: ['Unique'] },
  { name: 'nickname_1', badges: ['Sparse'] },
  { name: 'total_1', badges: ['Partial'] },
  { name: 'lastSeen_1', badges: ['TTL 3600 s'] },
  { name: 'expiresAt_1', badges: ['TTL 0 s'] },
  { name: 'title_text_body_text', badges: ['Text'] },
  {
    name: 'notes_text_server_shape',
    badges: ['Text'],
  },
  { name: 'location_2dsphere', badges: ['Geo'] },
  { name: 'legacyPoint_2d', badges: ['Geo'] },
  { name: 'customerId_hashed', badges: ['Hashed'] },
  { name: '$**_1', badges: ['Wildcard'] },
  { name: 'all_wildcard_projected', badges: ['Wildcard'] },
  { name: 'attributes.$**_1', badges: ['Wildcard'] },
  { name: 'attributes_wildcard_projected', badges: ['Wildcard'] },
  { name: 'name_1', badges: ['Collation en'] },
  { name: 'legacyRef_1', badges: ['Hidden'] },
  { name: 'taxId_1', badges: ['Sparse', 'Unique'] },
  { name: 'sessionId_1_combo', badges: ['Partial', 'TTL 900 s', 'Unique'] },
  { name: 'tenant_1', badges: [] },
  { name: 'region_1', badges: [] },
  { name: 'shipping.address.postalCode_1', badges: [] },
  {
    name: 'orders_status_1_customerId_1_createdAt_-1_shippingRegion_1_totalCents_-1_currency_1_channel_1_warehouseCode_1',
    badges: [],
  },
];

describe('IndexesPanel scenarios: property badges', () => {
  it('has a badge case for every scenario', () => {
    expect(BADGE_CASES.map((item) => item.name).sort()).toEqual(
      indexScenarios.map((index) => index.name).sort(),
    );
  });

  it.each(BADGE_CASES.map((item) => [item.name, item] as const))(
    'shows exactly the property badges that apply to %s',
    async (_name, item) => {
      await renderScenarios();
      const row = await rowOf(item.name);
      expect(shownBadges(row)).toEqual([...item.badges].sort());
    },
  );

  it('shows the weighted fields of a text index, not the _fts and _ftsx keys the server reports', async () => {
    await renderScenarios();
    const row = await rowOf('notes_text_server_shape');
    expect(shownKeys(row).map((key) => key.text)).toContain('notes text');
  });

  it('shows no size for an index the server reports without one, not 0 B', async () => {
    await renderScenarios();
    const row = await rowOf('region_1');
    expect(cellOf(row, SIZE_COLUMN).textContent).not.toBe('0 bytes');
  });
});

describe('IndexesPanel scenarios: edit dialog pre-fills existing options', () => {
  async function openEdit(name: string): Promise<void> {
    const row = await rowOf(name);
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    expect(await screen.findByText(`Edit index ${name}`)).toBeInTheDocument();
  }

  function previewOf(): Record<string, unknown> {
    const preview = screen.getByLabelText('createIndexes command preview') as HTMLTextAreaElement;
    return JSON.parse(preview.value) as Record<string, unknown>;
  }

  it('pre-fills the TTL seconds and the key of a TTL index', async () => {
    await renderScenarios();
    await openEdit('lastSeen_1');
    expect(screen.getByRole('textbox', { name: 'Field 1' })).toHaveValue('lastSeen');
    expect(screen.getByRole('textbox', { name: 'Order of field 1' })).toHaveValue('Ascending (1)');
    expect(screen.getByLabelText('Expire after seconds (TTL)')).toHaveValue('3600');
    expect(previewOf()).toEqual({
      createIndexes: 'orders',
      indexes: [{ key: { lastSeen: 1 }, name: 'lastSeen_1', expireAfterSeconds: 3600 }],
    });
  });

  it('pre-fills the partial filter of a partial index', async () => {
    await renderScenarios();
    await openEdit('total_1');
    expect(screen.getByLabelText('Partial filter expression as EJSON')).toHaveValue(
      '{"status":"paid"}',
    );
    expect(previewOf()).toEqual({
      createIndexes: 'orders',
      indexes: [
        { key: { total: 1 }, name: 'total_1', partialFilterExpression: { status: 'paid' } },
      ],
    });
  });

  it('pre-fills the collation of a collation index', async () => {
    await renderScenarios();
    await openEdit('name_1');
    expect(screen.getByLabelText('Collation as EJSON')).toHaveValue('{"locale":"en","strength":2}');
    expect(previewOf()).toEqual({
      createIndexes: 'orders',
      indexes: [{ key: { name: 1 }, name: 'name_1', collation: { locale: 'en', strength: 2 } }],
    });
  });

  it('pre-fills the wildcard projection of a wildcard index', async () => {
    await renderScenarios();
    await openEdit('all_wildcard_projected');
    expect(screen.getByRole('textbox', { name: 'Field 1' })).toHaveValue('$**');
    expect(screen.getByLabelText('Wildcard projection as EJSON')).toHaveValue(
      '{"name":1,"attributes":1}',
    );
  });

  it('leaves the wildcard projection empty for a $** index without one', async () => {
    await renderScenarios();
    await openEdit('$**_1');
    expect(screen.getByLabelText('Wildcard projection as EJSON')).toHaveValue('');
  });

  it('pre-fills the text weights and language of a text index', async () => {
    await renderScenarios();
    await openEdit('title_text_body_text');
    expect(screen.getByLabelText('Text weights')).toHaveValue('title: 10\nbody: 1');
    expect(screen.getByLabelText('Default language')).toHaveValue('english');
  });

  it('pre-fills the unique, sparse and hidden flags', async () => {
    await renderScenarios();
    await openEdit('taxId_1');
    expect(screen.getByLabelText('Unique')).toBeChecked();
    expect(screen.getByLabelText('Sparse')).toBeChecked();
    expect(screen.getByLabelText('Hidden')).not.toBeChecked();
  });
});
