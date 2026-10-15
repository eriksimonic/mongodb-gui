import { MongoClient } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

const DATABASE = 'profiler_journey';
const COMMENT = 'profiler-journey-query';

test('profiler: enable from the tab, run a query, see the entry', async ({ page, wiring }) => {
  const client = new MongoClient(mongoUriFromEnv());
  try {
    // The database is ours alone. Drop it so a rerun starts clean.
    await client.db(DATABASE).dropDatabase();
    await client
      .db(DATABASE)
      .collection('items')
      .insertMany([0, 1, 2].map((n) => ({ marker: 'profiler-journey', n })));

    await page.goto(wiring.url);
    await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
    await page.getByRole('treeitem', { name: DATABASE, exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Monitoring', exact: true }).hover();
    await page.getByRole('menuitem', { name: 'Open profiler', exact: true }).click();

    // Level All records every operation. Apply sends it to the server, then the button goes idle.
    await page
      .getByRole('radiogroup', { name: 'Profiling level' })
      .getByText('All', { exact: true })
      .click();
    const apply = page.getByRole('button', { name: 'Apply', exact: true });
    await apply.click();
    await expect(apply).toBeDisabled();

    // The server must hold the level the UI set. profile: -1 changes nothing. It only reads the level in was.
    const level = await client.db(DATABASE).command({ profile: -1 });
    expect(level['was']).toBe(2);

    // Run a query with a distinct comment, so the entry is easy to find.
    await client
      .db(DATABASE)
      .collection('items')
      .find({ marker: 'profiler-journey' })
      .comment(COMMENT)
      .toArray();

    // The Slow queries grid shows the entry after Refresh. Search for the comment to narrow it.
    await page.getByRole('textbox', { name: 'Text search', exact: true }).fill(COMMENT);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();

    // Read the entries through a second client, so the check does not trust the UI.
    const profiled = await client
      .db(DATABASE)
      .collection('system.profile')
      .find({ ns: `${DATABASE}.items`, 'command.comment': COMMENT })
      .toArray();
    expect(profiled).toHaveLength(1);

    const grid = page.getByRole('grid', { name: 'Slow operations', exact: true });
    const entries = grid
      .getByRole('row')
      .filter({ has: page.getByRole('gridcell', { name: `${DATABASE}.items`, exact: true }) });
    await expect(entries).toHaveCount(profiled.length);
    await expect(entries.getByRole('gridcell', { name: 'query', exact: true })).toBeVisible();
  } finally {
    // Other journeys share the server. Turn profiling off again.
    await client.db(DATABASE).command({ profile: 0 });
    await client.close();
  }
});
