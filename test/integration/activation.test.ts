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
  test('svgDiagram.showCli runs without throwing (the fixture has no CLI, so it only warns)', async () => {
    await vscode.commands.executeCommand('svgDiagram.showCli');
  });
});
