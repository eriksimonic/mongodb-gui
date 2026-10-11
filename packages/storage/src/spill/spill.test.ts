import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SPILL_CHUNK_CHARS,
  SpillError,
  createSpillContext,
  disposeSpill,
  readSpillFile,
  releaseSpillRun,
  spillEnv,
  spillFromEnv,
  writeSpillFile,
  type SpillContext,
} from './index';

let root: string;
let ctx: SpillContext;
let runId: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'spill-test-'));
  ctx = createSpillContext(join(root, 'spill'));
  mkdirSync(ctx.dir);
  runId = randomUUID();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function filePath(ref: string): string {
  return join(ctx.dir, ref);
}

/** Byte ranges [start, end) of each chunk including its 4-byte header. */
function chunkRanges(bytes: Buffer): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  while (offset < bytes.length) {
    const end = offset + 4 + bytes.readUInt32BE(offset);
    ranges.push([offset, end]);
    offset = end;
  }
  return ranges;
}

function expectCorrupt(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SpillError);
    expect((error as SpillError).code).toBe('CORRUPT');
    return;
  }
  throw new Error('expected SpillError CORRUPT');
}

function multiChunk(): string {
  return 'x'.repeat(SPILL_CHUNK_CHARS * 3 + 17);
}

describe('roundtrip', () => {
  const cases: Array<[string, () => string]> = [
    ['empty', () => ''],
    ['one char', () => 'a'],
    ['exactly one chunk', () => 'a'.repeat(SPILL_CHUNK_CHARS)],
    ['one chunk plus one', () => 'a'.repeat(SPILL_CHUNK_CHARS + 1)],
    ['~3 MB multi-chunk', () => 'héllo wörld '.repeat(250_000)],
    ['surrogate pair on the chunk boundary', () => 'a' + '\u{1F600}'.repeat(SPILL_CHUNK_CHARS)],
  ];
  for (const [name, make] of cases) {
    it(name, () => {
      const text = make();
      const { ref, fileBytes } = writeSpillFile(ctx, runId, text);
      expect(fileBytes).toBe(statSync(filePath(ref)).size);
      expect(readSpillFile(ctx, ref)).toBe(text);
    });
  }

  it('empty text is one final chunk', () => {
    const { ref } = writeSpillFile(ctx, runId, '');
    expect(chunkRanges(readFileSync(filePath(ref)))).toHaveLength(1);
  });
});

describe('permissions', () => {
  it.skipIf(process.platform === 'win32')('file is 0600 and run dir is 0700', () => {
    const { ref } = writeSpillFile(ctx, runId, 'x');
    expect(statSync(filePath(ref)).mode & 0o777).toBe(0o600);
    expect(statSync(join(ctx.dir, runId)).mode & 0o777).toBe(0o700);
  });
});

describe('encryption', () => {
  it('leaves no plaintext on disk', () => {
    const text = 'filler '.repeat(100_000) + 'CANARY-7f3a' + ' filler'.repeat(100_000);
    const { ref } = writeSpillFile(ctx, runId, text);
    const bytes = readFileSync(filePath(ref));
    expect(bytes.includes('CANARY-7f3a')).toBe(false);
    expect(bytes.includes('filler')).toBe(false);
  });
});

