import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeSpillFile } from '@mongo-gui/storage/spill';
import { createSpillRoot } from './spill-root';

const posixOnly = process.platform === 'win32' ? it.skip : it;

// A pid that belonged to a process that has exited.
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.pid === undefined) {
    throw new Error('no pid');
  }
  return child.pid;
}

describe('createSpillRoot', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'spill-root-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const parentOf = (base: string): string =>
    join(base, `mongo-gui-spill-${process.getuid?.() ?? 'user'}`);

  it('skips a RAM-backed base and uses the next', () => {
    const ram = join(tmp, 'ram');
    const disk = join(tmp, 'disk');
    const root = createSpillRoot({ bases: [ram, disk], isRamFs: (dir) => dir === ram });
    expect(root?.ctx.dir).toBe(join(parentOf(disk), String(process.pid)));
    expect(existsSync(parentOf(ram))).toBe(false);
    root?.dispose();
  });

  it('uses the first base when it is not RAM-backed', () => {
    const first = join(tmp, 'first');
    const root = createSpillRoot({ bases: [first, join(tmp, 'second')], isRamFs: () => false });
    expect(root?.ctx.dir.startsWith(first)).toBe(true);
    root?.dispose();
  });

  it('returns undefined when no base is usable', () => {
    const file = join(tmp, 'file');
    writeFileSync(file, 'x');
    expect(createSpillRoot({ bases: [join(file, 'sub')], isRamFs: () => false })).toBeUndefined();
    expect(createSpillRoot({ bases: [join(tmp, 'a')], isRamFs: () => true })).toBeUndefined();
    expect(createSpillRoot({ bases: [], isRamFs: () => false })).toBeUndefined();
  });

  posixOnly('creates the parent and instance folders owner-only', () => {
    const root = createSpillRoot({ bases: [tmp], isRamFs: () => false });
    expect(statSync(parentOf(tmp)).mode & 0o777).toBe(0o700);
    expect(statSync(root?.ctx.dir ?? '').mode & 0o777).toBe(0o700);
    root?.dispose();
  });

  posixOnly('tightens a parent folder that others can read', () => {
    const parent = parentOf(tmp);
    mkdirSync(parent, { mode: 0o755 });
    chmodSync(parent, 0o755);
    const root = createSpillRoot({ bases: [tmp], isRamFs: () => false });
    expect(statSync(parent).mode & 0o777).toBe(0o700);
    root?.dispose();
  });

  posixOnly('refuses a symlink in place of the parent folder and falls through', () => {
    const elsewhere = join(tmp, 'elsewhere');
    mkdirSync(elsewhere);
    const trapped = join(tmp, 'trapped');
    mkdirSync(trapped);
    symlinkSync(elsewhere, parentOf(trapped));
    const good = join(tmp, 'good');
    const root = createSpillRoot({ bases: [trapped, good], isRamFs: () => false });
    expect(root?.ctx.dir.startsWith(parentOf(good))).toBe(true);
    expect(existsSync(join(elsewhere, String(process.pid)))).toBe(false);
    root?.dispose();
  });

  it('sweeps dead instances and keeps live and unrelated folders', () => {
    const parent = parentOf(tmp);
    const dead = String(deadPid());
    const parentPid = String(process.ppid);
    for (const name of [dead, parentPid, 'notes']) {
      mkdirSync(join(parent, name), { recursive: true });
      writeFileSync(join(parent, name, 'f'), 'x');
    }
    const root = createSpillRoot({
      bases: [tmp],
      pid: process.pid + 100_000,
      isRamFs: () => false,
    });
    expect(existsSync(join(parent, dead))).toBe(false);
    expect(existsSync(join(parent, parentPid, 'f'))).toBe(true);
    expect(existsSync(join(parent, 'notes', 'f'))).toBe(true);
    root?.dispose();
  });

  it('keeps the folder of another live instance', () => {
    const parent = parentOf(tmp);
    const live = join(parent, String(process.pid));
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, 'f'), 'x');
    const root = createSpillRoot({ bases: [tmp], pid: process.ppid, isRamFs: () => false });
    expect(existsSync(join(live, 'f'))).toBe(true);
    root?.dispose();
  });

  it('sweeps a folder of a live pid that nothing touched since boot', () => {
    const parent = parentOf(tmp);
    const reused = join(parent, String(process.ppid));
    mkdirSync(reused, { recursive: true });
    writeFileSync(join(reused, 'f'), 'x');
    const root = createSpillRoot({
      bases: [tmp],
      pid: process.pid + 100_000,
      isRamFs: () => false,
      bootMs: Date.now() + 60_000,
    });
    expect(existsSync(reused)).toBe(false);
    root?.dispose();
  });

  it('sweeps a folder whose pid belongs to another user', () => {
    const parent = parentOf(tmp);
    const foreign = join(parent, '4242');
    mkdirSync(foreign, { recursive: true });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });
    try {
      const root = createSpillRoot({ bases: [tmp], pid: 99_999, isRamFs: () => false });
      expect(existsSync(foreign)).toBe(false);
      root?.dispose();
    } finally {
      kill.mockRestore();
    }
  });

  it('sweeps the other bases too, not only the one in use', () => {
    const first = join(tmp, 'first');
    const second = join(tmp, 'second');
    const left = join(parentOf(second), String(deadPid()));
    mkdirSync(left, { recursive: true });
    writeFileSync(join(left, 'f'), 'x');
    const root = createSpillRoot({ bases: [first, second], isRamFs: () => false });
    expect(root?.ctx.dir.startsWith(first)).toBe(true);
    expect(existsSync(left)).toBe(false);
    root?.dispose();
  });

  it('does not create a base it only sweeps', () => {
    const second = join(tmp, 'second');
    const root = createSpillRoot({ bases: [join(tmp, 'first'), second], isRamFs: () => false });
    expect(existsSync(second)).toBe(false);
    root?.dispose();
  });

  it('removes the instance folder on dispose, zeroes the key and is idempotent', () => {
    const root = createSpillRoot({ bases: [tmp], isRamFs: () => false });
    if (root === undefined) {
      throw new Error('no root');
    }
    expect(existsSync(root.ctx.dir)).toBe(true);
    root.dispose();
    expect(existsSync(root.ctx.dir)).toBe(false);
    expect(root.ctx.key.every((byte) => byte === 0)).toBe(true);
    expect(() => {
      root.dispose();
    }).not.toThrow();
  });

  it('reads what the shell wrote and releases a run', () => {
    const root = createSpillRoot({ bases: [tmp], isRamFs: () => false });
    if (root === undefined) {
      throw new Error('no root');
    }
    const runId = randomUUID();
    const { ref } = writeSpillFile(root.ctx, runId, '{"a":1}');
    expect(root.read(ref)).toBe('{"a":1}');
    root.release(runId);
    expect(existsSync(join(root.ctx.dir, runId))).toBe(false);
    root.dispose();
  });
});
