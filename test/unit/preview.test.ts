import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {runInNewContext} from 'node:vm';
import {buildSync} from 'esbuild';
import type {Uri, WebviewPanel} from 'vscode';
import type {PreviewManager as Manager} from '../../src/preview.ts';
import type {ToPage} from '../../src/preview-html.ts';

const bundle = buildSync({entryPoints: ['src/preview.ts'], bundle: true, write: false,
  external: ['vscode'], platform: 'node', format: 'cjs', target: 'node22'}).outputFiles[0]?.text ?? '';
assert.ok(bundle);
const require = createRequire(import.meta.url);

const svg = '<svg width="100" height="80" viewBox="0 0 100 80"></svg>';
const fileUri = (fsPath: string) => ({fsPath, scheme: 'file', toString: () => fsPath});
const source = fileUri(path.resolve('source.diagram.ts'));
const viewColumn = {One: 1, Two: 2, Three: 3};
const changed = '図が新しくなった。もう一度押してください';
const stale = '保存前の位置です';

function deferred<T>() {
  let resolve: (value: T) => void = () => assert.fail('promise executor did not run');
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}

function preview() {
  const document = {uri: source, version: 1, isDirty: false,
    getText: () => 'box()', validateRange: (range: unknown) => range};
  const documentOpen = deferred<typeof document>();
  const probe = deferred<void>();
  const posts: ToPage[] = [];
  const columns: number[] = [];
  const notices: string[] = [];
  const opened: string[] = [];
  let receive: (message: unknown) => void = () => assert.fail('no webview listener');
  let dispose = () => {};
  let failBuild = false;
  const subscription = {dispose() {}};
  const panel = {
    viewColumn: viewColumn.Two,
    webview: {
      postMessage: (message: ToPage) => posts.push(message),
      onDidReceiveMessage: (listener: typeof receive) => { receive = listener; },
    },
    onDidDispose: (listener: () => void) => { dispose = listener; },
    dispose: () => dispose(),
    reveal() {},
  };
  const vscode = {
    ViewColumn: viewColumn,
    TextEditorRevealType: {InCenterIfOutsideViewport: 0},
    Range: class {},
    Uri: {file: fileUri, joinPath: (base: typeof source, name: string) => fileUri(path.join(base.fsPath, name))},
    workspace: {
      textDocuments: [document],
      onDidSaveTextDocument: () => subscription,
      getWorkspaceFolder: () => undefined,
      openTextDocument: (uri: typeof source) => {
        opened.push(uri.fsPath);
        return documentOpen.promise;
      },
    },
    window: {
      visibleTextEditors: [] as {document: typeof document; viewColumn: number}[],
      registerWebviewPanelSerializer: () => subscription,
      onDidChangeActiveTextEditor: () => subscription,
      setStatusBarMessage: (message: string) => notices.push(message),
      showTextDocument: async (_document: unknown, options: {viewColumn: number}) => {
        columns.push(options.viewColumn);
        return {revealRange() {}};
      },
    },
  };
  const fs = {
    mkdir: async () => {},
    mkdtemp: async (prefix: string) => prefix + '123',
    rm: async () => {},
    stat: async () => ({isFile: () => true}),
    readFile: async (file: string) => file.endsWith('.svg') ? svg : JSON.stringify({
      version: 1, width: 100, height: 80,
      parts: [{kind: 'box', rect: {x: 2, y: 3, w: 30, h: 20}, loc: {file: source.fsPath, line: 1, column: 1}}],
      connects: [],
    }),
  };
  const childProcess = {
    execFile(_bin: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) {
      if (args.length === 1) void probe.promise.then(() => callback(null, 'Usage: build [--locations FILE]', ''));
      else if (failBuild) callback(new Error('build failed'), '', 'build failed');
      else callback(null, '', '');
    },
  };
  const module = {exports: {} as {PreviewManager: new (deps: unknown) => Manager}};
  runInNewContext(bundle, {
    module, AbortController,
    require: (id: string) => {
      if (id === 'vscode') return vscode;
      if (id === 'node:fs/promises') return fs;
      if (id === 'node:child_process') return childProcess;
      return require(id);
    },
  });
  const manager = new module.exports.PreviewManager({
    getCli: () => ({bin: 'svg-diagram', source: 'project'}),
    log: {warn() {}},
    scratchDir: fileUri(path.resolve('scratch')),
  });
  const start = () => manager.deserializeWebviewPanel(panel as unknown as WebviewPanel, {last: {file: source.fsPath}});
  function lastDrawing() {
    const drawing = manager.lastMessage;
    assert.ok(drawing?.kind === 'svg' && drawing.map);
    return drawing;
  }
  async function draw() {
    probe.resolve();
    await start();
    await setImmediate();
    return lastDrawing();
  }
  return {document, documentOpen, probe, posts, columns, notices, opened, panel, vscode, manager, start, lastDrawing, draw,
    failBuild: () => { failBuild = true; },
    receive: (message: unknown) => receive(message),
  };
}

