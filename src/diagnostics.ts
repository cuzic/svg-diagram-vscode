// Runs `svg-diagram check --format json` and shows the findings in the Problems panel.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import {checkArgs, crashFinding, type Finding, findingMessage, isDiagramSource, parseCheckOutput, placeFinding} from './check.ts';
import type {ResolvedCli} from './cli.ts';
import {exec} from './exec.ts';
import {Runs, Semaphore} from './runs.ts';

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
  /** CLI processes at once, over all runs (each loads core, fonts and resvg): half the cores. */
  private readonly slots = new Semaphore(Math.max(1, Math.floor(os.availableParallelism() / 2)));
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly busyListeners = new Set<(busy: number) => void>();
  private readonly deps: CheckerDeps;
  private busy = 0;

  constructor(deps: CheckerDeps) {
    this.deps = deps;
    this.subscriptions.push(
      this.collection,
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.uri.scheme !== 'file') return;
        if (isSource(doc)) { if (setting<boolean>(doc.uri, 'check.onSave')) void this.check([doc.uri]); return; }
        this.collection.delete(doc.uri); // no longer a diagram source (the import or the default export went away)
        // a shared part (or the project settings): the open diagrams of the same folder may import it
        const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
        const relevant = /\.(m?ts|m?js)$/.test(doc.fileName) || path.basename(doc.fileName) === '.svg-diagram.json';
        if (folder && relevant && !doc.uri.fsPath.split(path.sep).includes('node_modules')) this.recheckOpen(folder, 'check.onSave');
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
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('svgDiagram.check.enabled')) this.recheckOpen(undefined, 'check.enabled'); }),
    );
  }

  /** Checks the open diagram sources (activation, settings change; with a folder: a shared part of it was saved). */
  recheckOpen(folder?: vscode.WorkspaceFolder, when: 'check.onOpen' | 'check.onSave' | 'check.enabled' = 'check.onOpen'): void {
    const docs = vscode.workspace.textDocuments.filter(d => isSource(d) && (!folder || vscode.workspace.getWorkspaceFolder(d.uri)?.uri.toString() === folder.uri.toString()));
    for (const d of docs) if (!setting<boolean>(d.uri, 'check.enabled')) this.collection.delete(d.uri);
    const uris = docs.filter(d => setting<boolean>(d.uri, when)).map(d => d.uri);
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
  async check(uris: vscode.Uri[], token?: vscode.CancellationToken): Promise<void> {
    const cancel = new AbortController();
    const sub = token?.onCancellationRequested(() => cancel.abort());
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
      for (let i = 0; i < group.length; i += BATCH) runs.push(this.run(cli, cwd, group.slice(i, i + BATCH), cancel.signal));
    }
    try { await Promise.all(runs); } finally { sub?.dispose(); }
  }

  /**
   * One CLI run. It owns its files from the moment it is asked for (a later save takes a file over, even while this
   * run still waits for a slot), and waits for a slot before it starts the process.
   */
  private async run(cli: ResolvedCli, cwd: string, uris: vscode.Uri[], cancel?: AbortSignal): Promise<void> {
    const run = this.runs.start(uris.map(u => u.toString()));
    const signal = cancel ? AbortSignal.any([run.signal, cancel]) : run.signal;
    const files = uris.map(u => u.fsPath);
    const {log} = this.deps;
    this.setBusy(+1);
    // one file, not part of a cancellable workspace check: a save or an open, which the user is waiting for
    const release = await this.slots.acquire(signal, uris.length === 1 && !cancel);
    try {
      if (!release) return;
      log.debug(`${cli.bin} ${checkArgs(files).join(' ')}（cwd: ${cwd}）`);
      const {stdout, stderr, error} = await exec(cli.bin, checkArgs(files), {cwd, signal});
      release();
      if (signal.aborted) return;
      if (stderr.trim()) log.info(stderr.trim());
      let out: ReturnType<typeof parseCheckOutput>;
      try {
        out = parseCheckOutput(stdout, cwd);
      } catch (e) {
        // exit 1 with JSON is normal (there were errors). No JSON: the CLI stopped, as core 0.5.0 does at the first
        // source that throws. One file: that file is the cause. Several: check them one by one to find which.
        if (!error) { log.error((e as Error).message); return; }
        if (uris.length > 1) {
          // each per-file run takes its file over at once (so this run is done with it); they share the slots
          await Promise.all(uris.filter(u => run.owns(u.toString())).map(u => this.run(cli, cwd, [u], cancel)));
          return;
        }
        const uri = uris[0];
        if (!uri || !run.owns(uri.toString())) return;
        const crash = crashFinding(uri.fsPath, stderr);
        log.error(`${uri.fsPath}: ${crash.message}`);
        const text = await textOf(uri);
        if (run.owns(uri.toString()) && fs.existsSync(uri.fsPath)) this.collection.set(uri, [toDiagnostic(crash, text)]);
        return;
      }
      const byFile = new Map<string, Finding[]>(files.map(f => [path.resolve(f), []]));
      for (const f of out.findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
      for (const [file, findings] of byFile) {
        const asked = uris.find(u => path.resolve(u.fsPath) === file);
        const uri = asked ?? vscode.Uri.file(file);
        // a newer run has this file (its result counts), or it was deleted / renamed while this run was going
        const superseded = () => (!!asked && !run.owns(asked.toString())) || !fs.existsSync(file);
        if (superseded()) continue;
        const text = await textOf(uri);
        if (superseded()) continue;
        this.collection.set(uri, findings.map(f => toDiagnostic(f, text)));
      }
      log.info(`検査: ${files.length} 件、エラー ${out.errors}、警告 ${out.warnings}、所見 ${out.findings.length}`);
    } finally {
      release?.();
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

function toDiagnostic(f: Finding, text: string | undefined): vscode.Diagnostic {
  const p = placeFinding(f, text);
  const d = new vscode.Diagnostic(new vscode.Range(p.line, p.start, p.line, p.end), findingMessage(f), SEVERITY[f.severity] ?? vscode.DiagnosticSeverity.Information);
  d.source = 'svg-diagram';
  d.code = f.rule;
  d.relatedInformation = p.relatedInformation?.map(({file, line, column, label}) => {
    const position = new vscode.Position(line - 1, column - 1);
    return new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file(file), position), label);
  });
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
    .filter(([glob, on]) => on === true && !/[{}]/.test(glob)) // nested braces are not a glob findFiles reads (README says so)
    .map(([glob]) => glob);
  const exclude = `{${['**/node_modules/**', ...excluded].join(',')}}`;
  const candidates = await vscode.workspace.findFiles('**/*.{ts,mts,js,mjs}', exclude, undefined, token);
  const sources: vscode.Uri[] = [];
  for (const uri of candidates) {
    if (token?.isCancellationRequested) return [];
    const text = await textOf(uri);
    if (text !== undefined && isDiagramSource(uri.fsPath, text)) sources.push(uri);
  }
  return sources;
}
