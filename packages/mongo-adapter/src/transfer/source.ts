import { createReadStream, type ReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createCsvParser, type CsvOptions } from '@mongo-gui/core';
import { validationError } from '../management/errors';

const BYTE_ORDER_MARK = '\uFEFF';
const BYTE_ORDER_MARK_PATTERN = /^\uFEFF/;
const READ_CHUNK_BYTES = 1024 * 1024;
export const HEAD_BYTES = 64 * 1024;

export interface TextSource {
  readonly chunks: AsyncIterable<string>;
  bytesRead(): number;
  close(): void;
}

// Streams a file as UTF-8 text. A leading byte order mark is removed.
export function openTextSource(path: string): TextSource {
  const stream: ReadStream = createReadStream(path, {
    encoding: 'utf8',
    highWaterMark: READ_CHUNK_BYTES,
  });
  return {
    chunks: stripByteOrderMark(stream),
    bytesRead: () => stream.bytesRead,
    close: () => {
      stream.destroy();
    },
  };
}

async function* stripByteOrderMark(stream: AsyncIterable<string>): AsyncGenerator<string> {
  let first = true;
  for await (const chunk of stream) {
    if (first) {
      first = false;
      yield chunk.startsWith(BYTE_ORDER_MARK) ? chunk.slice(1) : chunk;
    } else {
      yield chunk;
    }
  }
}

// Reads at most HEAD_BYTES from the start of the file, for previews and format detection.
// truncated is true when the file is longer than what was read, so the last record may be cut.
export async function readHead(
  path: string,
): Promise<{ text: string; truncated: boolean; size: number }> {
  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(HEAD_BYTES, size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer
      .subarray(0, bytesRead)
      .toString('utf8')
      .replace(BYTE_ORDER_MARK_PATTERN, '');
    return { text, truncated: size > bytesRead, size };
  } finally {
    await handle.close();
  }
}

function isJsonWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

type ArrayPhase = 'start' | 'expectValue' | 'value' | 'afterValue' | 'done';

// Yields the source text of each element of a top-level JSON array. The array is scanned as it
// streams, so only the element in progress is buffered. The elements are not parsed here.
// With truncated set, an element cut off by the end of the input is dropped instead of failing.
export async function* splitJsonArray(
  chunks: AsyncIterable<string>,
  truncated = false,
): AsyncGenerator<string> {
  let phase: ArrayPhase = 'start';
  let elements = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let parts: string[] = [];

  for await (const chunk of chunks) {
    const out: string[] = [];
    let cursor = 0;
    const finishElement = (end: number): void => {
      parts.push(chunk.slice(cursor, end));
      out.push(parts.join(''));
      parts = [];
      elements += 1;
    };

    for (let index = 0; index < chunk.length; index++) {
      const char = chunk.charAt(index);
      if (phase !== 'value') {
        if (isJsonWhitespace(char)) {
          continue;
        }
        if (phase === 'start') {
          if (char !== '[') {
            throw validationError('The file must be a JSON array that starts with [');
          }
          phase = 'expectValue';
        } else if (phase === 'expectValue') {
          if (char === ']') {
            if (elements > 0) {
              throw validationError('The JSON array has a trailing comma');
            }
            phase = 'done';
          } else if (char === ',') {
            throw validationError('The JSON array has an element missing before a comma');
          } else {
            phase = 'value';
            cursor = index;
            depth = 0;
            inString = false;
            escaped = false;
            index -= 1;
          }
        } else if (phase === 'afterValue') {
          if (char === ',') {
            phase = 'expectValue';
          } else if (char === ']') {
            phase = 'done';
          } else {
            throw validationError('The JSON array has a missing comma between elements');
          }
        } else {
          throw validationError('The file has content after the end of the JSON array');
        }
        continue;
      }

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
          if (depth === 0) {
            finishElement(index + 1);
            phase = 'afterValue';
          }
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === '{' || char === '[') {
        depth += 1;
      } else if (char === '}' || char === ']') {
        if (depth === 0) {
          // This bracket closes the array, so the element ended just before it.
          finishElement(index);
          phase = 'afterValue';
          index -= 1;
        } else {
          depth -= 1;
          if (depth === 0) {
            finishElement(index + 1);
            phase = 'afterValue';
          }
        }
      } else if (depth === 0 && (char === ',' || isJsonWhitespace(char))) {
        finishElement(index);
        phase = 'afterValue';
        index -= 1;
      }
    }

    if (phase === 'value') {
      parts.push(chunk.slice(cursor));
    }
    for (const text of out) {
      yield text;
    }
  }

  if (truncated) {
    return;
  }
  if (phase === 'value') {
    throw validationError('The file ends in the middle of a JSON element');
  }
  if (phase === 'start') {
    throw validationError('The file must be a JSON array that starts with [');
  }
  if (phase !== 'done') {
    throw validationError('The file ends before the JSON array is closed');
  }
}

// Splits text into lines. A CR before the LF is removed. Blank lines are passed through, and the
// caller skips them.
export async function* splitLines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let rest = '';
  for await (const chunk of chunks) {
    const text = rest + chunk;
    let start = 0;
    let newline = text.indexOf('\n', start);
    while (newline !== -1) {
      yield stripCarriageReturn(text.slice(start, newline));
      start = newline + 1;
      newline = text.indexOf('\n', start);
    }
    rest = text.slice(start);
  }
  if (rest !== '') {
    yield stripCarriageReturn(rest);
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

export async function* parseCsvRecords(
  chunks: AsyncIterable<string>,
  csv: Pick<CsvOptions, 'delimiter'>,
): AsyncGenerator<string[]> {
  const parser = createCsvParser({ delimiter: csv.delimiter });
  for await (const chunk of chunks) {
    for (const record of parser.write(chunk)) {
      yield record;
    }
  }
  for (const record of parser.flush()) {
    yield record;
  }
}
