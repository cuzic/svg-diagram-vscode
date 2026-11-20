import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildArgs, buildErrorText, inlineSvg, previewShellHtml} from '../../src/preview-html.ts';

test('buildArgs: scratch output, no lint', () => {
  assert.deepEqual(buildArgs('/p/a.ts', '/s/a.svg'), ['build', '/p/a.ts', '--out', '/s/a.svg', '--no-lint']);
});

test('buildErrorText: the ✗ lines of a newer core', () => {
  const stderr = '(node:1) [DEP0205] DeprecationWarning: x\n✗ /p/a.ts: diagram({theme}) must be one of 1, 2\n  詳しくは README\n';
  assert.equal(buildErrorText('/p/a.ts', stderr), '/p/a.ts: diagram({theme}) must be one of 1, 2');
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
