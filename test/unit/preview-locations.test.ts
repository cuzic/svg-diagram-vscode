import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {buildSync} from 'esbuild';
import {previewShellHtml, type ToPage} from '../../src/preview-html.ts';
import {hitTest, readPreviewLocations, revealTarget, tableAfterMessage, type PreviewMap} from '../../src/preview-locations.ts';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80" viewBox="0 0 100 80"></svg>';
const rect = {x: 2, y: 3, w: 30, h: 20};
const part = (line: number, label: string) => ({kind: 'box', label, rect, loc: {file: '../project/図.ts', line, column: 5}});
const connect = {loc: {file: '../shared/parts.ts', line: 14, column: 9}, rect, segments: [[2, 3, 32, 23]]};
const locations = {
  version: 1, source: '../project/図.ts', width: 100, height: 80,
  parts: [
    {...part(4, '隠れた箱'), final: false},
    {...part(7, '箱'), via: [{line: 3, column: 2}]},
    part(8, '(band)'),
    {...part(9, 'group title "G"'), generated: true},
  ],
  connects: [{...connect, final: false}, {...connect, label: '線'}],
};
const mapFile = '/scratch/drawing.locations.json';
const drawing = {kind: 'svg', file: '/project/図.ts', build: 'session-2', title: '図.ts', builtAt: '', svg} as const;

test('the page gets only final geometry, with public labels and consecutive IDs across parts and connects', () => {
  const parsed = readPreviewLocations(JSON.stringify(locations), mapFile, svg);
  assert.ok(parsed);
  assert.deepEqual(parsed.map, {
    parts: [
      {id: 0, kind: 'box', label: '箱', rect},
      {id: 1, kind: 'box', rect},
      {id: 2, kind: 'box', rect},
    ],
    connects: [{id: 3, kind: 'connect', segments: [[2, 3, 32, 23]]}],
  });
  assert.deepEqual(parsed.targets[0], {loc: {file: '/project/図.ts', line: 7, column: 5}, via: [{line: 3, column: 2}]});
  assert.deepEqual(parsed.targets[3], {loc: {file: '/shared/parts.ts', line: 14, column: 9}});
});

test('unreadable, malformed and mismatched maps leave the SVG without links', () => {
  for (const value of [
    '{', 'null', JSON.stringify({...locations, version: 2}), JSON.stringify({...locations, width: 99}),
    JSON.stringify({...locations, height: 81}), JSON.stringify({...locations, parts: [null]}),
    JSON.stringify({...locations, connects: [{...connect, segments: [[1, 2, 3]]}]}),
  ]) assert.equal(readPreviewLocations(value, mapFile, svg), undefined);
  assert.equal(readPreviewLocations(JSON.stringify(locations), mapFile, svg.replace('0 0 100', '1 0 100')), undefined);
  assert.equal(readPreviewLocations(JSON.stringify(locations), mapFile, svg.replace('width="100"', 'width="99"')), undefined);
});

test('reveal validates the build and integer bounds, then resolves part and connector IDs in the same table', () => {
  const parsed = readPreviewLocations(JSON.stringify(locations), mapFile, svg);
  const table = tableAfterMessage(undefined, drawing, parsed, 4);
  const message = {kind: 'reveal', build: drawing.build, id: 0};
  assert.equal(table?.sourceVersion, 4);
  assert.equal(revealTarget(table, message)?.loc.line, 7);
  assert.equal(revealTarget(table, {...message, id: 3})?.loc.line, 14);
  assert.equal(revealTarget(table, {...message, file: '/forged.ts'})?.loc.file, '/project/図.ts');
  assert.equal(revealTarget(table, {...message, build: 'prior-session-2'}), undefined);
  assert.equal(revealTarget(table, {...message, kind: 'ready'}), undefined);
  for (const id of [-1, 4, 0.5, NaN, Infinity, '0', '__proto__', null]) {
    assert.equal(revealTarget(table, {...message, id}), undefined, String(id));
  }
});