test('ready replays the latest drawing before the error and its build token still reveals', async () => {
  const p = preview();
  p.documentOpen.resolve(p.document);
  const original = await p.draw();
  await p.manager.render();
  const latest = p.lastDrawing();
  assert.notEqual(latest.build, original.build);
  p.failBuild();
  await p.manager.render();
  const error = p.manager.lastMessage;
  assert.equal(error?.kind, 'error');

  p.posts.length = 0;
  p.receive({kind: 'ready'});
  assert.deepEqual(p.posts, [latest, error]);
  const drawing = p.posts[0];
  assert.equal(drawing?.kind, 'svg');
  p.receive({kind: 'reveal', build: drawing.build, id: 0});
  await setImmediate();
  assert.deepEqual(p.columns, [viewColumn.One]);
  assert.deepEqual(p.notices, []);
});

test('ready sends a current SVG once and does not replay it after switching sources', async () => {
  const p = preview();
  const drawing = await p.draw();
  p.posts.length = 0;
  p.receive({kind: 'ready'});
  assert.deepEqual(p.posts, [drawing]);

  p.failBuild();
  p.manager.show(fileUri(path.resolve('other.diagram.ts')) as unknown as Uri, viewColumn.One);
  await setImmediate();
  assert.equal(p.manager.lastMessage?.kind, 'error');
  p.posts.length = 0;
  p.receive({kind: 'ready'});
  assert.deepEqual(p.posts, [p.manager.lastMessage]);
});

test('an edit during the build probe makes a later reveal warn even when the document is clean', async () => {
  const p = preview();
  await p.start();
  assert.equal(p.manager.lastMessage?.kind, 'building');
  p.document.version++;
  p.probe.resolve();
  await setImmediate();
  const drawing = p.lastDrawing();
  p.failBuild();
  await p.manager.render();
  assert.equal(p.manager.lastMessage?.kind, 'error');
  p.documentOpen.resolve(p.document);
  p.receive({kind: 'reveal', build: drawing.build, id: 0});
  await setImmediate();
  assert.deepEqual(p.columns, [viewColumn.One]);
  assert.deepEqual(p.notices, [stale]);
});

test('a dirty document warns, and reveal prefers its visible editor outside the preview column', async () => {
  const p = preview();
  p.panel.viewColumn = viewColumn.One;
  p.vscode.window.visibleTextEditors.push(
    {document: p.document, viewColumn: viewColumn.One},
    {document: p.document, viewColumn: viewColumn.Three},
  );
  p.documentOpen.resolve(p.document);
  const drawing = await p.draw();
  p.document.isDirty = true;
  p.receive({kind: 'reveal', build: drawing.build, id: 0});
  await setImmediate();
  assert.deepEqual(p.columns, [viewColumn.Three]);
  assert.deepEqual(p.notices, [stale]);
});

test('reveal without a visible source opens in the first column outside the preview', async () => {
  const p = preview();
  p.panel.viewColumn = viewColumn.One;
  p.documentOpen.resolve(p.document);
  const drawing = await p.draw();
  p.receive({kind: 'reveal', build: drawing.build, id: 0});
  await setImmediate();
  assert.deepEqual(p.columns, [viewColumn.Two]);
  assert.deepEqual(p.notices, []);
});

test('an old build token shows the drawing-changed notice without opening an editor', async () => {
  const p = preview();
  p.documentOpen.resolve(p.document);
  await p.draw();
  p.receive({kind: 'reveal', build: 'old-build', id: 0});
  await setImmediate();
  assert.deepEqual(p.opened, []);
  assert.deepEqual(p.columns, []);
  assert.deepEqual(p.notices, [changed]);
});

test('a newer drawing while openTextDocument is pending cancels the reveal and warns', async () => {
  const p = preview();
  const drawing = await p.draw();
  p.receive({kind: 'reveal', build: drawing.build, id: 0});
  await setImmediate();
  assert.deepEqual(p.opened, [source.fsPath]);
  await p.manager.render();
  p.documentOpen.resolve(p.document);
  await setImmediate();
  assert.deepEqual(p.columns, []);
  assert.deepEqual(p.notices, [changed]);
});

test('closing the panel while openTextDocument is pending cancels reveal without a notice', async () => {
  const p = preview();
  const drawing = await p.draw();
  p.receive({kind: 'reveal', build: drawing.build, id: 0});
  await setImmediate();
  assert.deepEqual(p.opened, [source.fsPath]);
  p.panel.dispose();
  p.documentOpen.resolve(p.document);
  await setImmediate();
  assert.deepEqual(p.columns, []);
  assert.deepEqual(p.notices, []);
});
