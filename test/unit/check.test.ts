import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {checkArgs, crashFinding, type Finding, findingMessage, isDiagramSource, parseCheckOutput, placeFinding} from '../../src/check.ts';

const f = (over: Partial<Finding>): Finding => ({file: '/p/a.ts', rule: 'r', severity: 'warn', message: 'm', ...over});

test('checkArgs asks for JSON', () => {
  assert.deepEqual(checkArgs(['/p/a.ts', '/p/b.ts']), ['check', '--format', 'json', '/p/a.ts', '/p/b.ts']);
});

test('parseCheckOutput: files become absolute against cwd; the counts are kept', () => {
  // the shape core prints (check-diagram.ts: {errors, warnings, findings})
  const out = parseCheckOutput(JSON.stringify({errors: 1, warnings: 0, findings: [{file: 'broken.ts', rule: 'build-error', severity: 'error', message: 'boom'}, {file: '/abs/x.ts', rule: 'x', severity: 'info', message: 'i'}]}), '/work');
  assert.equal(out.errors, 1);
  assert.deepEqual(out.findings.map(x => x.file), [path.resolve('/work/broken.ts'), path.resolve('/abs/x.ts')]);
});

test('parseCheckOutput: not JSON / no findings throws with the start of the output', () => {
  assert.throws(() => parseCheckOutput('Usage: svg-diagram check ...', '/w'), /JSON ではない: Usage/);
  assert.throws(() => parseCheckOutput('', '/w'), /（空）/);
  assert.throws(() => parseCheckOutput('{"ok":true}', '/w'), /findings がない/);
});

const src = [
  "import {diagram, row, box} from 'svg-diagram';",
  "export default diagram({title: '流れ'}).add(",
  "  row(box({label: '受付'}), box({label: \"審査\"}), box({label: '審査'})),",
  ');',
].join('\n');

test('placeFinding: a CLI line wins, from the first non-blank column', () => {
  const p = placeFinding(f({line: 3}), src);
  assert.deepEqual([p.line, p.start, p.approximate], [2, 2, false]);
  assert.equal(p.end, src.split('\n')[2]?.length);
});

test('placeFinding: a CLI column marks the callee identifier', () => {
  const {findings: [finding]} = parseCheckOutput(JSON.stringify({findings: [f({line: 3, column: 7})]}), '/p');
  assert.ok(finding);
  const {line, start, end, approximate} = placeFinding(finding, src);
  assert.deepEqual({line, start, end, approximate}, {line: 2, start: 6, end: 9, approximate: false});
  assert.equal(src.split('\n')[line]?.slice(start, end), 'box');
});

test('placeFinding: a column at a non-identifier marks one character', () => {
  const {start, end} = placeFinding(f({line: 3, column: 10}), src);
  assert.deepEqual([start, end], [9, 10]);
});

test('placeFinding: a column beyond the text marks the whole line', () => {
  const text = '  box()';
  for (const column of [text.length + 1, 50]) {
    const {line, start, end, approximate} = placeFinding(f({line: 1, column}), text);
    assert.deepEqual({line, start, end, approximate}, {line: 0, start: 2, end: text.length, approximate: false});
  }
});

