// Runs `svg-diagram check --format json` and shows the findings in the Problems panel.
import path from 'node:path';
import * as vscode from 'vscode';
import {checkArgs, crashFinding, type Finding, findingMessage, isDiagramSource, parseCheckOutput, placeFinding} from './check.ts';
import type {ResolvedCli} from './cli.ts';
import {exec} from './exec.ts';

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
  /** The run in flight per file; a new save cancels it (only the latest text matters). */
  private readonly running = new Map<string, AbortController>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly busyListeners = new Set<(busy: number) => void>();

  private readonly deps: CheckerDeps;

  constructor(deps: CheckerDeps) {
    this.deps = deps;
    this.subscriptions.push(
      this.collection,
      vscode.workspace.onDidSaveTextDocument(doc => { if (setting<boolean>(doc.uri, 'check.onSave') && isSource(doc)) void this.check([doc.uri]); }),
      vscode.workspace.onDidOpenTextDocument(doc => { if (setting<boolean>(doc.uri, 'check.onOpen') && isSource(doc) && !this.collection.has(doc.uri)) void this.check([doc.uri]); }),
      vscode.workspace.onDidDeleteFiles(e => { for (const uri of e.files) this.collection.delete(uri); }),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('svgDiagram.check.enabled')) this.recheckOpen(); }),
    );
  }

  /** Checks what is open now (activation, settings change). */
  recheckOpen(): void {
    const uris = vscode.workspace.textDocuments.filter(d => setting<boolean>(d.uri, 'check.onOpen') && isSource(d)).map(d => d.uri);
    if (uris.length) void this.check(uris);
  }

  onBusyChange(listener: (busy: number) => void): vscode.Disposable {
    this.busyListeners.add(listener);
    return new vscode.Disposable(() => this.busyListeners.delete(listener));
  }

  /** Checks files (grouped by workspace folder and CLI, in batches). Files whose check is disabled get their findings cleared. */
  async check(uris: vscode.Uri[]): Promise<void> {
    const groups = new Map<string, {cli: ResolvedCli; uris: vscode.Uri[]}>();
    for (const uri of uris) {
      if (!setting<boolean>(uri, 'check.enabled')) { this.collection.delete(uri); continue; }
      const cli = this.deps.getCli(uri);
      if (!cli) return; // getCli has told the user how to install it
      const key = `${vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() ?? ''}\0${cli.bin}`;
      const g = groups.get(key) ?? {cli, uris: []};
      g.uris.push(uri);
      groups.set(key, g);
    }
    const runs: Promise<void>[] = [];
    for (const {cli, uris: group} of groups.values()) {
      for (let i = 0; i < group.length; i += BATCH) runs.push(this.run(cli, group.slice(i, i + BATCH)));
    }
    await Promise.all(runs);
  }

  private async run(cli: ResolvedCli, uris: vscode.Uri[]): Promise<void> {
    const abort = new AbortController();
    for (const uri of uris) { this.running.get(uri.toString())?.abort(); this.running.set(uri.toString(), abort); }
    const files = uris.map(u => u.fsPath);
    // .svg-diagram.json is found by walking up from the current directory, so run where the (first) source is
    const cwd = path.dirname(files[0] ?? '.');
    const {log} = this.deps;
    log.debug(`${cli.bin} ${checkArgs(files).join(' ')}（cwd: ${cwd}）`);
    this.setBusy(+1);
    try {
      const {stdout, stderr, error} = await exec(cli.bin, checkArgs(files), {cwd, signal: abort.signal});
      if (abort.signal.aborted) return;
      if (stderr.trim()) log.info(stderr.trim());
      let out: ReturnType<typeof parseCheckOutput>;
      try {
        out = parseCheckOutput(stdout, cwd);
      } catch (e) {
        // exit 1 with JSON is normal (there were errors). No JSON: the CLI stopped, as core 0.5.0 does at the first
        // source that throws. One file: that file is the cause. Several: check them one by one to find which.
        if (!error) { log.error((e as Error).message); return; }
        if (files.length > 1) { this.releaseRunning(uris, abort); await eachLimited(uris, 4, u => this.run(cli, [u])); return; }
        const crash = crashFinding(path.resolve(files[0] ?? ''), stderr);
        log.error(`${files[0]}: ${crash.message}`);
        const uri = uris[0];
        if (uri) this.collection.set(uri, [toDiagnostic(crash, await this.textOf(uri))]);
        return;
      }
      const byFile = new Map<string, Finding[]>(files.map(f => [path.resolve(f), []]));
      for (const f of out.findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
      for (const [file, findings] of byFile) {
        const uri = vscode.Uri.file(file);
        const text = await this.textOf(uri);
        this.collection.set(uri, findings.map(f => toDiagnostic(f, text)));
      }
      log.info(`検査: ${files.length} 件、エラー ${out.errors}、警告 ${out.warnings}、所見 ${out.findings.length}`);
    } finally {
      this.setBusy(-1);
      this.releaseRunning(uris, abort);
    }
  }

  private releaseRunning(uris: vscode.Uri[], abort: AbortController): void {
    for (const uri of uris) if (this.running.get(uri.toString()) === abort) this.running.delete(uri.toString());
  }

  private async textOf(uri: vscode.Uri): Promise<string | undefined> {
    return vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString())?.getText() ?? (await readText(uri));
  }

  private busy = 0;
  private setBusy(delta: number): void {
    this.busy += delta;
    for (const l of this.busyListeners) l(this.busy);
  }

  dispose(): void {
    for (const a of this.running.values()) a.abort();
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

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { return undefined; }
}

/** All diagram sources in the workspace (node_modules and the files.exclude setting are left out). */
export async function findDiagramSources(token?: vscode.CancellationToken): Promise<vscode.Uri[]> {
  const candidates = await vscode.workspace.findFiles('**/*.{ts,mts,js,mjs}', '**/node_modules/**', undefined, token);
  const sources: vscode.Uri[] = [];
  for (const uri of candidates) {
    const text = await readText(uri);
    if (text !== undefined && isDiagramSource(uri.fsPath, text)) sources.push(uri);
  }
  return sources;
}
