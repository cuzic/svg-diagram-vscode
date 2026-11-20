// The status bar item: shown while a diagram source (or the preview) is in front; click for the menu.
import * as vscode from 'vscode';
import {describeCli, type ResolvedCli} from './cli.ts';

export interface StatusDeps {
  /** Looks the CLI up without warning (the status bar must not nag). */
  peekCli(scope: vscode.Uri): ResolvedCli | undefined;
  isSourceActive(): boolean;
  isPreviewActive(): boolean;
  activeUri(): vscode.Uri | undefined;
}

export class Status implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('svgDiagram.status', vscode.StatusBarAlignment.Left, 10);
  private busy = 0;
  private readonly deps: StatusDeps;

  constructor(deps: StatusDeps) {
    this.deps = deps;
    this.item.name = 'svg-diagram';
    this.item.command = 'svgDiagram.menu';
  }

  setBusy(busy: number): void {
    this.busy = busy;
    this.refresh();
  }

  refresh(): void {
    if (!this.deps.isSourceActive() && !this.deps.isPreviewActive()) return void this.item.hide();
    const uri = this.deps.activeUri() ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    const cli = uri && this.deps.peekCli(uri);
    if (!cli) {
      this.item.text = '$(warning) svg-diagram: CLI なし';
      this.item.tooltip = 'svg-diagram の CLI が見つからない。クリックして「この案件で svg-diagram を使えるようにする」';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.text = this.busy > 0 ? `$(sync~spin) svg-diagram ${cli.version ?? ''}`.trimEnd() : `$(type-hierarchy) svg-diagram ${cli.version ?? ''}`.trimEnd();
      this.item.tooltip = `${this.busy > 0 ? '検査中…\n' : ''}${describeCli(cli)}\nクリックでメニュー`;
      this.item.backgroundColor = undefined;
    }
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

/** The menu behind the status bar item: the commands that make sense now. */
export async function showMenu(hasCli: boolean): Promise<void> {
  type Item = vscode.QuickPickItem & {command: string};
  const items: Item[] = [
    ...(hasCli ? [] : [{label: '$(tools) この案件で svg-diagram を使えるようにする', command: 'svgDiagram.setup'}]),
    {label: '$(open-preview) プレビューを横に開く', command: 'svgDiagram.openPreview'},
    {label: '$(check) この図を検査', command: 'svgDiagram.checkFile'},
    {label: '$(checklist) ワークスペースの図をすべて検査', command: 'svgDiagram.checkWorkspace'},
    {label: '$(symbol-type-parameter) 型検査（typecheck）', command: 'svgDiagram.typecheck'},
    ...(hasCli ? [{label: '$(tools) この案件で svg-diagram を使えるようにする', command: 'svgDiagram.setup'}] : []),
    {label: '$(info) 使う CLI の場所と版を表示', command: 'svgDiagram.showCli'},
    {label: '$(output) 出力ログを開く', command: 'svgDiagram.showOutput'},
  ];
  const picked = await vscode.window.showQuickPick(items, {placeHolder: 'svg-diagram'});
  if (picked) await vscode.commands.executeCommand(picked.command);
}
