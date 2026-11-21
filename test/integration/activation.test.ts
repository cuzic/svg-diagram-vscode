// Runs inside a real VS Code (pnpm test:integration; CI runs it under xvfb).
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import {resolveCli} from '../../src/cli.ts';
import {PreviewManager} from '../../src/preview.ts';

const locationCli = 'finding-locations-cli.sh';

function locationFixture(): vscode.Uri {
  const base = vscode.workspace.workspaceFolders?.find(folder => folder.name === 'workspace')?.uri;
  assert.ok(base, 'no fixture workspace folder');
  return base;
}

function fixtureSettings(base: vscode.Uri): string {
  return vscode.Uri.joinPath(base, '.vscode', 'settings.json').fsPath;
}

suiteSetup(async () => {
  const base = locationFixture();
  const config = vscode.workspace.getConfiguration('svgDiagram', base);
  const settings = fixtureSettings(base);
  const legacyContents = fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : undefined;
  // Clear overrides left by interrupted runs, including the old workspace-folder override.
  if (config.inspect<string>('cliPath')?.workspaceFolderValue === './' + locationCli) {
    await config.update('cliPath', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  }
  if (legacyContents && /^\s*\{\s*(?:"svgDiagram\.cliPath"\s*:\s*"\.\/finding-locations-cli\.sh"\s*,?\s*)?\}\s*$/.test(legacyContents)) {
    fs.rmSync(settings, {force: true});
  }
  if (config.inspect<string>('cliPath')?.globalValue === vscode.Uri.joinPath(base, locationCli).fsPath) {
    await config.update('cliPath', undefined, vscode.ConfigurationTarget.Global);
  }
});

suite('activation', () => {
  test('the extension activates and registers its commands', async () => {
    const ext = vscode.extensions.getExtension('cuzic.svg-diagram-vscode');
    assert.ok(ext, 'extension not found');
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('svgDiagram.showOutput'));
  });
});

suite('cli', () => {
  test('svgDiagram.showCli runs without throwing', async () => {
    await vscode.commands.executeCommand('svgDiagram.showCli');
  });

  test('the fake CLI leaves fixture workspace settings untouched', async () => {
    const settings = fixtureSettings(locationFixture());
    const readSettings = () => fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : undefined;
    const before = readSettings();
    await withLocationCli(async () => {
      assert.deepEqual(readSettings(), before);
    });
    assert.deepEqual(readSettings(), before);
  });
});

async function withLocationCli(run: (base: vscode.Uri) => Promise<void>): Promise<void> {
  const base = locationFixture();
  const config = vscode.workspace.getConfiguration('svgDiagram', base);
  // The VS Code test runner gives this instance its own user data directory.
  const previous = config.inspect<string>('cliPath')?.globalValue;
  const target = vscode.ConfigurationTarget.Global;
  try {
    await config.update('cliPath', vscode.Uri.joinPath(base, locationCli).fsPath, target);
    await run(base);
  } finally {
    await config.update('cliPath', previous, target);
  }
}

