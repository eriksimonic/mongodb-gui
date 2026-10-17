import type { Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

// A secondary with no tags in the stack. The journeys never change its votes or priority, and
// they never step down or elect a new primary.
const MEMBER = '127.0.0.1:27033';
const PRIMARY = '127.0.0.1:27031';

interface ReplMember {
  _id: number;
  host: string;
  tags: Record<string, string>;
}

interface ReplConfig {
  _id: string;
  version: number;
  members: ReplMember[];
}

interface ReplSetStatus {
  members: { name: string; stateStr: string }[];
}

async function readConfig(client: MongoClient): Promise<ReplConfig> {
  const reply = (await client.db('admin').command({ replSetGetConfig: 1 })) as {
    config: ReplConfig;
  };
  return reply.config;
}

function memberOf(config: ReplConfig): ReplMember {
  const member = config.members.find((item) => item.host === MEMBER);
  if (member === undefined) {
    throw new Error(`The set has no member ${MEMBER}`);
  }
  return member;
}

/** Connects to Local dev and opens the Replica set panel from the Administration menu. */
async function openReplicaSetPanel(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: 'shop', exact: true })).toBeVisible();

  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Administration', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Replica set', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Replica set /, level: 4 })).toBeVisible();
}

test('replica set: a tag dry run that is cancelled changes nothing', async ({ page, wiring }) => {
  const client = new MongoClient(mongoUriFromEnv());
  try {
    const before = await readConfig(client);

    await openReplicaSetPanel(page, wiring.url);
    await page
      .getByRole('row')
      .filter({ hasText: MEMBER })
      .getByRole('button', { name: /^Actions for / })
      .click();
    await page.getByRole('menuitem', { name: /^Edit member/ }).click();

    const dialog = page.getByRole('dialog', { name: /^Edit member/ });
    await dialog.getByRole('button', { name: 'Add tag', exact: true }).click();
    await dialog.getByLabel('Tag 1 key').fill('e2e');
    await dialog.getByLabel('Tag 1 value').fill('wiring');
    await expect(dialog.getByLabel('Change preview')).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();

    // Nothing was sent to the server, so the version and the member tags stay as they were.
    const after = await readConfig(client);
    expect(after.version).toBe(before.version);
    expect(memberOf(after).tags).toEqual(memberOf(before).tags);
  } finally {
    await client.close();
  }
});

test('replica set: apply a tag change to a member', async ({ page, wiring }) => {
  const client = new MongoClient(mongoUriFromEnv());
  try {
    const before = await readConfig(client);

    await openReplicaSetPanel(page, wiring.url);
    await page
      .getByRole('row')
      .filter({ hasText: MEMBER })
      .getByRole('button', { name: /^Actions for / })
      .click();
    await page.getByRole('menuitem', { name: /^Edit member/ }).click();

    const dialog = page.getByRole('dialog', { name: /^Edit member/ });
    await dialog.getByRole('button', { name: 'Add tag', exact: true }).click();
    await dialog.getByLabel('Tag 1 key').fill('e2e');
    await dialog.getByLabel('Tag 1 value').fill('wiring');
    await expect(dialog.getByLabel('Change preview')).toBeVisible();

    // Apply stays disabled until the set name is typed. The set name is the config id.
    await dialog.getByLabel(`Type ${before._id} to confirm`).fill(before._id);
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();

    // The apply runs on the server after the click, so the side-channel read waits for it.
    await expect.poll(async () => memberOf(await readConfig(client)).tags.e2e).toBe('wiring');
    const after = await readConfig(client);
    expect(after.version).toBeGreaterThan(before.version);

    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('row').filter({ hasText: MEMBER }).getByText('e2e=wiring', { exact: true }),
    ).toBeVisible();
  } finally {
    try {
      // Remove the tag through the side channel, so the shared stack keeps its original tags.
      // The check runs only when the tag is there, so a test that failed before Apply does not
      // reconfigure the set.
      const config = await readConfig(client);
      const member = memberOf(config);
      if (member.tags.e2e !== undefined) {
        delete member.tags.e2e;
        await client
          .db('admin')
          .command({ replSetReconfig: { ...config, version: config.version + 1 } });
      }

      const status = (await client.db('admin').command({ replSetGetStatus: 1 })) as ReplSetStatus;
      expect(status.members.find((item) => item.name === PRIMARY)?.stateStr).toBe('PRIMARY');
    } finally {
      await client.close();
    }
  }
});
