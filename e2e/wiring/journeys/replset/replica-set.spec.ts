import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

interface ReplSetStatus {
  set: string;
  members: { name: string; stateStr: string }[];
}

test('replica set: connect and see the members', async ({ page, wiring }) => {
  // Read the members through a second client, so the check does not trust the UI.
  const client = new MongoClient(mongoUriFromEnv());
  let status: ReplSetStatus;
  try {
    status = (await client.db('admin').command({ replSetGetStatus: 1 })) as ReplSetStatus;
  } finally {
    await client.close();
  }
  expect(status.members).toHaveLength(3);
  for (const member of status.members) {
    expect(['PRIMARY', 'SECONDARY']).toContain(member.stateStr);
  }

  await page.goto(wiring.url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  // The connection goes through the replica set URI. Its databases show once it is connected.
  await expect(page.getByRole('treeitem', { name: 'shop', exact: true })).toBeVisible();

  // Replica set sits under Administration. The item is enabled once the topology is known.
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Administration', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Replica set', exact: true }).click();

  await expect(
    page.getByRole('heading', { name: `Replica set ${status.set}`, exact: true }),
  ).toBeVisible();
  // The members table is the only table in the panel.
  const table = page.getByRole('table');
  for (const member of status.members) {
    const row = table.getByRole('row').filter({ hasText: member.name });
    await expect(row).toHaveCount(1);
    // The panel shows Primary or Secondary, not the raw state.
    const label = member.stateStr === 'PRIMARY' ? 'Primary' : 'Secondary';
    await expect(row.getByText(label, { exact: true })).toBeVisible();
  }
});
