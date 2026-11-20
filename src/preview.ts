// The live preview: one panel that follows the diagram source in the active editor and redraws it on save.
import {createHash, randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import {isDiagramSource} from './check.ts';
import type {ResolvedCli} from './cli.ts';
import {exec} from './exec.ts';
import {buildArgs, buildErrorText, inlineSvg, previewShellHtml, type ToPage} from './preview-html.ts';

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
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly deps: PreviewDeps;
  /** For tests: the last message sent to the page. */
  lastMessage: ToPage | undefined;

  constructor(deps: PreviewDeps) {
    this.deps = deps;
    this.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(PREVIEW_VIEW_TYPE, this),
      vscode.window.onDidChangeActiveTextEditor(e => { if (e && this.panel && isSource(e.document) && e.document.uri.toString() !== this.source?.toString()) this.follow(e.document.uri); }),
      vscode.workspace.onDidSaveTextDocument(doc => this.onSaved(doc)),
    );
  }

  /** Opens (or reveals) the preview for a source, beside the editor by default. */
  show(uri: vscode.Uri, column: vscode.ViewColumn = vscode.ViewColumn.Beside): void {
    if (this.panel) this.panel.reveal(column, true);
    else this.adopt(vscode.window.createWebviewPanel(PREVIEW_VIEW_TYPE, 'svg-diagram', {viewColumn: column, preserveFocus: true}, {enableScripts: true, retainContextWhenHidden: false, localResourceRoots: []}));
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
    panel.webview.onDidReceiveMessage((m: {kind?: string}) => { if (m?.kind === 'ready' && this.lastMessage) void panel.webview.postMessage(this.lastMessage); });
    panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.panel = undefined;
      this.source = undefined;
      this.building?.abort();
    });
  }

  private follow(uri: vscode.Uri): void {
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
    const cli = this.deps.getCli(source);
    if (!cli) return this.post({kind: 'error', title, file, message: 'svg-diagram の CLI が見つからない（設定 svgDiagram.cliPath、または案件に pnpm add -D svg-diagram）'});
    this.building?.abort();
    const abort = new AbortController();
    this.building = abort;
    this.post({kind: 'building', title, file});

    // one folder per source: build also writes the reveal steps (name.reveal-N.svg) beside --out
    const dir = vscode.Uri.joinPath(this.deps.scratchDir, 'preview', createHash('sha1').update(source.fsPath).digest('hex').slice(0, 16));
    try {
      await fs.rm(dir.fsPath, {recursive: true, force: true});
      await fs.mkdir(dir.fsPath, {recursive: true});
    } catch (e) {
      if (this.building === abort) this.building = undefined;
      return this.post({kind: 'error', title, file, message: `作業用フォルダ ${dir.fsPath} を用意できない: ${(e as Error).message}`});
    }
    if (abort.signal.aborted) return;
    const out = path.join(dir.fsPath, title.replace(/\.(m?ts|m?js)$/, '') + '.svg');
    const {stderr, error} = await exec(cli.bin, buildArgs(source.fsPath, out), {cwd: path.dirname(source.fsPath), signal: abort.signal});
    if (abort.signal.aborted || this.source?.toString() !== source.toString()) return;
    this.building = undefined;

    let svg: string | undefined;
    try { svg = await fs.readFile(out, 'utf8'); } catch { /* not written: the build failed */ }
    if (error || !svg) {
      const message = buildErrorText(source.fsPath, stderr);
      this.deps.log.warn(`プレビュー ${title}: ${message}`);
      return this.post({kind: 'error', title, file, message});
    }
    this.post({kind: 'svg', title, file, svg: inlineSvg(svg), builtAt: new Date().toLocaleTimeString('ja-JP')});
  }

  private post(message: ToPage): void {
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
