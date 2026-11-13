import { describe, expect, it } from 'vitest';
import { forbiddenModules } from '../../scripts/check-main-bundle';

const STAND_IN_DIRECTORY = '/repo/packages/app/scripts/stubs';

describe('forbiddenModules', () => {
  it('allows electron, its subpaths and Node built-ins with or without the node: prefix', () => {
    const source = [
      'import require$$1 from "electron";',
      'import { sub } from "electron/main";',
      'import fs from "fs";',
      'import { join } from "node:path";',
      'import { DatabaseSync } from "node:sqlite";',
      'import { once } from "events";',
      'import timers from "timers/promises";',
    ].join('\n');
    expect(forbiddenModules(source, STAND_IN_DIRECTORY)).toEqual([]);
  });

  it('allows the stand-in files that the optional-module aliases point to', () => {
    const standIn = `${STAND_IN_DIRECTORY}/snappy.js`;
    expect(forbiddenModules(`import snappy from "${standIn}";`, STAND_IN_DIRECTORY)).toEqual([]);
  });

  it('flags a static import, a bare import and a re-export of another module', () => {
    const source = [
      'import Driver from "mongodb-connection-string-url";',
      'import "reflect-metadata";',
      'export { thing } from "some-package";',
    ].join('\n');
    expect(forbiddenModules(source, STAND_IN_DIRECTORY).sort()).toEqual(
      ['mongodb-connection-string-url', 'reflect-metadata', 'some-package'].sort(),
    );
  });

  it('flags a multi-line import', () => {
    const source = 'import {\n  a,\n  b\n} from "left-pad";';
    expect(forbiddenModules(source, STAND_IN_DIRECTORY)).toEqual(['left-pad']);
  });

  it('flags an absolute path outside the stand-in folder', () => {
    const source = 'const driver = require("/repo/packages/app/node_modules/driver/index.js");';
    expect(forbiddenModules(source, STAND_IN_DIRECTORY)).toEqual([
      '/repo/packages/app/node_modules/driver/index.js',
    ]);
  });

  it('flags a dynamic import and a require, including the renamed require2', () => {
    const source = [
      'const driver = await import("some-driver");',
      'const crypto = require("crypto");',
      'const kerberos = require2("kerberos");',
      'if (x) nodeCrypto = require("bson-extra");',
    ].join('\n');
    expect(forbiddenModules(source, STAND_IN_DIRECTORY).sort()).toEqual(
      ['bson-extra', 'kerberos', 'some-driver'].sort(),
    );
  });

  it('ignores module names in comments', () => {
    const source = [
      '/** Example: import x from "left-pad" */',
      '// import y from "right-pad";',
      ' * const { MongoClient } = require("mongodb");',
      'const ok = 1;',
    ].join('\n');
    expect(forbiddenModules(source, STAND_IN_DIRECTORY)).toEqual([]);
  });

  it('ignores import and require text inside a string', () => {
    const source = [
      'throw new Error(`Please add \'import "reflect-metadata"\' to the top of your entry point.`);',
      "throw new Error(\"Cannot get 'saltLength' from 'alg' argument\");",
      'throw new Error("Add require(\'mongodb\') to load it");',
    ].join('\n');
    expect(forbiddenModules(source, STAND_IN_DIRECTORY)).toEqual([]);
  });

  it('ignores a method call that happens to be named require', () => {
    expect(forbiddenModules('const x = loader.require("left-pad");', STAND_IN_DIRECTORY)).toEqual(
      [],
    );
  });
});
