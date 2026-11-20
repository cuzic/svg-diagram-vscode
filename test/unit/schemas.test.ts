import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, test} from 'node:test';
import type {ResolvedCli} from '../../src/cli.ts';
import {ACCEPT_ALL, isSchemaTarget, onlyRoot, rootFor, SCHEMA_FILES, sameRoot, schemaFileOf, schemaText, schemaUri} from '../../src/schemas.ts';

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
  const root = rootFor({cli, from: tmp});
  assert.equal(root.dir, path.join(tmp, 'node_modules', 'svg-diagram', 'schema'));
  for (const f of SCHEMA_FILES) assert.equal(titleOf(schemaText(root, f)), `${f} of 0.8.0`);
});

test('a core older than 0.8.0 or none: everything is accepted, and the log says how to get one', () => {
  const old = rootFor({cli: core(path.join(tmp, 'old'), {schema: false, version: '0.5.0'}), from: tmp});
  assert.equal(old.dir, undefined);
  assert.equal(schemaText(old, 'site.schema.json'), ACCEPT_ALL);
  assert.match(old.reason ?? '', /0\.5\.0.*JSON Schema が無い.*github:cuzic\/svg-diagram#v0\.8\.0/);
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

test('onlyRoot: several folders with svg-diagram cannot be chosen between', () => {
  const a = rootFor({cli: core(path.join(tmp, 'a'))});
  const b = rootFor({cli: core(path.join(tmp, 'b'))});
  const none = rootFor({});
  assert.equal(onlyRoot([none, a]).dir, a.dir);
  assert.equal(onlyRoot([a, a]).dir, a.dir);
  assert.equal(onlyRoot([a, b]).dir, undefined);
  assert.equal(onlyRoot([]).dir, undefined);
});

test('sameRoot: another core, or the same core upgraded in place, is a new root', () => {
  const cli = core(path.join(tmp, 'c'));
  const a = rootFor({cli});
  assert.ok(sameRoot(a, rootFor({cli})));
  assert.ok(!sameRoot(undefined, a));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(tmp, 'c', 'schema', 'spec.schema.json'), later, later);
  assert.ok(!sameRoot(a, rootFor({cli})));
  assert.ok(!sameRoot(a, rootFor({})));
  assert.ok(sameRoot(rootFor({}), rootFor({})));
});
