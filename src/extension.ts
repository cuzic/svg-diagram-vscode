import * as vscode from 'vscode';
import {describeCli, type ResolvedCli, resolveCli} from './cli.ts';

let output: vscode.LogOutputChannel | undefined;
const warned = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('svg-diagram', {log: true});
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('svgDiagram.showOutput', () => output?.show()),
    vscode.commands.registerCommand('svgDiagram.showCli', showCli),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('svgDiagram.cliPath')) { warned.clear(); logCliForAllFolders(); }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => logCliForAllFolders()),
  );
  output.info(`svg-diagram 拡張 ${context.extension.packageJSON.version} を起動した`);
  logCliForAllFolders();
}

export function deactivate(): void {
  output = undefined;
}

/**
 * The CLI for a file or folder, looked up every time (a few stat calls), so a fresh `pnpm add` or a changed setting
 * takes effect without a reload. Warnings are shown once per message; "not found" offers the setting.
 */
export function getCli(scope?: vscode.Uri): ResolvedCli | undefined {
  const folder = (scope && vscode.workspace.getWorkspaceFolder(scope)) ?? vscode.workspace.workspaceFolders?.[0];
  const setting = vscode.workspace.getConfiguration('svgDiagram', folder).get<string>('cliPath');
  const {cli, warnings} = resolveCli({folder: folder?.uri.fsPath, setting});
  for (const w of warnings) warnOnce(w);
  if (!cli) warnOnce('svg-diagram の CLI が見つからない。案件に `pnpm add -D svg-diagram` で入れるか、設定 svgDiagram.cliPath で場所を指定する', true);
  return cli;
}

function logCliForAllFolders(): void {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const cli = getCli(folder.uri);
    if (cli) output?.info(`${folder.name}: ${describeCli(cli)}`);
  }
}

async function showCli(): Promise<void> {
  const cli = getCli(vscode.window.activeTextEditor?.document.uri);
  if (cli) void vscode.window.showInformationMessage(describeCli(cli));
}

function warnOnce(message: string, offerSetting = false): void {
  output?.warn(message);
  if (warned.has(message)) return;
  warned.add(message);
  const open = '設定を開く';
  void vscode.window.showWarningMessage(message, ...(offerSetting ? [open] : [])).then(choice => {
    if (choice === open) void vscode.commands.executeCommand('workbench.action.openSettings', 'svgDiagram.cliPath');
  });
}
