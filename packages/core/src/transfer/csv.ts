const BYTE_ORDER_MARK = '\uFEFF';
const CARRIAGE_RETURN = '\r';
const LINE_FEED = '\n';

export interface CsvParserOptions {
  readonly delimiter: string;
  readonly quote?: string;
}

export interface CsvParser {
  // Feeds one chunk of text and returns the records completed by it. A record that is still
  // open at the end of the chunk is held until a later chunk or flush() completes it.
  write(chunk: string): string[][];
  // Ends the input and returns the final record when the input does not end in a newline.
  // Throws when a quoted field is still open, because the rest of the file cannot be recovered.
  flush(): string[][];
}

export class CsvSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvSyntaxError';
  }
}

// Streaming RFC 4180 tokenizer. Handles quoted fields, doubled quotes, embedded delimiters and
// line breaks, CRLF and LF (and a lone CR), a leading byte order mark, and a final record
// without a newline. A line with a single empty unquoted field is a blank line and is skipped.
// A quote that appears inside an unquoted field is kept as a literal character.
export function createCsvParser(options: CsvParserOptions): CsvParser {
  const delimiter = options.delimiter;
  const quote = options.quote ?? '"';
  if (delimiter.length !== 1 || quote.length !== 1 || delimiter === quote) {
    throw new CsvSyntaxError('The delimiter and quote must be distinct single characters');
  }

  let started = false;
  let record: string[] = [];
  let field = '';
  let fieldQuoted = false;
  let atFieldStart = true;
  let inQuotes = false;
  let quoteSeen = false;
  let skipLineFeed = false;

  // Ends the current field at a delimiter.
  function endField(): void {
    record.push(field);
    field = '';
    fieldQuoted = false;
    atFieldStart = true;
  }

  // Ends the current record at a line break. A record that is one empty unquoted field is blank.
  function endRecord(out: string[][]): void {
    const blank = record.length === 0 && field === '' && !fieldQuoted;
    endField();
    if (!blank) {
      out.push(record);
    }
    record = [];
  }

  function consume(text: string, out: string[][]): void {
    for (let index = 0; index < text.length; index++) {
      const char = text.charAt(index);
      if (!started) {
        started = true;
        if (char === BYTE_ORDER_MARK) {
          continue;
        }
      }
      if (skipLineFeed) {
        skipLineFeed = false;
        if (char === LINE_FEED) {
          continue;
        }
      }
      if (inQuotes) {
        if (quoteSeen) {
          quoteSeen = false;
          if (char === quote) {
            field += quote;
            continue;
          }
          inQuotes = false;
        } else {
          if (char === quote) {
            quoteSeen = true;
          } else {
            field += char;
          }
          continue;
        }
      }
      if (char === quote && atFieldStart) {
        inQuotes = true;
        fieldQuoted = true;
        atFieldStart = false;
        continue;
      }
      if (char === delimiter) {
        endField();
        continue;
      }
      if (char === CARRIAGE_RETURN) {
        endRecord(out);
        skipLineFeed = true;
        continue;
      }
      if (char === LINE_FEED) {
        endRecord(out);
        continue;
      }
      field += char;
      atFieldStart = false;
    }
  }

  return {
    write(chunk: string): string[][] {
      const out: string[][] = [];
      consume(chunk, out);
      return out;
    },
    flush(): string[][] {
      if (inQuotes && !quoteSeen) {
        throw new CsvSyntaxError('The file ends inside a quoted field');
      }
      inQuotes = false;
      quoteSeen = false;
      const out: string[][] = [];
      if (record.length > 0 || field !== '' || fieldQuoted) {
        endRecord(out);
      }
      return out;
    },
  };
}

const NEEDS_QUOTING = /[\r\n]/;

// Quotes a value when it contains the delimiter, the quote character, or a line break.
// Every other value is written as is.
export function formatCsvField(value: string, delimiter: string, quote = '"'): string {
  const needsQuotes =
    value.includes(delimiter) || value.includes(quote) || NEEDS_QUOTING.test(value);
  if (!needsQuotes) {
    return value;
  }
  return `${quote}${value.split(quote).join(quote + quote)}${quote}`;
}

export function formatCsvRow(values: readonly string[], delimiter: string): string {
  return values.map((value) => formatCsvField(value, delimiter)).join(delimiter);
}