describe('tamper detection', () => {
  function written(): { ref: string; path: string; bytes: Buffer } {
    const { ref } = writeSpillFile(ctx, runId, multiChunk());
    const path = filePath(ref);
    return { ref, path, bytes: readFileSync(path) };
  }

  it('flipped ciphertext byte', () => {
    const { ref, path, bytes } = written();
    bytes[100] = (bytes[100] as number) ^ 1;
    writeFileSync(path, bytes);
    expectCorrupt(() => readSpillFile(ctx, ref));
  });

  it('truncated at a chunk boundary', () => {
    const { ref, path, bytes } = written();
    const ranges = chunkRanges(bytes);
    expect(ranges.length).toBeGreaterThan(2);
    truncateSync(path, (ranges[ranges.length - 2] as [number, number])[1]);
    expectCorrupt(() => readSpillFile(ctx, ref));
  });

  it('truncated mid-chunk', () => {
    const { ref, path, bytes } = written();
    truncateSync(path, bytes.length - 10);
    expectCorrupt(() => readSpillFile(ctx, ref));
  });

  it('dropped first chunk', () => {
    const { ref, path, bytes } = written();
    const first = (chunkRanges(bytes)[0] as [number, number])[1];
    writeFileSync(path, bytes.subarray(first));
    expectCorrupt(() => readSpillFile(ctx, ref));
  });

  it('swapped chunks', () => {
    const { ref, path, bytes } = written();
    const ranges = chunkRanges(bytes);
    const [a, b, ...rest] = ranges.map(([s, e]) => bytes.subarray(s, e));
    writeFileSync(path, Buffer.concat([b as Buffer, a as Buffer, ...(rest as Buffer[])]));
    expectCorrupt(() => readSpillFile(ctx, ref));
  });

  it('file copied to another ref', () => {
    const { path } = written();
    const otherRef = `${runId}/${randomUUID()}`;
    copyFileSync(path, filePath(otherRef));
    expectCorrupt(() => readSpillFile(ctx, otherRef));
  });

  it('file moved to another run', () => {
    const { path } = written();
    const otherRun = randomUUID();
    const otherRef = `${otherRun}/${randomUUID()}`;
    mkdirSync(join(ctx.dir, otherRun));
    copyFileSync(path, filePath(otherRef));
    expectCorrupt(() => readSpillFile(ctx, otherRef));
  });

  it('different key', () => {
    const { ref } = written();
    const other = { ...createSpillContext(ctx.dir), storeId: ctx.storeId };
    expectCorrupt(() => readSpillFile(other, ref));
  });

  it('same key, different store id', () => {
    const { ref } = written();
    expectCorrupt(() => readSpillFile({ ...ctx, storeId: randomUUID() }, ref));
  });

  it('trailing garbage', () => {
    const { ref, path } = written();
    appendFileSync(path, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expectCorrupt(() => readSpillFile(ctx, ref));
  });

  it('trailing partial header', () => {
    const { ref, path } = written();
    appendFileSync(path, Buffer.from([0, 0]));
    expectCorrupt(() => readSpillFile(ctx, ref));
  });

  it('empty file', () => {
    const { ref, path } = written();
    writeFileSync(path, Buffer.alloc(0));
    expectCorrupt(() => readSpillFile(ctx, ref));
  });
});

describe('refs and run ids', () => {
  it('invalid or missing refs are NOT_FOUND', () => {
    for (const ref of ['../x', 'abc', `${runId}/../../etc/passwd`, `${runId}/${randomUUID()}`]) {
      try {
        readSpillFile(ctx, ref);
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(SpillError);
        expect((error as SpillError).code).toBe('NOT_FOUND');
      }
    }
  });

  it('non-uuid run id throws on write and release', () => {
    expect(() => writeSpillFile(ctx, '../evil', 'x')).toThrow(TypeError);
    expect(() => releaseSpillRun(ctx, 'abc')).toThrow(TypeError);
    expect(readdirSync(ctx.dir)).toEqual([]);
  });
});

describe('release and dispose', () => {
  it('releaseSpillRun removes one run only', () => {
    const otherRun = randomUUID();
    const a1 = writeSpillFile(ctx, runId, 'one');
    const a2 = writeSpillFile(ctx, runId, 'two');
    const b = writeSpillFile(ctx, otherRun, 'three');
    releaseSpillRun(ctx, runId);
    expect(existsSync(filePath(a1.ref))).toBe(false);
    expect(existsSync(filePath(a2.ref))).toBe(false);
    expect(readSpillFile(ctx, b.ref)).toBe('three');
    expect(readdirSync(ctx.dir)).toEqual([otherRun]);
  });

  it('releaseSpillRun tolerates a missing run', () => {
    expect(() => releaseSpillRun(ctx, runId)).not.toThrow();
  });

  it('disposeSpill zeroes the key and removes the dir', () => {
    writeSpillFile(ctx, runId, 'x');
    disposeSpill(ctx);
    expect(ctx.key.every((b) => b === 0)).toBe(true);
    expect(existsSync(ctx.dir)).toBe(false);
  });

  it('a write after dispose fails and does not bring the folder back', () => {
    const late = createSpillContext(ctx.dir);
    disposeSpill(ctx);
    expect(() => writeSpillFile(late, runId, 'late')).toThrow();
    expect(existsSync(ctx.dir)).toBe(false);
  });
});

describe('env', () => {
  it('roundtrips', () => {
    const env = spillEnv(ctx);
    const back = spillFromEnv(env);
    expect(back?.dir).toBe(ctx.dir);
    expect(back?.storeId).toBe(ctx.storeId);
    expect(back?.key.equals(ctx.key)).toBe(true);
    const { ref } = writeSpillFile(ctx, runId, 'shared');
    expect(readSpillFile(back as SpillContext, ref)).toBe('shared');
  });

  it('missing or malformed gives undefined', () => {
    const env = spillEnv(ctx);
    expect(spillFromEnv({})).toBeUndefined();
    for (const name of Object.keys(env)) {
      const rest = Object.fromEntries(Object.entries(env).filter(([k]) => k !== name));
      expect(spillFromEnv(rest)).toBeUndefined();
    }
    const keyName = 'MONGO_GUI_SPILL_KEY';
    expect(spillFromEnv({ ...env, [keyName]: 'abcd' })).toBeUndefined();
    expect(spillFromEnv({ ...env, [keyName]: 'z'.repeat(64) })).toBeUndefined();
  });
});