test('placeFinding: a leading keyword gives way to the following identifier', () => {
  for (const [before, prefix, identifier] of [
    ['  throw ', 'new ', 'Error'], ['  ', 'await ', 'define'], ['  ', 'typeof\t', 'box'], ['  ', 'await new ', 'Example'],
  ] as const) {
    const text = `${before}${prefix}${identifier}()`;
    const {start, end} = placeFinding(f({line: 1, column: before.length + 1}), text);
    assert.equal(start, before.length + prefix.length, text);
    assert.equal(text.slice(start, end), identifier, text);
  }
  for (const text of ['new.target', 'await()', 'typeofThing()']) {
    const {start, end} = placeFinding(f({line: 1, column: 1}), text);
    assert.equal(text.slice(start, end), text.split(/[.(]/)[0]);
  }
});

test('placeFinding: a zero-width non-joiner or joiner can continue an identifier', () => {
  for (const joiner of ['\u200c', '\u200d']) {
    const identifier = `shared${joiner}Box`;
    const {start, end} = placeFinding(f({line: 1, column: 1}), `${identifier}()`);
    assert.deepEqual([start, end], [0, identifier.length]);
  }
});

test('placeFinding: a location in a helper marks the first line and links to the helper', () => {
  const entry = f({file: 'a.ts', location: {file: '../parts/共通.ts', line: 6, column: 4}, data: {band: '「受付」', fix: '幅を揃える'}});
  const {findings: [finding]} = parseCheckOutput(JSON.stringify({findings: [entry]}), '/work/diagrams');
  assert.ok(finding);
  const {file, line, start, end, approximate, relatedInformation} = placeFinding(finding, src);
  assert.deepEqual({file, line, start, end, approximate}, {
    file: path.resolve('/work/diagrams/a.ts'), line: 0, start: 0, end: src.split('\n')[0]?.length, approximate: true,
  });
  assert.match(findingMessage(finding), /共通\.ts:6:4/);
  assert.match(findingMessage(finding), /\n直し方: 幅を揃える$/);
  assert.deepEqual(relatedInformation, [
    {file: path.resolve('/work/parts/共通.ts'), line: 6, column: 4, label: '指摘箇所'},
  ]);
});

test('placeFinding: via retains the order of the callers', () => {
  const entry = f({file: 'a.ts', line: 3, column: 7, via: [{line: 5, column: 3}, {line: 8, column: 7}]});
  const {findings: [finding]} = parseCheckOutput(JSON.stringify({findings: [entry]}), '/work');
  assert.ok(finding);
  assert.deepEqual(placeFinding(finding, src).relatedInformation, [
    {file: path.resolve('/work/a.ts'), line: 5, column: 3, label: '呼び出し元'},
    {file: path.resolve('/work/a.ts'), line: 8, column: 7, label: '呼び出し元'},
  ]);
});

test('placeFinding: related locations resolve against the CLI cwd and link to each counterpart', () => {
  const {findings: [finding]} = parseCheckOutput(JSON.stringify({findings: [{
    ...f({file: 'a.ts', line: 3, column: 7, via: [{line: 5, column: 3}]}),
    related: [{file: '../parts.ts', line: 4, column: 9}, {file: 'a.ts', line: 3, column: 27}],
  }]}), '/work/diagrams');
  assert.ok(finding);
  assert.deepEqual(placeFinding(finding, src).relatedInformation, [
    {file: path.resolve('/work/diagrams/a.ts'), line: 5, column: 3, label: '呼び出し元'},
    {file: path.resolve('/work/parts.ts'), line: 4, column: 9, label: '相手'},
    {file: path.resolve('/work/diagrams/a.ts'), line: 3, column: 27, label: '相手'},
  ]);
});

test('placeFinding and findingMessage skip invalid CLI positions and keep valid ones', () => {
  for (const invalid of [{line: 0, column: 3}, {line: 4}, {line: 2, column: 0}, {line: 1.5, column: 2}]) {
    const bad = {file: 'bad.ts', ...invalid};
    const {findings: [finding]} = parseCheckOutput(JSON.stringify({findings: [{
      ...f({file: 'a.ts', data: {band: '「受付」', fix: '幅を揃える'}}),
      location: bad,
      via: [invalid, {line: 3, column: 7}],
      related: [bad, {file: 'parts.ts', line: 4, column: 9}],
    }]}), '/p');
    assert.ok(finding);
    const {line, relatedInformation} = placeFinding(finding, src);
    assert.equal(line, 2);
    assert.deepEqual(relatedInformation, [
      {file: path.resolve('/p/a.ts'), line: 3, column: 7, label: '呼び出し元'},
      {file: path.resolve('/p/parts.ts'), line: 4, column: 9, label: '相手'},
    ]);
    assert.equal(findingMessage(finding), 'm\n直し方: 幅を揃える');
  }
});

test('placeFinding: no line, the band label found once → on the label', () => {
  const p = placeFinding(f({data: {band: '「受付」'}}), src);
  assert.deepEqual([p.line, p.start, p.end, p.approximate], [2, 19, 21, true]);
  assert.equal(src.split('\n')[2]?.slice(p.start, p.end), '受付');
});

test('placeFinding: a label that appears twice (or not at all) goes to the first line', () => {
  for (const band of ['「審査」', '「無い」', '受付']) {
    const p = placeFinding(f({data: {band}}), src);
    assert.deepEqual([p.line, p.start, p.approximate], [0, 0, true], band);
  }
});

test('placeFinding: an unreadable file still gets a 1-character place', () => {
  assert.deepEqual(placeFinding(f({}), undefined), {file: '/p/a.ts', line: 0, start: 0, end: 1, approximate: true, finding: f({})});
});

test('findingMessage adds the fix when the CLI gives one', () => {
  assert.equal(findingMessage(f({message: '幅が揃っていない', data: {fix: 'cols で揃える'}})), '幅が揃っていない\n直し方: cols で揃える');
  assert.equal(findingMessage(f({message: 'x'})), 'x');
});

test('isDiagramSource: imports the DSL itself and has a default export; not the browser entry, not .d.ts, not other files', () => {
  const def = '\nexport default function define() { return diagram({}); }';
  assert.ok(isDiagramSource('a.ts', "import {diagram} from 'svg-diagram';" + def));
  assert.ok(isDiagramSource('a.mjs', 'import {box} from "svg-diagram"' + def));
  assert.ok(isDiagramSource('a.ts', "import type {X} from 'svg-diagram';\nconst {box} = await import('svg-diagram');" + def));
  assert.ok(isDiagramSource('a.ts', "import {diagram} from 'svg-diagram';\nfunction define() {}\nexport {define as default};"));
  assert.ok(!isDiagramSource('a.ts', "import {renderInBrowser} from 'svg-diagram/browser';" + def));
  assert.ok(!isDiagramSource('a.d.ts', "import {diagram} from 'svg-diagram';" + def));
  assert.ok(!isDiagramSource('a.md', "import {diagram} from 'svg-diagram';" + def));
  assert.ok(!isDiagramSource('a.ts', "import {x} from 'svg-diagram-extra';" + def));
});

test('isDiagramSource: a default export re-exported from another module counts; one only in a comment does not', () => {
  assert.ok(isDiagramSource('a.ts', "import {diagram} from 'svg-diagram';\nexport {default} from './other.ts';"));
  assert.ok(!isDiagramSource('parts.ts', "import {box} from 'svg-diagram';\n// export default function define() {}\nexport const x = 1;"));
  assert.ok(!isDiagramSource('parts.ts', "import {box} from 'svg-diagram';\n/* export default define */\nexport const x = 1;"));
  assert.ok(isDiagramSource('a.ts', "import {box} from 'svg-diagram';\nconst url = 'https://example.com'; export default () => box({title: url});"));
});

test('isDiagramSource: a `/*` inside a string does not hide the export (round 3, m1)', () => {
  const src = "import {diagram, icon} from 'svg-diagram';\nconst icons = 'icons/*.svg';\nexport default function define() { /** note */ return diagram({}); }";
  assert.ok(isDiagramSource('a.ts', src));
  assert.ok(isDiagramSource('a.ts', "import {box} from 'svg-diagram';\nconst u = 'https://x/*y';\n/* c */\nexport default () => box({title: u});"));
});

test('isDiagramSource: a barrel re-exporting a default under another name is not a diagram (round 3, m2)', () => {
  assert.ok(!isDiagramSource('index.ts', "import {box} from 'svg-diagram';\nexport {default as step} from './step.ts';"));
  assert.ok(isDiagramSource('a.ts', "import {box} from 'svg-diagram';\nexport {x, define as default};"));
});

test('isDiagramSource: a module of shared parts (no default export) is not a diagram', () => {
  assert.ok(!isDiagramSource('parts.ts', "import {box} from 'svg-diagram';\nexport const step = (t: string) => box({title: t});"));
});

// what core 0.5.0 prints when a source throws (check-diagram stops without JSON)
const crashStderr = (file: string) => `(node:1) [DEP0205] DeprecationWarning: \`module.register()\` is deprecated.
file://${file}:5
  throw new Error('fixture: わざと壊した図');
        ^

Error: fixture: わざと壊した図
    at define (file://${file}:5:9)
    at loadDiagram (file:///x/node_modules/svg-diagram/dist/lib/load-source.js:32:55)

Node.js v26.13.0
`;

test('crashFinding: the line of the source and the Error line', () => {
  assert.deepEqual(crashFinding('/w/broken.ts', crashStderr('/w/broken.ts')), {file: '/w/broken.ts', line: 5, rule: 'build-error', severity: 'error', message: 'Error: fixture: わざと壊した図'});
});

test('crashFinding: thrown inside the library → the frame in the source; a path with Japanese is URL-encoded by Node', () => {
  const file = '/w/図/a.ts';
  const enc = '/w/%E5%9B%B3/a.ts';
  const stderr = `file:///x/node_modules/svg-diagram/dist/lib/dsl.js:29
        throw new Error(\`bad theme\`);

Error: diagram({theme}) must be one of 1, 2
    at diagram (file:///x/node_modules/svg-diagram/dist/lib/dsl.js:29:15)
    at file://${enc}:4:16
`;
  const c = crashFinding(file, stderr);
  assert.equal(c.line, 4);
  assert.equal(c.message, 'Error: diagram({theme}) must be one of 1, 2');
});

test('crashFinding: a path through a symlink is matched by its real path (Node prints that one)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svgd-crash-'));
  try {
    fs.mkdirSync(path.join(dir, 'real'));
    fs.writeFileSync(path.join(dir, 'real', 'a.ts'), '');
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
    const real = fs.realpathSync(path.join(dir, 'real', 'a.ts'));
    const c = crashFinding(path.join(dir, 'link', 'a.ts'), `Error: x\n    at define (${pathToFileURL(real).href}:7:3)\n`);
    assert.equal(c.line, 7);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('crashFinding: nothing recognisable → first line, the last meaningful stderr line', () => {
  const c = crashFinding('/w/a.ts', 'svg-diagram: Node v20 cannot run the TypeScript sources\n');
  assert.equal(c.line, undefined);
  assert.equal(c.message, 'svg-diagram: Node v20 cannot run the TypeScript sources');
  assert.equal(crashFinding('/w/a.ts', '').message, 'check が JSON を出さずに失敗した');
});
