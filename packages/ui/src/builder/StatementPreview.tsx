import { ActionIcon, Tooltip } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { type ReactNode, useEffect, useState } from 'react';

/**
 * One tint class per token kind. The emitter writes a known shape, so a regex is enough: strings,
 * regex literals, `$operators`, the mongosh constructors and keywords, numbers, and the
 * `db.collection.method` head.
 */
const TOKEN =
  /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\/(?:[^/\\\n]|\\.)+\/[gimsuy]*)|(\$[A-Za-z]+)|(\b(?:ISODate|ObjectId|NumberInt|NumberLong|NumberDecimal|Decimal128|Date|new|true|false|null)\b)|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|(^db(?:\.[A-Za-z_$][\w$]*|\.getCollection\("[^"]*"\))+)/gm;
const TOKEN_KINDS = ['string', 'regex', 'keyword', 'function', 'number', 'key'] as const;

/** The text split into tinted spans and plain text. */
function tintStatement(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index;
    if (index > last) {
      out.push(text.slice(last, index));
    }
    const kind = TOKEN_KINDS.find((_, position) => match[position + 1] !== undefined) ?? 'string';
    out.push(
      <span key={index} data-token={kind === 'regex' ? 'string' : kind}>
        {match[0]}
      </span>,
    );
    last = index + match[0].length;
  }
  if (last < text.length) {
    out.push(text.slice(last));
  }
  return out;
}

export interface StatementPreviewProps {
  /** The mongosh text the panel writes to the editor. */
  readonly text: string;
}

/** The statement the panel writes, read-only, with a copy button. */
export function StatementPreview({ text }: StatementPreviewProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="mg-qb-preview" aria-label="Statement preview">
      <div className="mg-qb-preview-head">
        <span>Written to the editor</span>
        <Tooltip label={copied ? 'Copied' : 'Copy statement'} withArrow>
          <ActionIcon
            variant="subtle"
            size="sm"
            aria-label="Copy statement"
            onClick={() => {
              void navigator.clipboard.writeText(text).then(() => setCopied(true));
            }}
          >
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </ActionIcon>
        </Tooltip>
      </div>
      <pre>{tintStatement(text)}</pre>
    </div>
  );
}
