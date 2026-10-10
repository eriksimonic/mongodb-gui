import { findMethod, findOperator, methodLabel, type MethodEntry } from './operators';

export interface SignatureHelp {
  readonly label: string;
  readonly doc: string;
  /** The parameter the cursor is in. Zero for the first one. */
  readonly activeParameter: number;
  /** Parameter names in order. Optional ones are in brackets in `label`. */
  readonly parameters: readonly string[];
}

interface Frame {
  readonly open: string;
  readonly name: string;
  commas: number;
}

const IDENTIFIER_BEFORE = /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/;
const OPERATOR_KEY = /(\$[A-Za-z]+)\s*:\s*$/;

/**
 * Signature help for the call the cursor is inside. An operator key such as `$gt:` at the cursor
 * shows the operator's doc. Otherwise the innermost call the table describes gives its signature,
 * even when the cursor sits inside a literal argument of that call.
 */
export function signatureAt(code: string, offset: number): SignatureHelp | undefined {
  const stack = openFrames(code, offset);
  if (stack === undefined) {
    return undefined;
  }
  const top = stack.at(-1);
  const key = top?.open === '{' ? OPERATOR_KEY.exec(code.slice(0, offset)) : null;
  const operator = key === null ? undefined : findOperator(key[1] ?? '');
  if (operator !== undefined) {
    return {
      label: `${operator.name}(value)`,
      doc: operator.doc,
      activeParameter: 0,
      parameters: ['value'],
    };
  }
  const call = [...stack].reverse().find((frame) => frame.open === '(');
  const method = call === undefined ? undefined : findMethod(call.name);
  return method === undefined || call === undefined ? undefined : fromMethod(method, call.commas);
}

/**
 * The brackets still open at the offset, outermost first. Strings and comments are skipped. Returns
 * undefined when the offset sits inside a string or a comment.
 */
function openFrames(code: string, offset: number): Frame[] | undefined {
  const stack: Frame[] = [];
  let quote: string | undefined;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < offset && index < code.length; index += 1) {
    const char = code.charAt(index);
    const next = code.charAt(index + 1);
    if (lineComment) {
      lineComment = char !== '\n';
    } else if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
    } else if (quote !== undefined) {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
    } else if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '(' || char === '[' || char === '{') {
      const name = char === '(' ? (IDENTIFIER_BEFORE.exec(code.slice(0, index))?.[1] ?? '') : '';
      stack.push({ open: char, name, commas: 0 });
    } else if (char === ')' || char === ']' || char === '}') {
      stack.pop();
    } else if (char === ',') {
      const top = stack.at(-1);
      if (top !== undefined) {
        top.commas += 1;
      }
    }
  }
  return quote === undefined && !lineComment && !blockComment ? stack : undefined;
}

function fromMethod(method: MethodEntry, activeParameter: number): SignatureHelp {
  return {
    label: methodLabel(method),
    doc: method.doc,
    activeParameter: Math.min(activeParameter, Math.max(method.params.length - 1, 0)),
    parameters: method.params.map((param) => param.name),
  };
}
