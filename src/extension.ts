import fs from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import {describeCli, type ResolveResult, type ResolvedCli, resolveCli} from './cli.ts';
import {Checker, findDiagramSources} from './diagnostics.ts';
import {isSource, PREVIEW_VIEW_TYPE, PreviewManager} from './preview.ts';
import {detectPackageManager, readSetupState, setupCommand} from './setup.ts';
import {showMenu, Status} from './status.ts';
import {SvgDiagramTaskProvider, TASK_TYPE} from './tasks.ts';

let output: vscode.LogOutputChannel | undefined;
const warned = new Set<string>();

const WINDOWS_UNSUPPORTED = 'svg-diagram の CLI（bin/svg-diagram）は bash のスクリプトなので、Windows ではこの拡張は動かない。WSL（Remote - WSL）で開く';

/** What activate() returns (ext.exports). Only the integration tests use it. */
export interface ExtensionApi { testing: {previewMessage(): unknown} }

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const log = vscode.window.createOutputChannel('svg-diagram', {log: true});
  output = log;
  const scratchDir = context.storageUri ?? context.globalStorageUri;
  // previews of an earlier session are not needed any more
  void fs.rm(vscode.Uri.joinPath(scratchDir, 'preview').fsPath, {recursive: true, force: true}).catch(() => undefined);

  const checker = new Checker({getCli, log});
  const preview = new PreviewManager({getCli, log, scratchDir});
  const setSourceContext = (editor = vscode.window.activeTextEditor) =>
    void vscode.commands.executeCommand('setContext', 'svgDiagram.isSource', !!editor && isSource(editor.document));
  const tasks = new SvgDiagramTaskProvider(peekCli);
  const status = new Status({
    peekCli,
    isSourceActive: () => !!vscode.window.activeTextEditor && isSource(vscode.window.activeTextEditor.document),
    isPreviewActive: () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputWebview && input.viewType.endsWith(PREVIEW_VIEW_TYPE);
    },
    activeUri: () => vscode.window.activeTextEditor?.document.uri,
  });

  context.subscriptions.push(
    log,
    checker,
    preview,
    status,
    vscode.window.onDidChangeActiveTextEditor(e => { setSourceContext(e); status.refresh(); }),
    vscode.workspace.onDidSaveTextDocument(doc => { if (doc === vscode.window.activeTextEditor?.document) { setSourceContext(); status.refresh(); } }),
    vscode.commands.registerCommand('svgDiagram.openPreview', (uri?: vscode.Uri) => openPreview(preview, uri, vscode.ViewColumn.Beside)),
    vscode.commands.registerCommand('svgDiagram.showPreview', (uri?: vscode.Uri) => openPreview(preview, uri, vscode.ViewColumn.Active)),
    checker.onBusyChange(busy => status.setBusy(busy)),
    vscode.window.tabGroups.onDidChangeTabs(() => status.refresh()),
    vscode.window.onDidChangeWindowState(e => { if (e.focused) status.refresh(); }), // back from a terminal where svg-diagram was installed
    vscode.tasks.registerTaskProvider(TASK_TYPE, tasks),
    vscode.commands.registerCommand('svgDiagram.menu', () => showMenu(!!peekCli(vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri))),
    vscode.commands.registerCommand('svgDiagram.typecheck', async () => {
      const folder = await pickFolder();
      if (!folder) return;
      if (!getCli(folder.uri)) return;
      const task = tasks.make(folder, {type: TASK_TYPE, command: 'typecheck'});
      if (task) await vscode.tasks.executeTask(task);
    }),
    vscode.commands.registerCommand('svgDiagram.setup', async () => {
      if (process.platform === 'win32') return void vscode.window.showWarningMessage(WINDOWS_UNSUPPORTED);
      const folder = await pickFolder();
      if (folder) await setup(folder);
    }),
    vscode.commands.registerCommand('svgDiagram.showOutput', () => output?.show()),
    vscode.commands.registerCommand('svgDiagram.showCli', showCli),
    vscode.commands.registerCommand('svgDiagram.checkFile', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target?.scheme !== 'file') return void vscode.window.showInformationMessage('検査する図のソース（保存したファイル）を開いてから実行する');
      // check reads the file from disk: save it first when it is open with changes (and only that one)
      const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === target.toString());
      if (open?.isDirty) await open.save();
      await checker.check([target]);
    }),
    vscode.commands.registerCommand('svgDiagram.checkWorkspace', () =>
      vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: 'svg-diagram: ワークスペースの図を検査', cancellable: true}, async (_progress, token) => {
        const sources = await findDiagramSources(token);
        if (token.isCancellationRequested) return;
        if (!sources.length) return void vscode.window.showInformationMessage("図のソース（svg-diagram を import して export default するファイル）が見つからない");
        await checker.check(sources);
      })),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('svgDiagram.cliPath')) { warned.clear(); logCliForAllFolders(); status.refresh(); }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => logCliForAllFolders()),
  );
  log.info(`svg-diagram 拡張 ${context.extension.packageJSON.version} を起動した`);
  if (process.platform === 'win32') log.warn(WINDOWS_UNSUPPORTED);
  logCliForAllFolders();
  checker.recheckOpen();
  setSourceContext();
  status.refresh();
  return {testing: {previewMessage: () => preview.lastMessage}};
}

