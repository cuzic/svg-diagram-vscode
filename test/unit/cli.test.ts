import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, test} from 'node:test';
import {describeCli, resolveCli, supportsBuildLocations} from '../../src/cli.ts';

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

function fakeBuildCli(root: string) {
  const bin = makePackage(root, '0.5.0');
  const buildModule = path.join(root, 'build-diagram.ts');
  fs.writeFileSync(buildModule, '');
  fs.utimesSync(buildModule, 1_700_000_000, 1_700_000_000);
  const support = path.join(root, 'usage.txt');
  const calls = path.join(root, 'calls');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(__dirname);
fs.appendFileSync(path.join(root, 'calls'), process.argv.slice(2).join(' ') + '\\n');
const usage = fs.readFileSync(path.join(root, 'usage.txt'), 'utf8');
if (usage === 'wait') setTimeout(() => {}, 10_000);
else { process[usage.startsWith('stdout:') ? 'stdout' : 'stderr'].write(usage.replace(/^stdout:/, '')); process.exitCode = 2; }
`);
  const probe = (timeoutMs?: number) => {
    const {cli} = resolveCli({setting: bin, env: noPath});
    assert.ok(cli);
    return supportsBuildLocations(cli, {cwd: root, timeoutMs});
  };
  return {bin, buildModule, probe, setUsage: (usage: string) => fs.writeFileSync(support, usage),
    calls: () => fs.readFileSync(calls, 'utf8').trim().split('\n')};
}

test('the --locations probe runs build without a source and caches both outcomes by package and version', {skip: process.platform === 'win32'}, async () => {
  const root = path.join(tmp, 'a');
  const first = fakeBuildCli(root);
  const second = fakeBuildCli(path.join(tmp, 'b'));
  first.setUsage('Usage: svg-diagram build <src> [--locations-dir DIR]');
  second.setUsage('stdout:Usage: svg-diagram build <src> [--locations FILE]');
  assert.equal(await first.probe(), false);
  assert.equal(await second.probe(), true);
  first.setUsage('Usage: svg-diagram build <src> [--locations FILE]');
  second.setUsage('Usage: svg-diagram build <src>');
  assert.equal(await first.probe(), false);
  assert.equal(await second.probe(), true);
  assert.deepEqual(first.calls(), ['build']);
  assert.deepEqual(second.calls(), ['build']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'svg-diagram', version: '0.5.1'}));
  assert.equal(await first.probe(), true);
  assert.deepEqual(first.calls(), ['build', 'build']);
});

test('changing build-diagram (checkout or dist) re-probes the unchanged bin', {skip: process.platform === 'win32'}, async () => {
  const root = path.join(tmp, 'core');
  const fake = fakeBuildCli(root);
  fake.setUsage('Usage: svg-diagram build <src>');
  assert.equal(await fake.probe(), false);
  fake.setUsage('Usage: svg-diagram build <src> [--locations FILE]');
  fs.utimesSync(fake.buildModule, 1_700_000_001, 1_700_000_001);
  assert.equal(await fake.probe(), true);
  const dist = path.join(root, 'dist', 'build-diagram.js');
  fs.mkdirSync(path.dirname(dist));
  fs.writeFileSync(dist, '');
  fake.setUsage('Usage: svg-diagram build <src>');
  assert.equal(await fake.probe(), false);
  fake.setUsage('Usage: svg-diagram build <src> [--locations FILE]');
  fs.utimesSync(dist, 1_700_000_002, 1_700_000_002);
  assert.equal(await fake.probe(), true);
  assert.deepEqual(fake.calls(), ['build', 'build', 'build', 'build']);
});

test('a timed-out probe or a failure to start is retried with the same key', {skip: process.platform === 'win32'}, async () => {
  const fake = fakeBuildCli(path.join(tmp, 'core'));
  fake.setUsage('wait');
  assert.equal(await fake.probe(100), false);
  const script = fs.readFileSync(fake.bin);
  fs.writeFileSync(fake.bin, '#!/missing/interpreter\n');
  assert.equal(await fake.probe(), false);
  fs.writeFileSync(fake.bin, script);
  fake.setUsage('Usage: svg-diagram build <src> [--locations FILE]');
  assert.equal(await fake.probe(), true);
});

test('a CLI mentioning --locations outside the usage does not enable it', {skip: process.platform === 'win32'}, async () => {
  const fake = fakeBuildCli(path.join(tmp, 'core'));
  fake.setUsage('error: unknown flag --locations\nUsage: svg-diagram build <src>');
  assert.equal(await fake.probe(), false);
});
