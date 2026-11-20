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
  // test/fixtures/workspace has svg-diagram 0.5.0 in node_modules (CI: npm install there before the run)
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

  test('a source that throws is a build-error on the line that threw', async () => {
    const [d] = await diagnosticsOf('broken.diagram.ts');
    assert.equal(d?.code, 'build-error');
    assert.equal(d?.severity, vscode.DiagnosticSeverity.Error);
    assert.equal(d?.range.start.line, 4); // `throw new Error(...)` is line 5
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
