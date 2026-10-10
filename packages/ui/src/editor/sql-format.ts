/**
 * Formats T-SQL text for the editor. Keywords go to upper case outside strings, bracketed names and
 * comments. Each clause starts a line, select columns and SET assignments take one line each, and
 * AND or OR in a WHERE, HAVING or ON clause starts an indented line. Statements end at `;` or at a
 * `GO` alone on its line and are separated by a blank line. Formatting the result again changes
 * nothing. The formatter reads tokens only, so it works on text that does not parse.
 */

const INDENT = 2;

/** Words that need upper case anywhere outside a dotted name. Matches the parser's reserved list. */
const KEYWORDS = new Set([
  'ALL',
  'AND',
  'AS',
  'ASC',
  'BETWEEN',
  'BY',
  'CASE',
  'CAST',
  'CONVERT',
  'CROSS',
  'DECLARE',
  'DELETE',
  'DESC',
  'DISTINCT',
  'ELSE',
  'END',
  'ESCAPE',
  'EXCEPT',
  'EXISTS',
  'FETCH',
  'FROM',
  'FULL',
  'GROUP',
  'HAVING',
  'IN',
  'INNER',
  'INSERT',
  'INTERSECT',
  'INTO',
  'IS',
  'JOIN',
  'LEFT',
  'LIKE',
  'NOT',
  'NULL',
  'OFFSET',
  'ON',
  'OR',
  'ORDER',
  'OUTER',
  'OVER',
  'RIGHT',
  'SELECT',
  'SET',
  'TABLE',
  'THEN',
  'TOP',
  'TRUNCATE',
  'UNION',
  'UPDATE',
  'VALUES',
  'WHEN',
  'WHERE',
  'WITH',
]);

/** Function names that go to upper case when a parenthesis follows. */
const FUNCTIONS = new Set([
  'ABS',
  'AVG',
  'CEILING',
  'COALESCE',
  'CONCAT',
  'COUNT',
  'DATEADD',
  'DATEDIFF',
  'DATEPART',
  'DAY',
  'FLOOR',
  'GETDATE',
  'GETUTCDATE',
  'IIF',
  'ISNULL',
  'LEN',
  'LOWER',
  'LTRIM',
  'MAX',
  'MIN',
  'MONTH',
  'NULLIF',
  'REPLACE',
  'ROUND',
  'RTRIM',
  'SUBSTRING',
  'SUM',
  'TRIM',
  'UPPER',
  'YEAR',
]);

/** Keywords that read as functions when a parenthesis follows, so the source spacing stays. */
const FUNCTION_LIKE = new Set(['LEFT', 'RIGHT', 'CAST', 'CONVERT']);

/** Words of an OFFSET clause that are not reserved but need upper case there. */
const OFFSET_WORDS = new Set(['ROW', 'ROWS', 'NEXT', 'FIRST', 'ONLY']);

/** Words that end a join prefix and start the line of the join. */
const JOIN_PREFIXES = new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER']);

type PieceKind =
  | 'word'
  | 'identifier'
  | 'string'
  | 'number'
  | 'operator'
  | 'other'
  | 'lineComment'
  | 'blockComment';

interface Piece {
  readonly kind: PieceKind;
  readonly text: string;
  /** Whitespace of any kind came before the piece in the source. */
  readonly spaceBefore: boolean;
  /** A line break came before the piece in the source. */
  readonly newlineBefore: boolean;
}

