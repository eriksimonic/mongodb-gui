import { Button, Group, Text } from '@mantine/core';
import { IconArrowUpRight } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { ReadOnlyCode } from '../../editor/ReadOnlyCode';
import { prepareSqlRun, type SqlSampler } from '../../editor/sql-run';

/** How long the SQL must stay unchanged before the preview translates it again. */
const PREVIEW_DELAY_MS = 250;

export interface SqlPreviewProps {
  readonly sql: string;
  readonly sampler: SqlSampler;
  /** Switches the tab to the mongosh. The SQL stays in the tab. */
  readonly onOpenInMongo: () => void;
}

type Preview =
  | { readonly state: 'empty' }
  | { readonly state: 'ok'; readonly mongosh: string }
  | { readonly state: 'error'; readonly message: string };

/**
 * The mongosh of a SQL tab, read only, beside the SQL editor. It follows the text, translated with
 * the sampled field types, so the person sees what runs. The button switches the tab to the mongosh,
 * and the language toggle brings the SQL back.
 */
export function SqlPreview({ sql, sampler, onOpenInMongo }: SqlPreviewProps) {
  const [preview, setPreview] = useState<Preview>({ state: 'empty' });

  useEffect(() => {
    if (sql.trim() === '') {
      return undefined;
    }
    let current = true;
    const timer = setTimeout(() => {
      void prepareSqlRun(sql, sampler).then((plan) => {
        if (current) {
          setPreview(
            plan.ok
              ? { state: 'ok', mongosh: plan.mongosh }
              : { state: 'error', message: plan.message },
          );
        }
      });
    }, PREVIEW_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [sql, sampler]);

  const shown: Preview = sql.trim() === '' ? { state: 'empty' } : preview;

  return (
    <div
      data-testid="sql-preview"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <Group justify="space-between" wrap="nowrap" pb={4}>
        <Text size="xs" c="dimmed" fw={600}>
          Mongo, read only
        </Text>
        <Button
          size="compact-xs"
          variant="default"
          leftSection={<IconArrowUpRight size={12} />}
          disabled={shown.state !== 'ok'}
          onClick={onOpenInMongo}
          title="Switch to Mongo with this query. The SQL stays in the tab."
        >
          Open in Mongo
        </Button>
      </Group>
      <div style={{ flex: 1, minHeight: 0 }}>
        {shown.state === 'ok' ? (
          <ReadOnlyCode label="Mongo query" language="javascript" value={shown.mongosh} wrap />
        ) : (
          <Text size="sm" c={shown.state === 'error' ? 'red' : 'dimmed'} p="xs" role="status">
            {shown.state === 'error'
              ? shown.message
              : 'The Mongo query appears here as you type SQL.'}
          </Text>
        )}
      </div>
    </div>
  );
}
