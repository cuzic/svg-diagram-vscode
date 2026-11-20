import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, test} from 'node:test';
import type {ResolvedCli} from '../../src/cli.ts';
import {ACCEPT_ALL, findSchema, SCHEMA_FILES, sameAnswer, schemaFileOf, schemaUri} from '../../src/schemas.ts';

let tmp: string;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'svgd-schema-'))); });
afterEach(() => fs.rmSync(tmp, {recursive: true, force: true}));

/** A core at <dir>; with `schema` it ships the five files (0.8.0 and later). */
function core(dir: string, {schema = true, source = 'project' as ResolvedCli['source'], version = '0.8.0'} = {}): ResolvedCli {
  if (schema) {
    fs.mkdirSync(path.join(dir, 'schema'), {recursive: true});
    for (const f of SCHEMA_FILES) fs.writeFileSync(path.join(dir, 'schema', f), JSON.stringify({title: `${f} of ${version}`}));
  } else fs.mkdirSync(dir, {recursive: true});
  return {bin: path.join(dir, 'bin', 'svg-diagram'), source, root: dir, version};
}

test('the URIs name the five files and come back to them', () => {
  for (const f of SCHEMA_FILES) {
    const uri = new URL(schemaUri(f));
    assert.equal(uri.protocol, 'svg-diagram-schema:');
    assert.equal(schemaFileOf(uri.pathname), f);
  }
  // the figure and deck schemas name spec.schema.json relatively: it must resolve to our own URI
  assert.equal(new URL('spec.schema.json#/definitions/parts', schemaUri('deck.schema.json')).href, `${schemaUri('spec.schema.json')}#/definitions/parts`);
  assert.equal(schemaFileOf('/other.json'), undefined);
  assert.equal(schemaFileOf('/../spec.schema.json'), undefined);
});

test("the project's core is served", () => {
  const cli = core(path.join(tmp, 'node_modules', 'svg-diagram'));
  const a = findSchema('site.schema.json', [{cli, folder: tmp}]);
  assert.equal(a.file, path.join(tmp, 'node_modules', 'svg-diagram', 'schema', 'site.schema.json'));
  assert.equal(JSON.parse(a.text).title, 'site.schema.json of 0.8.0');
  assert.equal(a.reason, undefined);
});

test('the first candidate with the schema wins; an old core is skipped and named when nothing has one', () => {
  const old = core(path.join(tmp, 'a'), {schema: false, version: '0.5.0'});
  const fresh = core(path.join(tmp, 'b'), {version: '0.9.0'});
  assert.equal(JSON.parse(findSchema('deck.schema.json', [{cli: old}, {cli: fresh}]).text).title, 'deck.schema.json of 0.9.0');
  const none = findSchema('deck.schema.json', [{}, {cli: old}]);
  assert.equal(none.text, ACCEPT_ALL);
  assert.match(none.reason ?? '', /0\.5\.0.*JSON Schema が無い.*0\.8\.0 以降/);
});

test('nothing found: everything is accepted', () => {
  const a = findSchema('config.schema.json', []);
  assert.deepEqual(JSON.parse(a.text), {$comment: JSON.parse(ACCEPT_ALL).$comment});
  assert.match(a.reason ?? '', /見つからない/);
});

test('a CLI found only on PATH counts only in a folder with .svg-diagram.json', () => {
  const global = core(path.join(tmp, 'global'), {source: 'path'});
  const folder = path.join(tmp, 'proj');
  fs.mkdirSync(folder);
  assert.equal(findSchema('site.schema.json', [{cli: global, folder}]).text, ACCEPT_ALL);
  fs.writeFileSync(path.join(folder, '.svg-diagram.json'), '{}');
  assert.ok(findSchema('site.schema.json', [{cli: global, folder}]).file);
  // the setting (an explicit choice) counts anywhere
  assert.ok(findSchema('site.schema.json', [{cli: {...global, source: 'setting'}, folder: tmp}]).file);
});

test('sameAnswer: a changed file or text is a new answer', () => {
  const cli = core(path.join(tmp, 'c'));
  const a = findSchema('spec.schema.json', [{cli}]);
  assert.ok(sameAnswer(a, findSchema('spec.schema.json', [{cli}])));
  assert.ok(!sameAnswer(undefined, a));
  assert.ok(!sameAnswer(a, {...a, mtimeMs: (a.mtimeMs ?? 0) + 1}));
  assert.ok(!sameAnswer(a, findSchema('spec.schema.json', [])));
  assert.ok(sameAnswer(findSchema('spec.schema.json', []), findSchema('spec.schema.json', [])));
});