const WHITESPACE = /\s+/y;
const WORD = /[#@]{0,2}[\p{L}_][\p{L}\p{N}_$#@]*/uy;
const NUMBER = /\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?/y;
const OPERATORS = [
  '<>',
  '<=',
  '>=',
  '!=',
  '=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '|',
  '^',
  '(',
  ')',
  ',',
  '.',
  ';',
];

function matchAt(pattern: RegExp, text: string, index: number): string | undefined {
  pattern.lastIndex = index;
  return pattern.exec(text)?.[0];
}

/** The exclusive end of a quoted lexeme that starts at `start`. A doubled closer stands for itself. */
function enclosedEnd(text: string, start: number, close: string): number {
  let index = start + 1;
  while (index < text.length) {
    if (text.charAt(index) === close) {
      if (text.charAt(index + 1) === close) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

function blockCommentEnd(text: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    if (text.startsWith('/*', index)) {
      depth += 1;
      index += 2;
    } else if (text.startsWith('*/', index)) {
      depth -= 1;
      index += 2;
      if (depth === 0) {
        return index;
      }
    } else {
      index += 1;
    }
  }
  return text.length;
}

function lineCommentEnd(text: string, start: number): number {
  const newline = text.indexOf('\n', start);
  if (newline === -1) {
    return text.length;
  }
  return text.charAt(newline - 1) === '\r' ? newline - 1 : newline;
}

function isNameLike(piece: Piece | undefined): boolean {
  return piece?.kind === 'word' || piece?.kind === 'identifier';
}

/** Splits the text into pieces without whitespace. Never throws and never loses text. */
function scan(text: string): Piece[] {
  const pieces: Piece[] = [];
  let index = 0;
  let spaceBefore = false;
  let newlineBefore = false;

  const push = (kind: PieceKind, end: number): void => {
    const raw = text.slice(index, end);
    pieces.push({
      kind,
      text: kind === 'lineComment' ? raw.trimEnd() : raw,
      spaceBefore,
      newlineBefore,
    });
    index = end;
    spaceBefore = false;
    newlineBefore = false;
  };

  while (index < text.length) {
    const char = text.charAt(index);
    const whitespace = matchAt(WHITESPACE, text, index);
    if (whitespace !== undefined) {
      spaceBefore = true;
      newlineBefore ||= whitespace.includes('\n');
      index += whitespace.length;
      continue;
    }
    const pair = text.slice(index, index + 2);
    if (pair === '--') {
      push('lineComment', lineCommentEnd(text, index));
    } else if (pair === '/*') {
      push('blockComment', blockCommentEnd(text, index));
    } else if (char === "'") {
      push('string', enclosedEnd(text, index, "'"));
    } else if ((char === 'N' || char === 'n') && text.charAt(index + 1) === "'") {
      push('string', enclosedEnd(text, index + 1, "'"));
    } else if (char === '[') {
      push('identifier', enclosedEnd(text, index, ']'));
    } else if (char === '"') {
      push('identifier', enclosedEnd(text, index, '"'));
    } else {
      const previous = pieces[pieces.length - 1];
      const joinsName = char === '.' && !spaceBefore && isNameLike(previous);
      const number = joinsName ? undefined : matchAt(NUMBER, text, index);
      if (number !== undefined) {
        push('number', index + number.length);
        continue;
      }
      const word = matchAt(WORD, text, index);
      if (word !== undefined) {
        push('word', index + word.length);
        continue;
      }
      const operator = OPERATORS.find((candidate) => text.startsWith(candidate, index));
      if (operator !== undefined) {
        push('operator', index + operator.length);
      } else {
        push('other', index + 1);
      }
    }
  }
  return pieces;
}

type Clause =
  | 'none'
  | 'select'
  | 'from'
  | 'join'
  | 'on'
  | 'where'
  | 'group'
  | 'having'
  | 'order'
  | 'set'
  | 'values'
  | 'offset';

const CLAUSE_OF_WORD: Readonly<Record<string, Clause>> = {
  SELECT: 'select',
  FROM: 'from',
  JOIN: 'join',
  WHERE: 'where',
  GROUP: 'group',
  HAVING: 'having',
  ORDER: 'order',
  SET: 'set',
  VALUES: 'values',
  OFFSET: 'offset',
  UNION: 'none',
  INTERSECT: 'none',
  EXCEPT: 'none',
  UPDATE: 'none',
  DELETE: 'none',
  INSERT: 'none',
};

/** The clauses where AND and OR start a continuation line. */
const CONDITION_CLAUSES: ReadonlySet<Clause> = new Set(['where', 'having', 'on']);

/** What the formatter keeps of the piece it placed last, to decide the spacing of the next one. */
interface Placed {
  readonly piece: Piece;
  readonly text: string;
  /** A `-` or `+` that has no left operand. */
  readonly unary: boolean;
}

function needsSpace(previous: Placed, current: Piece): boolean {
  const before = previous.text;
  if (before === '(' || before === '.' || previous.unary) {
    return false;
  }
  if (current.text === ')' || current.text === ',' || current.text === '.') {
    return false;
  }
  if (current.text === '(' && current.kind === 'operator') {
    const word = previous.piece.kind === 'word' ? before.toUpperCase() : '';
    if (word !== '' && KEYWORDS.has(word) && !FUNCTION_LIKE.has(word)) {
      return true;
    }
    if (previous.piece.kind === 'word' || previous.piece.kind === 'identifier') {
      return current.spaceBefore;
    }
    return true;
  }
  return true;
}

interface FormattedStatement {
  readonly text: string;
  /** The last thing on the text is a `--` comment, so nothing may follow on the same line. */
  readonly endsWithLineComment: boolean;
}

function formatStatement(pieces: readonly Piece[]): FormattedStatement {
  const lines: string[] = [];
  let line = '';
  let lineHasText = false;
  let pendingBreak: number | undefined;
  let depth = 0;
  let clause: Clause = 'none';
  let caseDepth = 0;
  let sawContent = false;
  let lastWasLineComment = false;
  const betweenOpen: boolean[] = [false];
  let previous: Placed | undefined;
  let previousSignificant: Piece | undefined;

  const flush = (): void => {
    if (lineHasText) {
      lines.push(line);
    }
    line = '';
    lineHasText = false;
  };

  const startLine = (indent: number): void => {
    flush();
    line = ' '.repeat(indent);
  };

  const nextSignificant = (from: number): Piece | undefined => {
    for (let index = from; index < pieces.length; index += 1) {
      const piece = pieces[index];
      if (piece && piece.kind !== 'lineComment' && piece.kind !== 'blockComment') {
        return piece;
      }
    }
    return undefined;
  };

  const upperOf = (piece: Piece | undefined): string =>
    piece?.kind === 'word' ? piece.text.toUpperCase() : '';

  pieces.forEach((piece, index) => {
    if (piece.kind === 'lineComment' || (piece.kind === 'blockComment' && !sawContent)) {
      const ownLine = !sawContent || piece.newlineBefore || !lineHasText;
      if (ownLine) {
        startLine(pendingBreak ?? 0);
        line += piece.text;
        lineHasText = true;
        flush();
        pendingBreak = sawContent ? (pendingBreak ?? INDENT) : 0;
      } else {
        line += ` ${piece.text}`;
        pendingBreak ??= INDENT;
      }
      lastWasLineComment = piece.kind === 'lineComment';
      if (piece.kind === 'blockComment') {
        previous = undefined;
      }
      return;
    }

    lastWasLineComment = false;
    const following = nextSignificant(index + 1);
    const afterDot = previousSignificant?.text === '.' && previousSignificant.kind === 'operator';
    const upper = afterDot ? '' : upperOf(piece);
    let text = piece.text;
    let breakIndent: number | undefined;

    if (piece.kind === 'operator' && piece.text === ')') {
      depth = Math.max(0, depth - 1);
    }

    if (piece.kind === 'word' && !afterDot) {
      const followingUpper = upperOf(following);
      const afterAs = depth > 0 && upperOf(previousSignificant) === 'AS';
      if (
        KEYWORDS.has(upper) ||
        afterAs ||
        (clause === 'offset' && OFFSET_WORDS.has(upper)) ||
        (FUNCTIONS.has(upper) && following?.text === '(' && following.kind === 'operator')
      ) {
        text = upper;
      }
      if (depth === 0) {
        if (upper in CLAUSE_OF_WORD && upper !== 'JOIN') {
          const afterDelete = upper === 'FROM' && upperOf(previousSignificant) === 'DELETE';
          if (!afterDelete) {
            breakIndent = 0;
          }
        } else if (upper === 'GROUP' || upper === 'ORDER') {
          if (followingUpper === 'BY') {
            breakIndent = 0;
          }
        } else if (JOIN_PREFIXES.has(upper) && upper !== 'OUTER') {
          if (followingUpper === 'JOIN' || followingUpper === 'OUTER') {
            breakIndent = 0;
          }
        } else if (upper === 'JOIN') {
          if (!JOIN_PREFIXES.has(upperOf(previousSignificant))) {
            breakIndent = 0;
          }
        } else if (
          (upper === 'AND' || upper === 'OR') &&
          CONDITION_CLAUSES.has(clause) &&
          caseDepth === 0 &&
          !(upper === 'AND' && betweenOpen[0])
        ) {
          breakIndent = INDENT;
        }
        const nextClause = CLAUSE_OF_WORD[upper];
        if (nextClause !== undefined) {
          clause = nextClause;
        } else if (upper === 'ON' && clause === 'join') {
          clause = 'on';
        }
      }
      if (upper === 'BETWEEN') {
        betweenOpen[depth] = true;
      } else if (upper === 'AND' && betweenOpen[depth]) {
        betweenOpen[depth] = false;
      } else if (upper === 'CASE') {
        caseDepth += 1;
      } else if (upper === 'END') {
        caseDepth = Math.max(0, caseDepth - 1);
      }
    }

    const unary =
      piece.kind === 'operator' &&
      (piece.text === '-' || piece.text === '+') &&
      (previous === undefined ||
        previous.piece.kind === 'other' ||
        (previous.piece.kind === 'operator' && previous.text !== ')') ||
        (previous.piece.kind === 'word' &&
          KEYWORDS.has(previous.text.toUpperCase()) &&
          previous.text.toUpperCase() !== 'NULL'));

    const breakAt = breakIndent ?? pendingBreak;
    if (breakAt !== undefined) {
      startLine(breakAt);
    } else if (previous !== undefined && lineHasText && needsSpace(previous, piece)) {
      line += ' ';
    }
    pendingBreak = undefined;
    line += text;
    lineHasText = true;
    sawContent = true;
    previous = { piece, text, unary };
    previousSignificant = piece;

    if (piece.kind === 'operator' && piece.text === '(') {
      depth += 1;
      betweenOpen[depth] = false;
    } else if (
      piece.kind === 'operator' &&
      piece.text === ',' &&
      depth === 0 &&
      (clause === 'select' || clause === 'set')
    ) {
      pendingBreak = INDENT;
    }
  });

  flush();
  return { text: lines.join('\n'), endsWithLineComment: lastWasLineComment };
}

interface Block {
  readonly text: string;
  readonly terminator: ';' | 'GO' | '';
  readonly endsWithLineComment: boolean;
}

/**
 * Whether the piece is a `GO` that stands alone on its line. A `GO` right after a `;` counts, so
 * the formatted text, which moves it to a line of its own, formats to itself.
 */
function isGo(pieces: readonly Piece[], index: number): boolean {
  const piece = pieces[index];
  if (piece?.kind !== 'word' || piece.text.toUpperCase() !== 'GO') {
    return false;
  }
  const previous = pieces[index - 1];
  const startsLine =
    previous === undefined ||
    piece.newlineBefore ||
    (previous.kind === 'operator' && previous.text === ';');
  const next = pieces[index + 1];
  return startsLine && (next === undefined || next.newlineBefore);
}

function blockText(block: Block): string {
  if (block.terminator === ';') {
    return block.endsWithLineComment ? `${block.text}\n;` : `${block.text};`;
  }
  if (block.terminator === 'GO') {
    return block.text === '' ? 'GO' : `${block.text}\nGO`;
  }
  return block.text;
}

/**
 * Formats SQL text. Returns an empty string for blank text. Statements are separated by one blank
 * line, and a comment that follows the last statement stays in a block of its own.
 */
export function formatSql(text: string): string {
  const pieces = scan(text);
  const blocks: Block[] = [];
  let current: Piece[] = [];

  const close = (terminator: Block['terminator']): void => {
    if (current.length === 0 && terminator !== 'GO') {
      return;
    }
    const formatted = formatStatement(current);
    blocks.push({ ...formatted, terminator });
    current = [];
  };

  pieces.forEach((piece, index) => {
    if (piece.kind === 'operator' && piece.text === ';') {
      close(';');
    } else if (isGo(pieces, index)) {
      close('GO');
    } else {
      current.push(piece);
    }
  });
  close('');

  return blocks.map(blockText).join('\n\n');
}
