// Answers svg-diagram-schema://schema/<file> (package.json `jsonValidation`) with the project's own JSON Schemas.
// See schemas.ts for which file is served.
import * as vscode from 'vscode';
import {ACCEPT_ALL, findSchema, SCHEMA_FILES, SCHEMA_SCHEME, type SchemaAnswer, type SchemaCandidate, type SchemaFile, sameAnswer, schemaFileOf, schemaUri} from './schemas.ts';

export interface SchemaProviderDeps {
  /** Where to look, best first (the active file's project, then each workspace folder). */
  candidates(): SchemaCandidate[];
  log: vscode.LogOutputChannel;
}

export class SchemaProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  /** What VS Code was last given, per file: a refresh tells it to fetch again only when the answer changed. */
  private readonly served = new Map<SchemaFile, SchemaAnswer>();
  private readonly disposables: vscode.Disposable[] = [];

  private readonly deps: SchemaProviderDeps;

  constructor(deps: SchemaProviderDeps) {
    this.deps = deps;
    // a fresh `pnpm add` / upgrade of svg-diagram (node_modules may be excluded from watching: focus also refreshes)
    const watcher = vscode.workspace.createFileSystemWatcher('**/{node_modules/svg-diagram/package.json,.svg-diagram.json}');
    this.disposables.push(
      this.changed,
      watcher,
      watcher.onDidCreate(() => this.refresh()),
      watcher.onDidChange(() => this.refresh()),
      watcher.onDidDelete(() => this.refresh()),
      vscode.workspace.registerTextDocumentContentProvider(SCHEMA_SCHEME, this),
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const file = schemaFileOf(uri.path);
    if (!file) throw new Error(`${uri.toString()}: svg-diagram の JSON Schema ではない`);
    const answer = this.answer(file);
    const before = this.served.get(file);
    if (answer.file !== before?.file || answer.reason !== before?.reason) this.deps.log.info(`JSON Schema ${file}: ${answer.file ?? answer.reason}`);
    this.served.set(file, answer);
    return answer.text;
  }

  /** Looks again (settings, folders, focus, node_modules changed) and tells VS Code about the schemas that differ now. */
  refresh(): void {
    for (const file of SCHEMA_FILES) {
      const before = this.served.get(file);
      if (before && !sameAnswer(before, this.answer(file))) this.changed.fire(vscode.Uri.parse(schemaUri(file)));
    }
  }

  private answer(file: SchemaFile): SchemaAnswer {
    if (!vscode.workspace.getConfiguration('svgDiagram').get<boolean>('jsonSchemas.enabled', true)) {
      return {text: ACCEPT_ALL, reason: '設定 svgDiagram.jsonSchemas.enabled が false なので、JSON は検査しない'};
    }
    return findSchema(file, this.deps.candidates());
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
