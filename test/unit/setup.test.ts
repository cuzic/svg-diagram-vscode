import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, test} from 'node:test';
import {detectPackageManager, readSetupState, type SetupState, setupCommand} from '../../src/setup.ts';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svgd-setup-')); });
afterEach(() => fs.rmSync(tmp, {recursive: true, force: true}));
const write = (rel: string, text = '') => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), {recursive: true}); fs.writeFileSync(path.join(tmp, rel), text); };

test('detectPackageManager: the lockfile here or in a parent; npm by default', () => {
  fs.mkdirSync(path.join(tmp, 'a', 'b'), {recursive: true});
  assert.equal(detectPackageManager(path.join(tmp, 'a', 'b')), 'npm');
  write('pnpm-lock.yaml');
  assert.equal(detectPackageManager(path.join(tmp, 'a', 'b')), 'pnpm');
  write('a/yarn.lock');
  assert.equal(detectPackageManager(path.join(tmp, 'a', 'b')), 'yarn');
  write('a/b/bun.lock');
  assert.equal(detectPackageManager(path.join(tmp, 'a', 'b')), 'bun');
});

test('readSetupState: packages (walking up), tsconfig, "type": "module"', () => {
  write('node_modules/typescript/package.json', '{}');
  write('proj/package.json', '{"type": "module"}');
  write('proj/node_modules/svg-diagram/package.json', '{}');
  assert.deepEqual(readSetupState(path.join(tmp, 'proj')), {hasCore: true, hasTypescript: true, hasTypesNode: false, hasTsconfig: false, isModule: true});
});

const ready: SetupState = {hasCore: true, hasTypescript: true, hasTypesNode: true, hasTsconfig: true, isModule: true};

test('setupCommand: nothing missing → nothing to run', () => {
  assert.equal(setupCommand('pnpm', ready), '');
});

test('setupCommand: an empty project → add all three, then init', () => {
  const empty: SetupState = {hasCore: false, hasTypescript: false, hasTypesNode: false, hasTsconfig: false, isModule: false};
  assert.equal(setupCommand('pnpm', empty), 'pnpm add -D svg-diagram typescript @types/node && pnpm exec svg-diagram init');
  assert.equal(setupCommand('npm', empty), 'npm install -D svg-diagram typescript @types/node && npx svg-diagram init');
  assert.equal(setupCommand('yarn', empty), 'yarn add -D svg-diagram typescript @types/node && yarn svg-diagram init');
  assert.equal(setupCommand('bun', empty), 'bun add -D svg-diagram typescript @types/node && bunx svg-diagram init');
});

test('setupCommand: only what is missing', () => {
  assert.equal(setupCommand('pnpm', {...ready, hasTypescript: false, hasTypesNode: false}), 'pnpm add -D typescript @types/node');
  assert.equal(setupCommand('pnpm', {...ready, isModule: false}), 'pnpm exec svg-diagram init');
});