test('a failed build keeps the last table for that file, a source switch or an unmapped SVG clears it', () => {
  const parsed = readPreviewLocations(JSON.stringify(locations), mapFile, svg);
  const prior = tableAfterMessage(undefined, drawing, parsed, 4);
  assert.ok(prior);
  const building: ToPage = {kind: 'building', file: drawing.file, title: drawing.title};
  const failed: ToPage = {...building, kind: 'error', message: 'build failed'};
  const during = tableAfterMessage(prior, building);
  assert.equal(during, prior);
  assert.equal(tableAfterMessage(during, failed, parsed, 5), prior);
  assert.equal(tableAfterMessage(prior, {...building, file: '/project/other.ts'}), undefined);
  assert.equal(tableAfterMessage(prior, {...drawing, build: 'session-3'}), undefined);
  assert.equal(tableAfterMessage(prior, {...drawing, build: 'session-3'}, parsed)?.build, 'session-3');
});

const elbow = {id: 4, kind: 'connect' as const, rect: {x: 0, y: 0, w: 100, h: 80}, segments: [[0, 0, 100, 0], [100, 0, 100, 80]] as PreviewMap['connects'][number]['segments']};
const geometry: PreviewMap = {
  parts: [
    {id: 0, kind: 'group', rect: {x: 0, y: 0, w: 100, h: 80}},
    {id: 1, kind: 'caption', rect: {x: 10, y: 10, w: 80, h: 10}},
    {id: 2, kind: 'box', rect: {x: 20, y: 30, w: 30, h: 40}},
    {id: 3, kind: 'box', rect: {x: 20, y: 30, w: 30, h: 40}},
  ],
  connects: [elbow, {id: 5, kind: 'connect', segments: [[0, 2, 100, 2], [120, 50, 120, 50]]}],
};

const hits = [
  ['box inside the connector bounding rectangle', {x: 35, y: 40}, 1, 3],
  ['group title inside the connector bounding rectangle', {x: 30, y: 15}, 1, 1],
  ['closest segment wins over a part and a later segment', {x: 50, y: 0.5}, 1, 4],
  ['later segment breaks a distance tie', {x: 50, y: 1}, 1, 5],
  ['distance reaches the endpoint and includes exactly 5px', {x: 105, y: 80}, 1, 4],
  ['point segment can be hit', {x: 120, y: 53}, 1, 5],
  ['200% zoom makes 3 SVG units exceed the 5px tolerance', {x: 50, y: 5}, 0.5, 0],
  ['fit shrinks the SVG and increases tolerance in SVG units', {x: 50, y: 9}, 2, 5],
  ['outside every part and segment', {x: 110, y: 90}, 1, undefined],
] as const;

for (const [name, point, ratio, expected] of hits) {
  test(`hitTest: ${name}`, () => assert.equal(hitTest(geometry, point, ratio)?.id, expected));
}

function checkEmbeddedHitTest(shell: typeof previewShellHtml): void {
  const html = shell({cspSource: 'c', nonce: 'n'});
  const script = html.match(/<script nonce="n">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  // Probe the name the page actually calls, inside its own script scope.
  const probe = script.replace(/\n\}\)\(\);\s*$/, '\n  result = cases.map(([, point, ratio]) => hitTest(geometry, point, ratio)?.id);\n})();');
  const element = {style: {}, classList: {toggle() {}}, className: 'bg-light', addEventListener() {}, setAttribute() {}, querySelector() { return null; }};
  const context = {
    document: {getElementById: () => element},
    window: {addEventListener() {}},
    acquireVsCodeApi: () => ({getState() {}, setState() {}, postMessage() {}}),
    cases: hits, geometry, result: undefined,
  };
  runInNewContext(probe, context);
  assert.ok(Array.isArray(context.result));
  assert.deepEqual(Array.from(context.result), hits.map(([, , , id]) => id));
}

test('the embedded page can call hitTest', () => checkEmbeddedHitTest(previewShellHtml));

test('the production-minified page can call hitTest', () => {
  const output = buildSync({entryPoints: ['src/preview-html.ts'], bundle: true, write: false,
    platform: 'node', format: 'cjs', target: 'node22', minify: true}).outputFiles[0];
  assert.ok(output);
  const module = {exports: {previewShellHtml}};
  runInNewContext(output.text, {module, require: createRequire(import.meta.url)});
  checkEmbeddedHitTest(module.exports.previewShellHtml);
});
