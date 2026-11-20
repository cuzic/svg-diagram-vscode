// Runs `svg-diagram check --format json` and shows the findings in the Problems panel.
import path from 'node:path';
import * as vscode from 'vscode';
import {checkArgs, crashFinding, type Finding, findingMessage, isDiagramSource, parseCheckOutput, placeFinding} from './check.ts';
import type {ResolvedCli} from './cli.ts';
import {exec} from './exec.ts';
import {Runs} from './runs.ts';

/** One CLI run checks at most this many files (the command line stays short; a stuck run loses little). */
const BATCH = 40;

const SEVERITY: Record<Finding['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warn: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

export interface CheckerDeps {
  getCli(scope: vscode.Uri): ResolvedCli | undefined;
  log: vscode.LogOutputChannel;
}

export class Checker implements vscode.Disposable {
  readonly collection = vscode.languages.createDiagnosticCollection('svg-diagram');
  /** Per file, the latest run wins; a run over many files is not cancelled by a save of one of them (see runs.ts). */
  private readonly runs = new Runs<string>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly busyListeners = new Set<(busy: number) => void>();
  private readonly deps: CheckerDeps;
  private busy = 0;

  constructor(deps: CheckerDeps) {
    this.deps = deps;
    this.subscriptions.push(
      this.collection,
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (isSource(doc)) { if (setting<boolean>(doc.uri, 'check.onSave')) void this.check([doc.uri]); }
        else this.collection.delete(doc.uri); // no longer a diagram source (the import or the default export went away)
      }),
      // re-checked on every open: the file may have changed outside the editor (a git checkout) since the last findings
      vscode.workspace.onDidOpenTextDocument(doc => { if (setting<boolean>(doc.uri, 'check.onOpen') && isSource(doc)) void this.check([doc.uri]); }),
      vscode.workspace.onDidDeleteFiles(e => { for (const uri of e.files) this.forget(uri); }),
      vscode.workspace.onDidRenameFiles(e => {
        for (const {oldUri, newUri} of e.files) {
          this.forget(oldUri);
          const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === newUri.toString());
          if (doc && isSource(doc) && setting<boolean>(newUri, 'check.onOpen')) void this.check([newUri]);
        }
      }),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('svgDiagram.check.enabled')) this.recheckOpen(); }),
    );
  }

  /** Checks what is open now (activation, settings change). */
  recheckOpen(): void {
    const docs = vscode.workspace.textDocuments.filter(isSource);
    for (const d of docs) if (!setting<boolean>(d.uri, 'check.enabled')) this.collection.delete(d.uri);
    const uris = docs.filter(d => setting<boolean>(d.uri, 'check.onOpen')).map(d => d.uri);
    if (uris.length) void this.check(uris);
  }

  onBusyChange(listener: (busy: number) => void): vscode.Disposable {
    this.busyListeners.add(listener);
    return new vscode.Disposable(() => this.busyListeners.delete(listener));
  }

  /**
   * Checks files. They are grouped by CLI and by directory: the CLI finds .svg-diagram.json by walking up from its
   * current directory, so each file is checked from its own directory, as when it is checked alone.
   * A file whose CLI cannot be found is skipped (getCli has told the user), the others are still checked.
   */
  async check(uris: vscode.Uri[]): Promise<void> {
    const groups = new Map<string, {cli: ResolvedCli; cwd: string; uris: vscode.Uri[]}>();
    for (const uri of uris) {
      if (uri.scheme !== 'file') continue;
      if (!setting<boolean>(uri, 'check.enabled')) { this.collection.delete(uri); continue; }
      const cli = this.deps.getCli(uri);
      if (!cli) continue;
      const cwd = path.dirname(uri.fsPath);
      const key = `${cli.bin}\0${cwd}`;
      const g = groups.get(key) ?? {cli, cwd, uris: []};
      g.uris.push(uri);
      groups.set(key, g);
    }
    const runs: Promise<void>[] = [];
    for (const {cli, cwd, uris: group} of groups.values()) {
      for (let i = 0; i < group.length; i += BATCH) runs.push(this.run(cli, cwd, group.slice(i, i + BATCH)));
    }
    await Promise.all(runs);
  }

  private async run(cli: ResolvedCli, cwd: string, uris: vscode.Uri[]): Promise<void> {
    const run = this.runs.start(uris.map(u => u.toString()));
    const files = uris.map(u => u.fsPath);
    const {log} = this.deps;
    log.debug(`${cli.bin} ${checkArgs(files).join(' ')}（cwd: ${cwd}）`);
    this.setBusy(+1);
    try {
      const {stdout, stderr, error} = await exec(cli.bin, checkArgs(files), {cwd, signal: run.signal});
      if (run.signal.aborted) return;
      if (stderr.trim()) log.info(stderr.trim());
      let out: ReturnType<typeof parseCheckOutput>;
      try {
        out = parseCheckOutput(stdout, cwd);
      } catch (e) {
        // exit 1 with JSON is normal (there were errors). No JSON: the CLI stopped, as core 0.5.0 does at the first
        // source that throws. One file: that file is the cause. Several: check them one by one to find which.
        if (!error) { log.error((e as Error).message); return; }
        const mine = uris.filter(u => run.owns(u.toString()));
        if (uris.length > 1) {
          this.runs.finish(run);
          await eachLimited(mine, 4, u => this.run(cli, cwd, [u]));
          return;
        }
        const uri = uris[0];
        if (!uri || !mine.length) return;
        const crash = crashFinding(uri.fsPath, stderr);
        log.error(`${uri.fsPath}: ${crash.message}`);
        this.collection.set(uri, [toDiagnostic(crash, await textOf(uri))]);
        return;
      }
      const byFile = new Map<string, Finding[]>(files.map(f => [path.resolve(f), []]));
      for (const f of out.findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
      for (const [file, findings] of byFile) {
        const asked = uris.find(u => path.resolve(u.fsPath) === file);
        const uri = asked ?? vscode.Uri.file(file);
        const superseded = () => !!asked && !run.owns(asked.toString()); // a newer run has this file: its result counts
        if (superseded()) continue;
        const text = await textOf(uri);
        if (superseded()) continue;
        this.collection.set(uri, findings.map(f => toDiagnostic(f, text)));
      }
      log.info(`検査: ${files.length} 件、エラー ${out.errors}、警告 ${out.warnings}、所見 ${out.findings.length}`);
    } finally {
      this.setBusy(-1);
      this.runs.finish(run);
    }
  }

  private forget(uri: vscode.Uri): void {
    // the folder of a rename / delete: everything below it goes
    const prefix = uri.toString().replace(/\/?$/, '/');
    this.collection.forEach(u => { if (u.toString() === uri.toString() || u.toString().startsWith(prefix)) this.collection.delete(u); });
  }

  private setBusy(delta: number): void {
    this.busy += delta;
    for (const l of this.busyListeners) l(this.busy);
  }

  dispose(): void {
    this.runs.abortAll();
    for (const s of this.subscriptions) s.dispose();
  }
}