suite('check → Problems', () => {
  // test/fixtures/workspace has svg-diagram 0.9.0 (the GitHub release tarball) in node_modules (CI: npm install there before the run)
  const folder = () => vscode.workspace.workspaceFolders?.[0]?.uri;

  async function diagnosticsOf(name: string, timeoutMs = 60_000): Promise<vscode.Diagnostic[]> {
    const base = folder();
    assert.ok(base, 'no workspace folder');
    const uri = vscode.Uri.joinPath(base, name);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    for (const end = Date.now() + timeoutMs; Date.now() < end; await new Promise(r => setTimeout(r, 200))) {
      const found = vscode.languages.getDiagnostics(uri).filter(d => d.source === 'svg-diagram');
      if (found.length) return found;
    }
    assert.fail(`no svg-diagram diagnostics for ${name} within ${timeoutMs}ms`);
  }

  test('a finding from the JSON output (no title) is a warning', async () => {
    const [d, ...rest] = await diagnosticsOf('untitled.diagram.ts');
    assert.equal(rest.length, 0);
    assert.equal(d?.code, 'a11y-no-title');
    assert.equal(d?.severity, vscode.DiagnosticSeverity.Warning);
  });

  test('a source that throws is a build-error', async () => {
    const [d] = await diagnosticsOf('broken.diagram.ts');
    assert.equal(d?.code, 'build-error');
    assert.equal(d?.severity, vscode.DiagnosticSeverity.Error);
    // Core 0.9.0 includes the position of the throw in its JSON.
    assert.equal(d?.range.start.line, 4);
    assert.match(d?.message ?? '', /わざと壊した図/);
  });

  test('CLI locations set the Problems range and related information', () => withLocationCli(async base => {
    const source = vscode.Uri.joinPath(base, 'locations', 'located.diagram.ts');
    const parts = vscode.Uri.joinPath(base, 'parts.ts');
    await vscode.commands.executeCommand('svgDiagram.checkFile', source);
    const diagnostics = vscode.languages.getDiagnostics(source).filter(d => d.source === 'svg-diagram');
    assert.equal(diagnostics.length, 2);

    const local = diagnostics.find(d => d.code === 'overlap');
    assert.ok(local);
    assert.ok(local.range.isEqual(new vscode.Range(5, 4, 5, 7)), 'the range should cover only box');
    assert.deepEqual(relatedDetails(local), [
      {file: source.fsPath, line: 4, column: 34, label: '呼び出し元'},
      {file: parts.fsPath, line: 3, column: 39, label: '相手'},
    ]);

    const elsewhere = diagnostics.find(d => d.code === 'build-error');
    assert.ok(elsewhere);
    assert.equal(elsewhere.range.start.line, 0);
    assert.equal(elsewhere.message, 'parts.ts:4:14: 共通部品のエラー');
    assert.deepEqual(relatedDetails(elsewhere), [
      {file: parts.fsPath, line: 3, column: 13, label: '指摘箇所'},
    ]);
  }));

  function relatedDetails(diagnostic: vscode.Diagnostic) {
    return diagnostic.relatedInformation?.map(({message, location}) => ({
      file: location.uri.fsPath, line: location.range.start.line, column: location.range.start.character, label: message,
    }));
  }
});