function openPreview(preview: PreviewManager, uri: vscode.Uri | undefined, column: vscode.ViewColumn): void {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (target?.scheme !== 'file') return void vscode.window.showInformationMessage('プレビューする図のソース（保存したファイル）を開いてから実行する');
  preview.show(target, column);
}

export function deactivate(): void {
  output = undefined;
}

/**
 * Looks the CLI up for a file (from its own directory up, so a package's node_modules below the workspace folder is
 * found) or a folder. Done every time (a few stat calls), so a fresh `pnpm add` or a changed setting takes effect
 * without a reload. A relative setting is relative to the file's workspace folder (or, outside any, the file's directory).
 */
function lookup(scope: vscode.Uri | undefined): ResolveResult {
  const folder = scope ? vscode.workspace.getWorkspaceFolder(scope) : vscode.workspace.workspaceFolders?.[0];
  const isFolder = !!scope && !!folder && scope.toString() === folder.uri.toString();
  const from = scope?.scheme === 'file' && !isFolder ? path.dirname(scope.fsPath) : undefined;
  const setting = vscode.workspace.getConfiguration('svgDiagram', folder ?? scope).get<string>('cliPath');
  return resolveCli({folder: folder?.uri.fsPath ?? from, from, setting});
}

/** The CLI for running something now: tells the user (once per message) what is wrong when there is none. */
export function getCli(scope?: vscode.Uri): ResolvedCli | undefined {
  if (process.platform === 'win32') return void warnOnce(WINDOWS_UNSUPPORTED);
  const {cli, warnings} = lookup(scope);
  for (const w of warnings) warnOnce(w);
  if (!cli) warnOnce('svg-diagram の CLI が見つからない。案件に `pnpm add -D svg-diagram` で入れるか、設定 svgDiagram.cliPath で場所を指定する', true);
  return cli;
}

/** The CLI without any warning (status bar, menu, task list: these must not nag in projects unrelated to svg-diagram). */
function peekCli(scope: vscode.Uri | undefined): ResolvedCli | undefined {
  return process.platform === 'win32' ? undefined : lookup(scope).cli;
}

/** The folder of the active editor; asks when there are several and none is active. */
async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const active = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (active) return active;
  if (folders.length <= 1) return folders[0] ?? void vscode.window.showInformationMessage('フォルダを開いてから実行する');
  return vscode.window.showWorkspaceFolderPick({placeHolder: 'どのフォルダで？'});
}

/** Adds what is missing (svg-diagram, typescript, @types/node) and runs `svg-diagram init`, in a terminal the user sees. */
async function setup(folder: vscode.WorkspaceFolder): Promise<void> {
  const pm = detectPackageManager(folder.uri.fsPath);
  const command = setupCommand(pm, readSetupState(folder.uri.fsPath));
  if (!command) return void vscode.window.showInformationMessage(`${folder.name} は準備できている（svg-diagram・typescript・@types/node、"type": "module"、tsconfig.json）`);
  const run = '実行する';
  const answer = await vscode.window.showInformationMessage(
    `${folder.name} で次を実行する。package.json と tsconfig.json が変わる。`,
    {modal: true, detail: command},
    run,
  );
  if (answer !== run) return;
  const terminal = vscode.window.createTerminal({name: `svg-diagram: ${path.basename(folder.uri.fsPath)}`, cwd: folder.uri.fsPath});
  terminal.show();
  terminal.sendText(command);
  output?.info(`${folder.name}: ${command}`);
}

/** Logs only: activation also happens in TypeScript projects that have nothing to do with svg-diagram. */
function logCliForAllFolders(): void {
  if (process.platform === 'win32') return;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const {cli, warnings} = lookup(folder.uri);
    for (const w of warnings) output?.warn(w);
    output?.info(`${folder.name}: ${cli ? describeCli(cli) : 'svg-diagram の CLI は（フォルダの直下からは）見つからない'}`);
  }
}

async function showCli(): Promise<void> {
  warned.clear(); // asked for explicitly: say it again
  const cli = getCli(vscode.window.activeTextEditor?.document.uri);
  if (cli) void vscode.window.showInformationMessage(describeCli(cli));
}

/** Shows (and logs) a warning once per message until the setting changes or the user asks again. */
function warnOnce(message: string, offerSetting = false): void {
  if (warned.has(message)) return;
  warned.add(message);
  output?.warn(message);
  const open = '設定を開く';
  void vscode.window.showWarningMessage(message, ...(offerSetting ? [open] : [])).then(choice => {
    if (choice === open) void vscode.commands.executeCommand('workbench.action.openSettings', 'svgDiagram.cliPath');
  });
}
