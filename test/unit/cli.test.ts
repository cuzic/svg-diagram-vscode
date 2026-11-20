import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, test} from 'node:test';
import {describeCli, resolveCli} from '../../src/cli.ts';

let tmp: string;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'svgd-cli-'))); });
afterEach(() => fs.rmSync(tmp, {recursive: true, force: true}));

/** A package like the published one: <root>/package.json + <root>/bin/svg-diagram (executable). */
function makePackage(root: string, version = '1.2.3', name = 'svg-diagram'): string {
  fs.mkdirSync(path.join(root, 'bin'), {recursive: true});
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name, version, bin: {'svg-diagram': './bin/svg-diagram'}}));
  const bin = path.join(root, 'bin', 'svg-diagram');
  fs.writeFileSync(bin, '#!/usr/bin/env bash\n', {mode: 0o755});
  return bin;
}
const noPath = {PATH: ''};

test('the project package is found in the folder', () => {
  const bin = makePackage(path.join(tmp, 'proj', 'node_modules', 'svg-diagram'));
  const {cli, warnings} = resolveCli({folder: path.join(tmp, 'proj'), env: noPath});
  assert.deepEqual(cli, {bin, source: 'project', root: path.join(tmp, 'proj', 'node_modules', 'svg-diagram'), version: '1.2.3'});
  assert.deepEqual(warnings, []);
});

test('the project package is found in a parent (monorepo root)', () => {
  makePackage(path.join(tmp, 'node_modules', 'svg-diagram'), '2.0.0');
  fs.mkdirSync(path.join(tmp, 'packages', 'docs'), {recursive: true});
  assert.equal(resolveCli({folder: path.join(tmp, 'packages', 'docs'), env: noPath}).cli?.version, '2.0.0');
});

test('a node_modules/svg-diagram that is some other package is skipped', () => {
  makePackage(path.join(tmp, 'proj', 'node_modules', 'svg-diagram'), '1.0.0', 'not-svg-diagram');
  assert.equal(resolveCli({folder: path.join(tmp, 'proj'), env: noPath}).cli, undefined);
});

test('the setting wins over the project, relative to the folder, and the version comes from beside bin/', () => {
  makePackage(path.join(tmp, 'proj', 'node_modules', 'svg-diagram'), '1.0.0');
  const bin = makePackage(path.join(tmp, 'core'), '9.9.9');
  const {cli} = resolveCli({folder: path.join(tmp, 'proj'), setting: '../core/bin/svg-diagram', env: noPath});
  assert.deepEqual(cli, {bin, source: 'setting', root: path.join(tmp, 'core'), version: '9.9.9'});
});

test('a setting that points at nothing warns and falls back to the project', () => {
  makePackage(path.join(tmp, 'proj', 'node_modules', 'svg-diagram'));
  const {cli, warnings} = resolveCli({folder: path.join(tmp, 'proj'), setting: 'nope/svg-diagram', env: noPath});
  assert.equal(cli?.source, 'project');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /svgDiagram\.cliPath/);
});

test('PATH: a symlink into a clone gets its version; a bare file has none', () => {
  const real = makePackage(path.join(tmp, 'clone'), '3.1.0');
  const binDir = path.join(tmp, 'local-bin');
  fs.mkdirSync(binDir);
  fs.symlinkSync(real, path.join(binDir, 'svg-diagram'));
  const {cli} = resolveCli({folder: path.join(tmp, 'empty'), env: {PATH: binDir}});
  assert.deepEqual(cli, {bin: path.join(binDir, 'svg-diagram'), source: 'path', root: path.join(tmp, 'clone'), version: '3.1.0'});

  const shimDir = path.join(tmp, 'shim-bin');
  fs.mkdirSync(shimDir);
  fs.writeFileSync(path.join(shimDir, 'svg-diagram'), '#!/bin/sh\n', {mode: 0o755});
  assert.deepEqual(resolveCli({env: {PATH: shimDir}}).cli, {bin: path.join(shimDir, 'svg-diagram'), source: 'path'});
});

test('a non-executable file on PATH is not used', () => {
  fs.writeFileSync(path.join(tmp, 'svg-diagram'), '', {mode: 0o644});
  assert.equal(resolveCli({env: {PATH: tmp}}).cli, undefined);
});

test('nothing anywhere: no CLI, no warnings (the caller says how to install)', () => {
  assert.deepEqual(resolveCli({folder: tmp, env: noPath}), {warnings: []});
});

test('describeCli says where it came from', () => {
  assert.equal(describeCli({bin: '/x/bin/svg-diagram', source: 'project', version: '1.2.3'}), 'svg-diagram 1.2.3: /x/bin/svg-diagram（案件の node_modules）');
  assert.match(describeCli({bin: '/y', source: 'path'}), /版不明/);
});