suite('preview', () => {
  test('the core location map reveals a connector in the source editor beside the preview', async function () {
    this.timeout(60_000);
    const base = locationFixture();
    const uri = vscode.Uri.joinPath(base, 'preview-links.diagram.ts');
    const {cli} = resolveCli({folder: base.fsPath, env: {}});
    assert.equal(cli?.version, '0.9.0');
    const document = await vscode.workspace.openTextDocument(uri);
    const start = new vscode.Range(0, 0, 0, 0);
    await vscode.window.showTextDocument(document, {viewColumn: vscode.ViewColumn.One, selection: start});
    const log = vscode.window.createOutputChannel('svg-diagram preview test', {log: true});
    const scratch = vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'svgd-preview-test-')));
    const viewType = 'svgDiagram.preview.test';
    const manager = new PreviewManager({getCli: () => cli, log, scratchDir: scratch}, viewType);
    const panel = vscode.window.createWebviewPanel(viewType, 'Preview test', vscode.ViewColumn.Two);
    try {
      await manager.deserializeWebviewPanel(panel, {last: {file: uri.fsPath}});
      // Use a real webview to send the command for the map entry that arrived; Playwright covers the physical click.
      panel.webview.html = `<!doctype html>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-reveal-test'">
      <script nonce="reveal-test">
        const vscode = acquireVsCodeApi();
        window.addEventListener('message', ({data}) => {
          const connector = data.kind === 'svg' && data.map?.connects[0];
          if (connector) vscode.postMessage({kind: 'reveal', build: data.build, id: connector.id});
        });
        vscode.postMessage({kind: 'ready'});
      </script>`;
      const expected = new vscode.Range(8, 4, 8, 11);
      for (const end = Date.now() + 30_000; Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
        const editor = vscode.window.activeTextEditor;
        if (editor?.document !== document || !editor.selection.isEqual(expected)) continue;
        const message = manager.lastMessage;
        assert.ok(message?.kind === 'svg' && message.map);
        assert.ok(message.map.parts.some(p => p.label === 'Start'));
        assert.equal(message.map.connects.length, 1);
        assert.equal(document.getText(editor.selection), 'connect');
        assert.equal(editor.viewColumn, vscode.ViewColumn.One);
        assert.equal(panel.viewColumn, vscode.ViewColumn.Two);
        assert.equal(panel.visible, true);
        return;
      }
      assert.fail(`the preview did not select connect() in the fixture (last message: ${manager.lastMessage?.kind})`);
    } finally {
      manager.dispose();
      log.dispose();
      fs.rmSync(scratch.fsPath, {recursive: true, force: true});
    }
  });

  type Msg = {kind: string; svg?: string; message?: string; file?: string};
  async function previewOf(name: string, want: string): Promise<Msg> {
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(base);
    const uri = vscode.Uri.joinPath(base, name);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    await vscode.commands.executeCommand('svgDiagram.openPreview');
    return waitForPreview(uri, want);
  }

  async function waitForPreview(uri: vscode.Uri, want: string, timeoutMs = 60_000): Promise<Msg> {
    const api = vscode.extensions.getExtension<{testing: {previewMessage(): Msg | undefined}}>('cuzic.svg-diagram-vscode')?.exports;
    assert.ok(api);
    for (const end = Date.now() + timeoutMs; Date.now() < end; await new Promise(r => setTimeout(r, 200))) {
      const m = api.testing.previewMessage();
      if (m?.kind === want && m.file === uri.fsPath) return m;
    }
    assert.fail(`no ${want} preview for ${uri.path}: last ${JSON.stringify(api.testing.previewMessage())?.slice(0, 300)}`);
  }

  test('a source that builds is drawn as inline SVG', async () => {
    const m = await previewOf('untitled.diagram.ts', 'svg');
    assert.match(m.svg ?? '', /^<svg[\s>]/);
  });

  test('the preview follows the active source; one that throws shows why', async () => {
    const m = await previewOf('broken.diagram.ts', 'error');
    assert.match(m.message ?? '', /わざと壊した図/);
  });

  test('the preview error banner shows a helper relative to the workspace folder', () => withLocationCli(async base => {
    const uri = vscode.Uri.joinPath(base, 'locations', 'located.diagram.ts');
    await vscode.commands.executeCommand('svgDiagram.openPreview', uri);
    const message = await waitForPreview(uri, 'error');
    assert.equal(message.message, 'parts.ts:4:14: 共通部品のエラー');
  }));
});

suite('tasks and commands', () => {
  test('a typecheck task is offered for the folder', async () => {
    const tasks = await vscode.tasks.fetchTasks({type: 'svg-diagram'});
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.definition['command'], 'typecheck');
    assert.deepEqual(tasks[0]?.problemMatchers, ['$tsc']);
  });

  test('every contributed command is registered', async () => {
    const ext = vscode.extensions.getExtension('cuzic.svg-diagram-vscode');
    const contributed: string[] = ext?.packageJSON.contributes.commands.map((c: {command: string}) => c.command) ?? [];
    const all = await vscode.commands.getCommands(true);
    assert.deepEqual(contributed.filter(c => !all.includes(c)), []);
  });
});

suite('shared parts', () => {
  test('a module of parts (no default export) is neither checked nor previewed', async () => {
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(base);
    const uri = vscode.Uri.joinPath(base, 'parts.ts');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    await new Promise(r => setTimeout(r, 3000)); // a check would have answered by now (the others take ~1s)
    assert.deepEqual(vscode.languages.getDiagnostics(uri).filter(d => d.source === 'svg-diagram'), []);
    const api = vscode.extensions.getExtension<{testing: {previewMessage(): {file?: string} | undefined}}>('cuzic.svg-diagram-vscode')?.exports;
    assert.notEqual(api?.testing.previewMessage()?.file, uri.fsPath);
  });
});

