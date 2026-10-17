import type { Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

interface ReplSetStatus {
  set: string;
  members: { name: string; stateStr: string }[];
}

interface ConfigMember {
  host: string;
  priority?: number;
  votes?: number;
  hidden?: boolean;
  secondaryDelaySecs?: number;
  tags?: Record<string, string>;
}

interface ReplSetConfigReply {
  config: { members: ConfigMember[] };
}

/** Opens the replica set panel of Local dev from its menu, as the first replica set journey does. */
async function openReplicaSetPanel(page: Page): Promise<void> {
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Administration', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Replica set', exact: true }).click();
}

test('replica set: member priority, votes, hidden, delay and tags match the config', async ({
  page,
  wiring,
}) => {
  // Read the configuration through a second client, so the check does not trust the UI.
  const client = new MongoClient(mongoUriFromEnv());
  let members: ConfigMember[];
  try {
    const reply = (await client.db('admin').command({ replSetGetConfig: 1 })) as ReplSetConfigReply;
    members = reply.config.members;
  } finally {
    await client.close();
  }
  expect(members).toHaveLength(3);

  await page.goto(wiring.url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: 'shop', exact: true })).toBeVisible();
  await openReplicaSetPanel(page);

  // Find the columns by their headers, so the check does not depend on the column order.
  const table = page.getByRole('table');
  const headers = await table.getByRole('columnheader').allTextContents();
  const column = (label: string) => headers.indexOf(label);

  for (const member of members) {
    const row = table.getByRole('row').filter({ hasText: member.host });
    await expect(row).toHaveCount(1);
    // Defaults match the server: priority 1, votes 1, no delay, no tags, not hidden.
    const tags = Object.entries(member.tags ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join('');
    const expected: [string, string][] = [
      ['Priority', String(member.priority ?? 1)],
      ['Votes', String(member.votes ?? 1)],
      ['Hidden', member.hidden === true ? 'Yes' : 'No'],
      ['Delay', `${member.secondaryDelaySecs ?? 0} s`],
      ['Tags', tags === '' ? '–' : tags],
    ];
    for (const [label, value] of expected) {
      await expect(row.getByRole('cell').nth(column(label))).toHaveText(value);
    }
  }
});

test('replica set: connect directly to a secondary from its member row', async ({
  page,
  wiring,
}) => {
  // Pick the secondary from the server, not from the UI. The primary is never the target.
  const client = new MongoClient(mongoUriFromEnv());
  let secondary: string | undefined;
  try {
    const status = (await client.db('admin').command({ replSetGetStatus: 1 })) as ReplSetStatus;
    secondary = status.members
      .filter((member) => member.stateStr === 'SECONDARY')
      .map((member) => member.name)
      .sort()[0];
  } finally {
    await client.close();
  }
  expect(secondary).toBeDefined();
  const host = secondary ?? '';
  const directName = `Local dev · ${host}`;

  await page.goto(wiring.url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  // The replica set node lists the members under the connection. Their rows show by host.
  const member = page.getByRole('treeitem', { name: host, exact: true });
  await expect(member).toBeVisible();

  await member.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect directly', exact: true }).click();

  // The new connection is named after the parent and the host. It opens with its own databases,
  // so the flat tree lists shop twice: once under Local dev and once under the direct connection.
  await expect(page.getByRole('treeitem', { name: directName, exact: true })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'shop', exact: true })).toHaveCount(2);

  // Check the member through a client that connects to that host only.
  const direct = new MongoClient(`mongodb://${host}/?directConnection=true`);
  try {
    const hello = await direct.db('admin').command({ hello: 1 });
    expect(hello).toMatchObject({ secondary: true, isWritablePrimary: false });
    const { databases } = await direct.db('admin').admin().listDatabases();
    expect(databases.map((database) => database.name)).toContain('shop');
  } finally {
    await direct.close();
  }
});

test('replica set: freeze a secondary from its direct connection, the log shows it', async ({
  page,
  wiring,
}) => {
  // Pick a secondary from the server. Freeze never targets the primary.
  const client = new MongoClient(mongoUriFromEnv());
  let secondary: string | undefined;
  try {
    const status = (await client.db('admin').command({ replSetGetStatus: 1 })) as ReplSetStatus;
    secondary = status.members
      .filter((member) => member.stateStr === 'SECONDARY')
      .map((member) => member.name)
      .sort()[0];
  } finally {
    await client.close();
  }
  expect(secondary).toBeDefined();
  const host = secondary ?? '';
  const directName = `Local dev · ${host}`;
  const direct = new MongoClient(`mongodb://${host}/?directConnection=true`);

  try {
    // The log is a ring buffer, so count the freeze lines before the action. A line from an
    // earlier run then cannot make the check pass.
    const freezeLines = async (): Promise<string[]> => {
      const reply = (await direct.db('admin').command({ getLog: 'global' })) as { log: string[] };
      // The member logs a JSON line with msg "Freezing" and attr freezeSecs.
      return reply.log.filter((line) => line.includes('"msg":"Freezing"'));
    };
    const before = await freezeLines();

    await page.goto(wiring.url);
    await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
    await page.getByRole('treeitem', { name: host, exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Connect directly', exact: true }).click();
    await expect(page.getByRole('treeitem', { name: directName, exact: true })).toBeVisible();

    // Open the replica set panel of the direct connection. Its own member row gets Freeze.
    await page.getByRole('treeitem', { name: directName, exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Administration', exact: true }).hover();
    await page.getByRole('menuitem', { name: 'Replica set', exact: true }).click();
    const table = page.getByRole('table');
    await expect(table.getByRole('row').filter({ hasText: host })).toHaveCount(1);
    await table
      .getByRole('row')
      .filter({ hasText: host })
      .getByRole('button', { name: /^Actions for / })
      .click();
    await page.getByRole('menuitem', { name: /^Freeze/ }).click();

    const dialog = page.getByRole('dialog', { name: 'Freeze member' });
    await dialog.getByLabel('Seconds', { exact: true }).fill('30');
    await dialog.getByRole('button', { name: 'Freeze', exact: true }).click();
    // A success closes the dialog. A failure would keep it open with an error.
    await expect(dialog).toBeHidden();

    // The freeze reply reaches the page only after the member has applied it, so one read is enough.
    // On failure the message shows the last log lines, so the expected text can be found.
    const added = (await freezeLines()).slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain('"freezeSecs":30');
  } finally {
    try {
      await direct.db('admin').command({ replSetFreeze: 0 });
    } finally {
      await direct.close();
    }
  }
});
