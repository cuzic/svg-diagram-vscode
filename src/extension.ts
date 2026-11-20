import * as vscode from 'vscode';
import {describeCli, type ResolvedCli, resolveCli} from './cli.ts';
import {Checker, findDiagramSources} from './diagnostics.ts';

let output: vscode.LogOutputChannel | undefined;
const warned = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('svg-diagram', {log: true});
  output = log;
  const checker = new Checker({getCli, log});
  const status = vscode.window.createStatusBarItem('svgDiagram.status', vscode.StatusBarAlignment.Left);
  status.name = 'svg-diagram';
  status.text = '$(sync~spin) svg-diagram';
  status.tooltip = 'svg-diagram: 検査中';
  status.command = 'svgDiagram.showOutput';

  context.subscriptions.push(
    log,
    checker,
    status,
    checker.onBusyChange(busy => (busy > 0 ? status.show() : status.hide())),
    vscode.commands.registerCommand('svgDiagram.showOutput', () => output?.show()),
    vscode.commands.registerCommand('svgDiagram.showCli', showCli),
    vscode.commands.registerCommand('svgDiagram.checkFile', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) return void vscode.window.showInformationMessage('検査する図のソースを開いてから実行する');
      await vscode.window.activeTextEditor?.document.save();
      await checker.check([target]);
    }),
    vscode.commands.registerCommand('svgDiagram.checkWorkspace', () =>
      vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: 'svg-diagram: ワークスペースの図を検査', cancellable: true}, async (_progress, token) => {
        const sources = await findDiagramSources(token);
        if (token.isCancellationRequested) return;
        if (!sources.length) return void vscode.window.showInformationMessage("svg-diagram を import している図のソースが見つからない（from 'svg-diagram'）");
        await checker.check(sources);
      })),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('svgDiagram.cliPath')) { warned.clear(); logCliForAllFolders(); }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => logCliForAllFolders()),
  );
  log.info(`svg-diagram 拡張 ${context.extension.packageJSON.version} を起動した`);
  logCliForAllFolders();
  checker.recheckOpen();
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

/** Logs only: activation also happens in TypeScript projects that have nothing to do with svg-diagram. */
function logCliForAllFolders(): void {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const setting = vscode.workspace.getConfiguration('svgDiagram', folder).get<string>('cliPath');
    const {cli, warnings} = resolveCli({folder: folder.uri.fsPath, setting});
    for (const w of warnings) output?.warn(w);
    output?.info(`${folder.name}: ${cli ? describeCli(cli) : 'svg-diagram の CLI は見つからない'}`);
  }
}

async function showCli(): Promise<void> {
  warned.clear(); // asked for explicitly: say it again
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