suite('JSON Schemas (from the fixture core, svg-diagram 0.8.0 or later)', () => {
  const fixture = (name: string) => {
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(base);
    return vscode.Uri.joinPath(base, name);
  };
  const unrelated = (name: string) => {
    const base = vscode.workspace.workspaceFolders?.find(f => f.name === 'unrelated')?.uri;
    assert.ok(base, 'the integration tests run in test/fixtures/multi-root.code-workspace');
    return vscode.Uri.joinPath(base, name);
  };
  const api = () => vscode.extensions.getExtension<{testing: {schemaRoot(): {dir?: string; reason?: string} | undefined}}>('cuzic.svg-diagram-vscode')?.exports.testing;
  // the JSON language server's diagnostics have no `source`
  const jsonDiagnostics = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).filter(d => d.source !== 'svg-diagram');
  // vscode.open: the workbench owns the document, so it closes with its tab (a document the extension host opened
  // itself stays open for minutes, and would keep its project in the window's choice)
  async function show(uri: vscode.Uri): Promise<vscode.TextEditor> {
    await vscode.commands.executeCommand('vscode.open', uri);
    const editor = vscode.window.activeTextEditor;
    assert.equal(editor?.document.uri.toString(), uri.toString());
    return editor;
  }
  async function close(uri: vscode.Uri): Promise<void> {
    await show(uri);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await until(`${uri.path} closed`, () => (vscode.workspace.textDocuments.some(d => d.uri.toString() === uri.toString()) ? undefined : true));
  }
  async function until<T>(what: string, get: () => T | undefined, timeoutMs = 15_000): Promise<T> {
    for (const end = Date.now() + timeoutMs; Date.now() < end; await new Promise(r => setTimeout(r, 200))) {
      const v = get();
      if (v !== undefined) return v;
    }
    assert.fail(`${what} within ${timeoutMs}ms`);
  }
  const errorsOf = (uri: vscode.Uri) => until(`json diagnostics for ${uri.path}`, () => { const d = jsonDiagnostics(uri); return d.length ? d : undefined; });
  const noErrorsOf = (uri: vscode.Uri) => until(`no json diagnostics for ${uri.path} (${jsonDiagnostics(uri).map(d => d.message).join(' / ')})`, () => (jsonDiagnostics(uri).length ? undefined : true));
  const settle = () => new Promise(r => setTimeout(r, 3000)); // long enough for the JSON server to have checked the file

  teardown(async () => {
    await vscode.workspace.getConfiguration('svgDiagram').update('jsonSchemas.enabled', undefined, vscode.ConfigurationTarget.Global);
  });

  test('site.json is checked against site.schema.json', async () => {
    const uri = fixture('json/site.json');
    await show(uri);
    const found = await errorsOf(uri);
    assert.ok(found.some(d => /colour/.test(d.message) && d.range.start.line === 2), found.map(d => d.message).join(' / '));
    assert.match(api()?.schemaRoot()?.dir ?? '', /node_modules[\\/]svg-diagram[\\/]schema$/);
  });

  test('.svg-diagram.json is checked against config.schema.json', async () => {
    const uri = fixture('json/.svg-diagram.json');
    await show(uri);
    const found = await errorsOf(uri);
    assert.ok(found.some(d => /colour/.test(d.message)), found.map(d => d.message).join(' / '));
    assert.ok(found.some(d => d.range.start.line === 1), `outDir: 1 is not flagged: ${found.map(d => d.message).join(' / ')}`);
  });

  test('a deck: the figure path message, and every part type is offered (spec.schema.json through the relative $ref)', async () => {
    const uri = fixture('json/deck.json');
    const editor = await show(uri);
    const found = await errorsOf(uri);
    assert.ok(found.some(d => /ends in \.ts or \.json/.test(d.message) && d.range.start.line === 3), found.map(d => d.message).join(' / '));
    const at = editor.document.lineAt(2).text.indexOf('"type": "') + '"type": "'.length;
    const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri, new vscode.Position(2, at));
    const labels = list.items.map(i => (typeof i.label === 'string' ? i.label : i.label.label).replace(/"/g, ''));
    for (const t of ['chevron', 'flowchart', 'gantt']) assert.ok(labels.includes(t), `${t} not offered: ${labels.slice(0, 10).join(', ')}`);
    assert.ok(labels.length >= 60, `only ${labels.length} part types`);
  });

  test('svgDiagram.jsonSchemas.enabled: off stops the checks, on brings them back', async function () {
    this.timeout(60_000);
    const uri = fixture('json/site.json');
    await show(uri);
    await errorsOf(uri);
    await vscode.workspace.getConfiguration('svgDiagram').update('jsonSchemas.enabled', false, vscode.ConfigurationTarget.Global);
    await noErrorsOf(uri);
    assert.match(api()?.schemaRoot()?.reason ?? '', /jsonSchemas\.enabled/);
    await vscode.workspace.getConfiguration('svgDiagram').update('jsonSchemas.enabled', true, vscode.ConfigurationTarget.Global);
    await errorsOf(uri);
  });

  test('a site.json of a folder without svg-diagram open beside the project\'s: neither is checked until it closes', async function () {
    this.timeout(60_000);
    const other = unrelated('site.json');
    const own = fixture('json/site.json');
    await show(own);
    await errorsOf(own); // the schema is live
    await show(other);
    await noErrorsOf(own);
    await settle();
    assert.deepEqual(jsonDiagnostics(other).map(d => d.message), [], 'the unrelated site.json got the project\'s schema');
    assert.deepEqual(jsonDiagnostics(own).map(d => d.message), []);
    assert.match(api()?.schemaRoot()?.reason ?? '', /unrelated\/site\.json（svg-diagram 無し）.*両方を検査できない/);
    await close(other);
    await errorsOf(own);
    assert.ok(api()?.schemaRoot()?.dir);
  });

  test('a document that is not a file (the git side of a diff) counts as the file of its path', async function () {
    this.timeout(60_000);
    const own = fixture('json/site.json');
    await show(own);
    await errorsOf(own);
    // like git:, a scheme that carries the file's path
    const scheme = 'svgd-test-rev';
    const reg = vscode.workspace.registerTextDocumentContentProvider(scheme, {provideTextDocumentContent: () => '{\n  "pages": ["a"],\n  "theme": "x"\n}\n'});
    try {
      const rev = unrelated('site.json').with({scheme, query: 'ref=HEAD'});
      await show(rev);
      await noErrorsOf(own);
      await settle();
      assert.deepEqual(jsonDiagnostics(rev).map(d => d.message), [], 'the revision of the unrelated site.json got the project\'s schema');
      await close(rev);
      await errorsOf(own);
    } finally {
      reg.dispose();
    }
  });

  test('a core installed below the folder is seen when its file is reopened', async function () {
    this.timeout(60_000);
    const pkg = unrelated('pkg').fsPath;
    const site = vscode.Uri.file(path.join(pkg, 'site.json'));
    fs.mkdirSync(pkg, {recursive: true});
    fs.writeFileSync(site.fsPath, '{\n  "decks": [],\n  "colour": 1\n}\n');
    try {
      await show(site);
      await settle();
      assert.deepEqual(jsonDiagnostics(site).map(d => d.message), []);
      // pnpm -F pkg add …: a link into the store, below the workspace folder (not watched)
      fs.mkdirSync(path.join(pkg, 'node_modules'));
      fs.symlinkSync(fixture('node_modules/svg-diagram').fsPath, path.join(pkg, 'node_modules', 'svg-diagram'));
      await close(site);
      await show(site);
      const found = await errorsOf(site);
      assert.ok(found.some(d => /colour/.test(d.message)), found.map(d => d.message).join(' / '));
      await close(site);
    } finally {
      fs.rmSync(pkg, {recursive: true, force: true});
    }
  });

});
