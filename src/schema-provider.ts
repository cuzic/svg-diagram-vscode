// Answers svg-diagram-schema://schema/<file> (package.json `jsonValidation`) with one project's JSON Schemas.
// See schemas.ts for why it is one project at a time.
//
// The root is the one the open JSON files that get a schema (site.json, deck.json, …) agree on; when files of projects
// with different schemas are open (or one of a project without svg-diagram), nothing is checked until one closes. With
// none open (or only ones outside the file system, such as the git side of a diff), it is the one workspace folder that
// has svg-diagram. When what is served changes (such a file opened or closed, a setting changed, svg-diagram installed or
// upgraded), all five files are announced as changed, so VS Code fetches them again together and re-checks the files.
import path from 'node:path';
import * as vscode from 'vscode';
import {describeRoot, isSchemaTarget, onlyRoot, rootFor, rootForOpen, SCHEMA_FILES, SCHEMA_SCHEME, type SchemaProject, type SchemaRoot, sameRoot, schemaFileOf, schemaText, schemaUri} from './schemas.ts';

export interface SchemaProviderDeps {
  /** The project of a file or a workspace folder. */
  projectOf(scope: vscode.Uri): SchemaProject;
  log: vscode.LogOutputChannel;
}

export class SchemaProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly deps: SchemaProviderDeps;
  private readonly disposables: vscode.Disposable[] = [];
  private folderWatchers: vscode.Disposable[] = [];
  private root: SchemaRoot | undefined;
  /** Has VS Code asked yet? (until then, a change need not be announced) */
  private served = false;
  /** The root per directory of the open files (an open or close needs only the new file's); cleared by other refreshes. */
  private readonly byDir = new Map<string, SchemaRoot>();

  constructor(deps: SchemaProviderDeps) {
    this.deps = deps;
    const configs = vscode.workspace.createFileSystemWatcher('**/.svg-diagram.json', false, true, false);
    this.disposables.push(
      this.changed,
      configs,
      configs.onDidCreate(() => this.refresh()),
      configs.onDidDelete(() => this.refresh()),
      // the JSON server checks the open documents (not only the visible ones): follow those
      vscode.workspace.onDidOpenTextDocument(d => { if (this.isTarget(d.uri)) this.refresh(false); }),
      vscode.workspace.onDidCloseTextDocument(d => { if (this.isTarget(d.uri)) this.refresh(false); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.watchFolders(); this.refresh(); }),
      vscode.workspace.registerTextDocumentContentProvider(SCHEMA_SCHEME, this),
    );
    this.watchFolders();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const file = schemaFileOf(uri);
    if (!file) throw new Error(`${uri.toString()}: svg-diagram の JSON Schema ではない`);
    if (!this.root) this.setRoot(this.pick());
    this.served = true;
    return schemaText(this.root ?? {}, file);
  }

  /**
   * Looks again (a target file opened or closed, settings, folders, focus, node_modules changed) and announces what is
   * served when it changed. `relook`: the projects themselves may have changed (anything but an open or close).
   */
  refresh(relook = true): void {
    if (relook) this.byDir.clear();
    const root = this.pick();
    const changed = !sameRoot(this.root, root);
    if (changed || describeRoot(root) !== describeRoot(this.root ?? {})) this.setRoot(root);
    if (changed && this.served) for (const file of SCHEMA_FILES) this.changed.fire(vscode.Uri.parse(schemaUri(file)));
  }

  /** Which core the files come from now (the integration tests read it through the extension's exports). */
  get current(): SchemaRoot | undefined {
    return this.root;
  }

  private setRoot(root: SchemaRoot): void {
    this.root = root;
    this.deps.log.info(`JSON Schema: ${describeRoot(root)}`);
  }

  private pick(): SchemaRoot {
    if (!vscode.workspace.getConfiguration('svgDiagram').get<boolean>('jsonSchemas.enabled', true)) {
      return {reason: '設定 svgDiagram.jsonSchemas.enabled が false なので、JSON は検査しない'};
    }
    const open = vscode.workspace.textDocuments
      .filter(d => this.isTarget(d.uri))
      .map(d => ({name: vscode.workspace.asRelativePath(d.uri), root: this.rootOf(d.uri)}));
    return rootForOpen(open) ?? onlyRoot((vscode.workspace.workspaceFolders ?? []).map(f => rootFor(this.deps.projectOf(f.uri))));
  }

  private rootOf(file: vscode.Uri): SchemaRoot {
    const dir = path.dirname(file.fsPath);
    let root = this.byDir.get(dir);
    if (!root) {
      root = rootFor(this.deps.projectOf(file));
      this.byDir.set(dir, root);
    }
    return root;
  }

  private isTarget(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' && isSchemaTarget(uri.fsPath);
  }

  /**
   * A fresh `pnpm add` or an upgrade in a workspace folder (not recursive: a recursive watcher skips node_modules by
   * `files.watcherExclude`). Packages below a folder are seen when the window gets the focus again.
   */
  private watchFolders(): void {
    for (const d of this.folderWatchers) d.dispose();
    this.folderWatchers = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const nodeModules = vscode.Uri.joinPath(folder.uri, 'node_modules');
      for (const pattern of [new vscode.RelativePattern(nodeModules, 'svg-diagram'), new vscode.RelativePattern(vscode.Uri.joinPath(nodeModules, 'svg-diagram'), 'package.json')]) {
        const w = vscode.workspace.createFileSystemWatcher(pattern);
        this.folderWatchers.push(w, w.onDidCreate(() => this.refresh()), w.onDidChange(() => this.refresh()), w.onDidDelete(() => this.refresh()));
      }
    }
  }

  dispose(): void {
    for (const d of [...this.disposables, ...this.folderWatchers]) d.dispose();
  }
}
