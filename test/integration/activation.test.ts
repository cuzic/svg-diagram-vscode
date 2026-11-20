// Runs inside a real VS Code (pnpm test:integration; CI runs it under xvfb).
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

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
});

suite('check → Problems', () => {
  // test/fixtures/workspace has svg-diagram 0.8.0 (the GitHub release tag) in node_modules (CI: npm install there before the run)
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
    // core 0.8.0 reports it in its JSON, without a line (0.5.0 crashed, and the line came from the stack): the first line
    assert.equal(d?.range.start.line, 0);
    assert.match(d?.message ?? '', /わざと壊した図/);
  });
});

suite('preview', () => {
  type Msg = {kind: string; svg?: string; message?: string; file?: string};
  async function previewOf(name: string, want: string, timeoutMs = 60_000): Promise<Msg> {
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(base);
    const uri = vscode.Uri.joinPath(base, name);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    await vscode.commands.executeCommand('svgDiagram.openPreview');
    const api = vscode.extensions.getExtension<{testing: {previewMessage(): Msg | undefined}}>('cuzic.svg-diagram-vscode')?.exports;
    assert.ok(api);
    for (const end = Date.now() + timeoutMs; Date.now() < end; await new Promise(r => setTimeout(r, 200))) {
      const m = api.testing.previewMessage();
      if (m?.kind === want && m.file === uri.fsPath) return m;
    }
    assert.fail(`no ${want} preview for ${name}: last ${JSON.stringify(api.testing.previewMessage())?.slice(0, 300)}`);
  }

  test('a source that builds is drawn as inline SVG', async () => {
    const m = await previewOf('untitled.diagram.ts', 'svg');
    assert.match(m.svg ?? '', /^<svg[\s>]/);
  });

  test('the preview follows the active source; one that throws shows why', async () => {
    const m = await previewOf('broken.diagram.ts', 'error');
    assert.match(m.message ?? '', /わざと壊した図/);
  });
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
  const show = async (uri: vscode.Uri) => vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
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

  test("a site.json in a folder without svg-diagram is not checked, and the project's again once its file is shown", async function () {
    this.timeout(60_000);
    const other = unrelated('site.json');
    await show(other);
    await noErrorsOf(other);
    await settle();
    assert.deepEqual(jsonDiagnostics(other).map(d => d.message), []);
    assert.equal(api()?.schemaRoot()?.dir, undefined);
    const own = fixture('json/site.json');
    await show(own);
    await errorsOf(own);
    await show(other);
    await noErrorsOf(other);
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
});
