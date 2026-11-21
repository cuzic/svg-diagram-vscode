// The live preview: one panel that follows the diagram source in the active editor and redraws it on save.
import {randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import {isDiagramSource, placeSourcePosition} from './check.ts';
import {type ResolvedCli, supportsBuildLocations} from './cli.ts';
import {exec} from './exec.ts';
import {buildArgs, buildErrorText, inlineSvg, previewShellHtml, type ToPage} from './preview-html.ts';
import {readPreviewLocations, type RevealTable, revealTarget, tableAfterMessage} from './preview-locations.ts';

export const PREVIEW_VIEW_TYPE = 'svgDiagram.preview';

export interface PreviewDeps {
  getCli(scope: vscode.Uri): ResolvedCli | undefined;
  log: vscode.LogOutputChannel;
  /** Where the scratch SVGs go (the extension's storage, never the project). */
  scratchDir: vscode.Uri;
}

/** What the page keeps with vscode.setState (VS Code hands it back after a reload). */
interface PanelState { last?: {file?: string} }

export class PreviewManager implements vscode.Disposable, vscode.WebviewPanelSerializer<PanelState> {
  private panel: vscode.WebviewPanel | undefined;
  private source: vscode.Uri | undefined;
  private building: AbortController | undefined;
  private readonly buildSession = randomBytes(16).toString('hex');
  private buildNumber = 0;
  private revealTable: RevealTable | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly deps: PreviewDeps;
  private readonly viewType: string;
  /** For tests: the last message sent to the page. */
  lastMessage: ToPage | undefined;

  constructor(deps: PreviewDeps, viewType = PREVIEW_VIEW_TYPE) {
    this.deps = deps;
    this.viewType = viewType;
    this.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(viewType, this),
      vscode.window.onDidChangeActiveTextEditor(e => { if (e && this.panel && isSource(e.document) && e.document.uri.toString() !== this.source?.toString()) this.follow(e.document.uri); }),
      vscode.workspace.onDidSaveTextDocument(doc => this.onSaved(doc)),
    );
  }

  /** Opens (or reveals) the preview for a source, beside the editor by default. */
  show(uri: vscode.Uri, column: vscode.ViewColumn = vscode.ViewColumn.Beside): void {
    if (this.panel) this.panel.reveal(column, true);
    else this.adopt(vscode.window.createWebviewPanel(this.viewType, 'svg-diagram', {viewColumn: column, preserveFocus: true}, {enableScripts: true, retainContextWhenHidden: false, localResourceRoots: []}));
    this.follow(uri);
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: PanelState | undefined): Promise<void> {
    this.adopt(panel);
    const file = state?.last?.file;
    if (file) this.follow(vscode.Uri.file(file));
  }

  get isOpen(): boolean {
    return !!this.panel;
  }

  private adopt(panel: vscode.WebviewPanel): void {
    this.panel?.dispose();
    this.panel = panel;
    panel.webview.options = {enableScripts: true, localResourceRoots: []};
    panel.webview.html = previewShellHtml({cspSource: panel.webview.cspSource, nonce: randomBytes(16).toString('base64')});
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (this.panel !== panel || !message || typeof message !== 'object' || !('kind' in message)) return;
      if (message.kind === 'ready' && this.lastMessage) void panel.webview.postMessage(this.lastMessage);
      if (message.kind === 'reveal') void this.reveal(panel, message);
    });
    panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.panel = undefined;
      this.source = undefined;
      this.revealTable = undefined;
      this.lastMessage = undefined;
      this.building?.abort();
    });
  }

  private follow(uri: vscode.Uri): void {
    if (uri.toString() !== this.source?.toString()) this.revealTable = undefined;
    this.source = uri;
    if (this.panel) this.panel.title = `プレビュー: ${path.basename(uri.fsPath)}`;
    void this.render();
  }

  /**
   * Redraw when the source itself is saved, or a script / .svg-diagram.json in the same workspace folder (a shared
   * part it may import, the project settings). Not package.json, .vscode/settings.json or files outside any folder.
   */
  private onSaved(doc: vscode.TextDocument): void {
    if (!this.panel || !this.source || doc.uri.scheme !== 'file') return;
    if (doc.uri.toString() === this.source.toString()) return void this.render();
    const folder = vscode.workspace.getWorkspaceFolder(this.source);
    const same = !!folder && vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.toString() === folder.uri.toString();
    const relevant = /\.(m?ts|m?js)$/.test(doc.fileName) || path.basename(doc.fileName) === '.svg-diagram.json';
    if (same && relevant && !doc.uri.fsPath.split(path.sep).includes('node_modules')) void this.render();
  }

  /** Builds the current source into scratch space and sends the SVG (or why it failed) to the page. */
  async render(): Promise<void> {
    const source = this.source;
    if (!source || !this.panel) return;
    const title = path.basename(source.fsPath);
    const file = source.fsPath;
    const build = `${this.buildSession}-${++this.buildNumber}`;
    this.building?.abort();
    this.building = undefined;
    const cli = this.deps.getCli(source);
    if (!cli) return this.post({kind: 'error', title, file, message: 'svg-diagram の CLI が見つからない（設定 svgDiagram.cliPath、または案件に pnpm add -D svg-diagram）'});
    const abort = new AbortController();
    const {signal} = abort;
    this.building = abort;
    this.post({kind: 'building', title, file});

    // Build also writes reveal steps beside --out. A canceled build can still be exiting when the next starts.
    const scratch = vscode.Uri.joinPath(this.deps.scratchDir, 'preview').fsPath;
    let dir: string | undefined;
    try {
      const cwd = path.dirname(file);
      const supportsLocations = await supportsBuildLocations(cli, {cwd, signal, timeoutMs: 10_000});
      if (signal.aborted) return;
      try {
        await fs.mkdir(scratch, {recursive: true});
        dir = await fs.mkdtemp(path.join(scratch, 'build-'));
      } catch (e) {
        if (!signal.aborted) this.post({kind: 'error', title, file, message: `作業用フォルダを用意できない: ${(e as Error).message}`});
        return;
      }
      if (signal.aborted) return;
      const name = title.replace(/\.(m?ts|m?js)$/, '');
      const out = path.join(dir, name + '.svg');
      const mapFile = supportsLocations ? path.join(dir, name + '.locations.json') : undefined;
      const sourceVersion = vscode.workspace.textDocuments.find(d => d.uri.toString() === source.toString())?.version;
      const {stderr, error} = await exec(cli.bin, buildArgs(file, out, mapFile), {cwd, signal});
      if (signal.aborted) return;
      const svg = error ? undefined : await fs.readFile(out, 'utf8').catch(() => undefined);
      if (signal.aborted) return;
      if (!svg) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(source)?.uri.fsPath;
        const message = buildErrorText(file, stderr, workspaceFolder);
        this.deps.log.warn(`プレビュー ${title}: ${message}`);
        return this.post({kind: 'error', title, file, message});
      }
      const inlined = inlineSvg(svg);
      const json = mapFile && await fs.readFile(mapFile, 'utf8').catch(() => undefined);
      if (signal.aborted) return;
      const mapped = mapFile && json ? readPreviewLocations(json, mapFile, inlined) : undefined;
      this.post({kind: 'svg', title, file, svg: inlined, builtAt: new Date().toLocaleTimeString('ja-JP'), build, ...(mapped && {map: mapped.map})},
        mapped, sourceVersion);
    } finally {
      if (this.building === abort) this.building = undefined;
      if (dir) await fs.rm(dir, {recursive: true, force: true}).catch(() => undefined);
    }
  }

  private async reveal(panel: vscode.WebviewPanel, message: unknown): Promise<void> {
    const table = this.revealTable;
    const target = revealTarget(table, message);
    const changed = () => { vscode.window.setStatusBarMessage('図が新しくなった。もう一度押してください', 4000); };
    if (!table || !target) return changed();

    const {file, line, column} = target.loc;
    const uri = vscode.Uri.file(file);
    try {
      if (!(await fs.stat(file)).isFile()) {
        this.deps.log.warn(`プレビューのソースを開けない: ${file}`);
        return;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      if (this.panel !== panel) return;
      if (this.revealTable !== table) return changed();

      const visible = vscode.window.visibleTextEditors.find(e => e.viewColumn !== panel.viewColumn && e.document === document);
      const viewColumn = visible?.viewColumn ?? (panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One);
      const range = placeSourcePosition(line, column, document.getText());
      const selection = document.validateRange(new vscode.Range(range.line, range.start, range.line, range.end));
      const source = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === table.file);
      const stale = document.isDirty || source?.isDirty || (source && table.sourceVersion !== undefined && source.version !== table.sourceVersion);
      const editor = await vscode.window.showTextDocument(document, {viewColumn, selection});
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      if (stale) vscode.window.setStatusBarMessage('保存前の位置です', 4000);
    } catch (e) {
      this.deps.log.warn(`プレビューのソースを開けない: ${file}: ${(e as Error).message}`);
    }
  }

  private post(message: ToPage, locations?: ReturnType<typeof readPreviewLocations>, sourceVersion?: number): void {
    this.revealTable = tableAfterMessage(this.revealTable, message, locations, sourceVersion);
    this.lastMessage = message;
    void this.panel?.webview.postMessage(message);
  }

  dispose(): void {
    this.building?.abort();
    this.panel?.dispose();
    for (const s of this.subscriptions) s.dispose();
  }
}

export function isSource(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === 'file' && isDiagramSource(doc.fileName, doc.getText());
}