async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) { const item = items[next++] as T; await fn(item); } };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
}

function toDiagnostic(f: Finding, text: string | undefined): vscode.Diagnostic {
  const p = placeFinding(f, text);
  const d = new vscode.Diagnostic(new vscode.Range(p.line, p.start, p.line, p.end), findingMessage(f), SEVERITY[f.severity] ?? vscode.DiagnosticSeverity.Information);
  d.source = 'svg-diagram';
  d.code = f.rule;
  return d;
}

function isSource(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === 'file' && isDiagramSource(doc.fileName, doc.getText());
}

function setting<T>(uri: vscode.Uri, key: string): T | undefined {
  return vscode.workspace.getConfiguration('svgDiagram', uri).get<T>(key);
}

async function textOf(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { return undefined; }
}

/**
 * All diagram sources in the workspace. An explicit exclude replaces files.exclude in findFiles, so the exclude is
 * node_modules plus whatever files.exclude turns on (dist/, out/ and the like are usually there).
 */
export async function findDiagramSources(token?: vscode.CancellationToken): Promise<vscode.Uri[]> {
  const excluded = Object.entries(vscode.workspace.getConfiguration('files').get<Record<string, unknown>>('exclude') ?? {})
    .filter(([, on]) => on === true)
    .map(([glob]) => glob);
  const exclude = `{${['**/node_modules/**', ...excluded].join(',')}}`;
  const candidates = await vscode.workspace.findFiles('**/*.{ts,mts,js,mjs}', exclude, undefined, token);
  const sources: vscode.Uri[] = [];
  for (const uri of candidates) {
    const text = await textOf(uri);
    if (text !== undefined && isDiagramSource(uri.fsPath, text)) sources.push(uri);
  }
  return sources;
}
