import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildArgs, buildErrorText, inlineSvg, previewShellHtml} from '../../src/preview-html.ts';

test('buildArgs: scratch output, no lint', () => {
  assert.deepEqual(buildArgs('/p/a.ts', '/s/a.svg'), ['build', '/p/a.ts', '--out', '/s/a.svg', '--no-lint']);
});

test('buildErrorText: the ✗ lines of a newer core', () => {
  const stderr = '(node:1) [DEP0205] DeprecationWarning: x\n✗ /p/a.ts: diagram({theme}) must be one of 1, 2\n  詳しくは README\n';
  assert.equal(buildErrorText('/p/a.ts', stderr), 'diagram({theme}) must be one of 1, 2'); // the title names the file
});

test('buildErrorText: a same-file location shows only the message and line', () => {
  const file = '/p/共有 図/a.ts';
  const stderr = `✗ ${file}:12:5: Error: 幅が揃っていない\n`;
  assert.equal(buildErrorText(file, stderr), 'Error: 幅が揃っていない（12 行目）');
});

test('buildErrorText: a helper inside the workspace is shown relative to its root', () => {
  const file = '/p/project/diagrams/a.ts';
  for (const helper of ['/p/project/共有 部品/parts.ts', '../共有 部品/parts.ts']) {
    const stderr = `✗ ${file}: ${helper}:12:5: Error: 幅が揃っていない\n`;
    assert.equal(buildErrorText(file, stderr, '/p/project'), '共有 部品/parts.ts:12:5: Error: 幅が揃っていない');
  }
});

test('buildErrorText: a helper outside the workspace keeps its absolute path', () => {
  const file = '/p/project/diagrams/a.ts';
  for (const helper of ['/p/project-shared/parts.ts', '../../project-shared/parts.ts']) {
    const stderr = `✗ ${file}: ${helper}:12:5: Error: 幅が揃っていない\n`;
    assert.equal(buildErrorText(file, stderr, '/p/project'), '/p/project-shared/parts.ts:12:5: Error: 幅が揃っていない');
  }
});

test('buildErrorText: a helper is shown with an absolute path when there is no workspace', () => {
  assert.equal(buildErrorText('/p/diagrams/a.ts', '✗ /p/diagrams/a.ts: ../parts.ts:12:5: 失敗'), '/p/parts.ts:12:5: 失敗');
});

test('buildErrorText: a layout failure shows all its details without the scratch path', () => {
  const file = '/p/project/diagrams/a.ts';
  const summary = 'layout verification failed before any SVG was written:';
  for (const [position, headline] of [
    [': ', summary],
    [':5:2: ', `${summary}（5 行目）`],
    [': ../parts.ts:4:14: ', `parts.ts:4:14: ${summary}`],
  ]) {
    const stderr = [
      `✗ ${file}${position}build(/scratch/layout.svg): ${summary}`,
      '  connect(a:right -> b:left) overlaps its own end',
      '  box extends beyond the canvas',
      '(node:1) [DEP0205] DeprecationWarning: x',
      '  unrelated warning continuation',
      `✗ ${file}: another error`,
    ].join('\r\n');
    assert.equal(buildErrorText(file, stderr, '/p/project'), [
      headline,
      'connect(a:right -> b:left) overlaps its own end',
      'box extends beyond the canvas',
      'another error',
    ].join('\n'));
  }
});

test('buildErrorText: a layout block formats each same-file or helper location', () => {
  const file = '/p/project/diagrams/a.ts';
  const stderr = [
    `✗ ${file}:`,
    '  a.ts:12:5: 部品が重なっている',
    `  ${file}:13:5: 揃っていない`,
    '  ../共有 部品/parts.ts:4:14: 共通部品のエラー',
    '  /p/project-shared/parts.ts:3:12: 別のエラー',
    '  位置がないエラー',
  ].join('\n');
  assert.equal(buildErrorText(file, stderr, '/p/project'), [
    '部品が重なっている（12 行目）',
    '揃っていない（13 行目）',
    '共有 部品/parts.ts:4:14: 共通部品のエラー',
    '/p/project-shared/parts.ts:3:12: 別のエラー',
    '位置がないエラー',
  ].join('\n'));
});

test('buildErrorText: a 0.5.0 crash → the Error line and the line of the source', () => {
  const stderr = 'file:///p/a.ts:5\n  throw new Error(\'x\');\n\nError: fixture: 壊れた\n    at define (file:///p/a.ts:5:9)\n\nNode.js v26.13.0\n';
  assert.equal(buildErrorText('/p/a.ts', stderr), 'Error: fixture: 壊れた（5 行目）');
});

test('buildErrorText: otherwise the meaningful stderr, or a fixed sentence', () => {
  assert.equal(buildErrorText('/p/a.ts', 'something odd\n'), 'something odd');
  assert.equal(buildErrorText('/p/a.ts', '(node:1) [DEP0205] DeprecationWarning: x\nNode.js v26\n'), 'build が失敗した（出力なし）');
});

test('inlineSvg drops the XML prolog and doctype only', () => {
  assert.equal(inlineSvg('﻿<?xml version="1.0"?>\n<!DOCTYPE svg>\n<svg/>'), '<svg/>');
  assert.equal(inlineSvg('<svg><text>&lt;?xml</text></svg>'), '<svg><text>&lt;?xml</text></svg>');
});

test('the page: strict CSP with the nonce; the only script carries it', () => {
  const html = previewShellHtml({cspSource: 'vscode-webview://x', nonce: 'N0nce'});
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-N0nce';/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map(m => m[0]);
  assert.deepEqual(scripts, ['<script nonce="N0nce">']);
});

test('the page script parses (its regexes survive the template literal)', () => {
  const html = previewShellHtml({cspSource: 'c', nonce: 'n'});
  const body = html.match(/<script nonce="n">([\s\S]*?)<\/script>/)?.[1] ?? '';
  assert.doesNotThrow(() => new Function(body));
  assert.match(body, /\/\\bbg-\\w\+\//);
});
