import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, test} from 'node:test';
import type {ResolvedCli} from '../../src/cli.ts';
import {ACCEPT_ALL, CORE_TARBALL, isSchemaTarget, onlyRoot, rootFor, rootForOpen, SCHEMA_FILES, sameRoot, schemaFileOf, schemaText, schemaUri} from '../../src/schemas.ts';

let tmp: string;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'svgd-schema-'))); });
afterEach(() => fs.rmSync(tmp, {recursive: true, force: true}));

/** A core at <dir>; with `schema` it ships the five files (0.8.0 and later). */
function core(dir: string, {schema = true, source = 'project' as ResolvedCli['source'], version = '0.8.0'} = {}): ResolvedCli {
  fs.mkdirSync(dir, {recursive: true});
  if (schema) {
    fs.mkdirSync(path.join(dir, 'schema'));
    for (const f of SCHEMA_FILES) fs.writeFileSync(path.join(dir, 'schema', f), JSON.stringify({title: `${f} of ${version}`}));
  }
  return {bin: path.join(dir, 'bin', 'svg-diagram'), source, root: dir, version};
}
const titleOf = (text: string) => JSON.parse(text).title;

test('the URIs name the five files and come back to them; the relative $ref stays in the scheme', () => {
  for (const f of SCHEMA_FILES) {
    const uri = new URL(schemaUri(f));
    assert.equal(uri.protocol, 'svg-diagram-schema:');
    assert.equal(schemaFileOf({authority: uri.host, path: uri.pathname}), f);
  }
  assert.equal(new URL('spec.schema.json#/definitions/parts', schemaUri('deck.schema.json')).href, `${schemaUri('spec.schema.json')}#/definitions/parts`);
  assert.equal(schemaFileOf({authority: 'schema', path: '/other.json'}), undefined);
  assert.equal(schemaFileOf({authority: 'other', path: '/spec.schema.json'}), undefined);
});

test('isSchemaTarget follows the fileMatch names, by basename, outside node_modules', () => {
  for (const yes of ['/p/.svg-diagram.json', '/p/site.json', '/p/deck.json', '/p/talks/deck-nov.json', '/p/a.deck.json']) assert.ok(isSchemaTarget(yes), yes);
  for (const no of ['/p/mydeck.json', '/p/my.svg-diagram.json', '/p/site.jsonc', '/p/deck.json.bak', '/p/node_modules/x/site.json', '/p/package.json']) assert.ok(!isSchemaTarget(no), no);
});

test("a project's own core is the root, and all five files come from it", () => {
  const cli = core(path.join(tmp, 'node_modules', 'svg-diagram'));
  const root = rootFor({cli, from: tmp, folder: tmp});
  assert.equal(root.dir, path.join(tmp, 'node_modules', 'svg-diagram', 'schema'));
  for (const f of SCHEMA_FILES) assert.equal(titleOf(schemaText(root, f)), `${f} of 0.8.0`);
});

test('a core older than 0.8.0 or none: everything is accepted, and the log says how to get one', () => {
  const old = rootFor({cli: core(path.join(tmp, 'node_modules', 'svg-diagram'), {schema: false, version: '0.5.0'}), from: tmp, folder: tmp});
  assert.equal(old.dir, undefined);
  assert.equal(schemaText(old, 'site.schema.json'), ACCEPT_ALL);
  assert.match(old.reason ?? '', /0\.5\.0.*JSON Schema が無い.*releases\/download\/v0\.8\.0\/svg-diagram-0\.8\.0\.tgz/);
  assert.match(rootFor({from: tmp}).reason ?? '', /見つからない/);
});

test('PATH and a user-level cliPath count only where a .svg-diagram.json is found from the file up', () => {
  const global = core(path.join(tmp, 'global'), {source: 'path'});
  const pkg = path.join(tmp, 'repo', 'packages', 'docs', 'slides');
  fs.mkdirSync(pkg, {recursive: true});
  assert.equal(rootFor({cli: global, from: pkg}).dir, undefined);
  assert.equal(rootFor({cli: {...global, source: 'setting'}, from: pkg, settingIsGlobal: true}).dir, undefined);
  // a workspace / folder setting is the project's own choice
  assert.ok(rootFor({cli: {...global, source: 'setting'}, from: pkg, settingIsGlobal: false}).dir);
  // a .svg-diagram.json above the file, below the workspace folder (monorepo)
  fs.writeFileSync(path.join(tmp, 'repo', 'packages', 'docs', '.svg-diagram.json'), '{}');
  assert.ok(rootFor({cli: global, from: pkg}).dir);
  assert.ok(rootFor({cli: {...global, source: 'setting'}, from: pkg, settingIsGlobal: true}).dir);
});

test('a node_modules/svg-diagram above the workspace folder is not the project\'s own', () => {
  const above = core(path.join(tmp, 'node_modules', 'svg-diagram'));
  const folder = path.join(tmp, 'work', 'repo');
  fs.mkdirSync(folder, {recursive: true});
  assert.equal(rootFor({cli: above, from: folder, folder}).dir, undefined);
  assert.match(rootFor({cli: above, from: folder, folder}).reason ?? '', /ワークスペースフォルダの外/);
  fs.writeFileSync(path.join(folder, '.svg-diagram.json'), '{}');
  assert.ok(rootFor({cli: above, from: folder, folder}).dir);
});

