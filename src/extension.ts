import * as vscode from 'vscode';

let output: vscode.LogOutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('svg-diagram', {log: true});
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('svgDiagram.showOutput', () => output?.show()),
  );
  output.info(`svg-diagram ${context.extension.packageJSON.version} を起動した`);
}

export function deactivate(): void {
  output = undefined;
}