test("a user-level cliPath without .svg-diagram.json falls back to the project's own core", () => {
  const dev = core(path.join(tmp, 'core-checkout'), {source: 'setting', version: '0.9.0-dev'});
  const own = core(path.join(tmp, 'proj', 'node_modules', 'svg-diagram'));
  const folder = path.join(tmp, 'proj');
  const root = rootFor({cli: dev, projectCli: own, from: folder, folder, settingIsGlobal: true});
  assert.equal(root.dir, path.join(own.root ?? '', 'schema'));
  assert.equal(root.version, '0.8.0');
  // a workspace setting is the project's choice: the checkout is used
  assert.equal(rootFor({cli: dev, projectCli: own, from: folder, folder, settingIsGlobal: false}).version, '0.9.0-dev');
});

test('rootForOpen: one schema only when the open files agree on what is served', () => {
  const a = rootFor({cli: core(path.join(tmp, 'a', 'node_modules', 'svg-diagram')), folder: tmp});
  const b = rootFor({cli: core(path.join(tmp, 'b', 'node_modules', 'svg-diagram'), {version: '0.9.0'}), folder: tmp});
  const none = rootFor({});
  assert.equal(rootForOpen([]), undefined);
  assert.equal(rootForOpen([{name: 'x/site.json', root: a}, {name: 'x/deck.json', root: a}])?.dir, a.dir);
  assert.equal(rootForOpen([{name: 'u/site.json', root: none}])?.dir, undefined);
  const mixed = rootForOpen([{name: 'u/site.json', root: none}, {name: 'x/site.json', root: a}]);
  assert.equal(mixed?.dir, undefined);
  assert.match(mixed?.reason ?? '', /x\/site\.json（svg-diagram 0\.8\.0）と u\/site\.json（svg-diagram 無し）/);
  assert.equal(rootForOpen([{name: 'a/site.json', root: a}, {name: 'b/site.json', root: b}])?.dir, undefined);
  // a core without schemas is named as such, not as "no svg-diagram"
  const old = rootFor({cli: core(path.join(tmp, 'c', 'node_modules', 'svg-diagram'), {schema: false, version: '0.5.0'}), folder: tmp});
  assert.match(rootForOpen([{name: 'x/site.json', root: a}, {name: 'c/site.json', root: old}])?.reason ?? '', /c\/site\.json（svg-diagram 0\.5\.0、JSON Schema 無し）/);
});

test('one core reached by two paths (pnpm links), or two installs of the same schemas, agree', () => {
  const real = core(path.join(tmp, 'node_modules', '.pnpm', 'svg-diagram@0.8.0', 'node_modules', 'svg-diagram'));
  for (const pkg of ['a', 'b']) {
    fs.mkdirSync(path.join(tmp, 'packages', pkg, 'node_modules'), {recursive: true});
    fs.symlinkSync(real.root ?? '', path.join(tmp, 'packages', pkg, 'node_modules', 'svg-diagram'));
  }
  const viaA = rootFor({cli: {...real, root: path.join(tmp, 'packages', 'a', 'node_modules', 'svg-diagram')}, folder: tmp});
  const viaB = rootFor({cli: {...real, root: path.join(tmp, 'packages', 'b', 'node_modules', 'svg-diagram')}, folder: tmp});
  assert.ok(viaA.dir && viaB.dir && viaA.dir !== viaB.dir);
  assert.ok(rootForOpen([{name: 'a/site.json', root: viaA}, {name: 'b/deck.json', root: viaB}])?.dir);
  // a copy (npm, another folder) of the same version
  const copy = rootFor({cli: core(path.join(tmp, 'other', 'node_modules', 'svg-diagram')), folder: tmp});
  assert.ok(rootForOpen([{name: 'a/site.json', root: viaA}, {name: 'o/site.json', root: copy}])?.dir);
  assert.ok(onlyRoot([viaA, copy]).dir);
});

test('onlyRoot: several folders with different schemas cannot be chosen between', () => {
  const a = rootFor({cli: core(path.join(tmp, 'a', 'node_modules', 'svg-diagram')), folder: tmp});
  const b = rootFor({cli: core(path.join(tmp, 'b', 'node_modules', 'svg-diagram'), {version: '0.9.0'}), folder: tmp});
  const none = rootFor({});
  assert.equal(onlyRoot([none, a]).dir, a.dir);
  assert.equal(onlyRoot([a, a]).dir, a.dir);
  assert.equal(onlyRoot([a, b]).dir, undefined);
  assert.equal(onlyRoot([]).dir, undefined);
});

test('sameRoot: what is served; a core upgraded in place is new, and accept-all is the same whatever the reason', () => {
  const dir = path.join(tmp, 'node_modules', 'svg-diagram');
  const cli = core(dir);
  const a = rootFor({cli, folder: tmp});
  assert.ok(sameRoot(a, rootFor({cli, folder: tmp})));
  assert.ok(!sameRoot(undefined, a));
  // pnpm: unchanged files keep their times; only deck.schema.json changes
  fs.writeFileSync(path.join(dir, 'schema', 'deck.schema.json'), JSON.stringify({title: 'deck 0.8.1'}));
  assert.ok(!sameRoot(a, rootFor({cli: {...cli, version: '0.8.1'}, folder: tmp})));
  assert.ok(!sameRoot(a, rootFor({})));
  assert.ok(sameRoot(rootFor({}), {reason: 'another reason'}));
});

test('CORE_TARBALL is the v0.8.0 release asset', () => {
  assert.equal(CORE_TARBALL, 'https://github.com/cuzic/svg-diagram/releases/download/v0.8.0/svg-diagram-0.8.0.tgz');
});
