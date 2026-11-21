// `svg-diagram check --format json` → findings placed in the source. No `vscode` import (unit-tested with node --test).
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export type Severity = 'error' | 'warn' | 'info';

interface SourcePosition {
  line: number;
  column: number;
}

interface SourceLocation extends SourcePosition {
  file: string;
}

interface RelatedInformation extends SourceLocation {
  label: string;
}

/** One entry of `check --format json`'s `findings` (core: check-diagram.ts CheckFinding). */
export interface Finding {
  file: string;
  line?: number;
  column?: number;
  location?: SourceLocation;
  via?: SourcePosition[];
  related?: SourceLocation[];
  rule: string;
  severity: Severity;
  message: string;
  data?: {band?: string; measured?: number; threshold?: number; fix?: string};
}

export interface CheckOutput {
  errors: number;
  warnings: number;
  findings: Finding[];
}

/** A placed finding: 0-based line, columns of the squiggle (end exclusive), and whether the place is a guess. */
export interface Placed {
  file: string;
  line: number;
  start: number;
  end: number;
  /** true when the CLI gave no line in this file: the band's label or the first line. */
  approximate: boolean;
  finding: Finding;
  relatedInformation?: RelatedInformation[];
}

export function checkArgs(files: string[]): string[] {
  return ['check', '--format', 'json', ...files];
}

/**
 * Parses the CLI's stdout. The finding, location and related paths are made absolute against `cwd`.
 * Throws with the start of the output when it is not the JSON shape (an old CLI, a crash before the summary).
 */
export function parseCheckOutput(stdout: string, cwd: string): CheckOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error(`check の出力が JSON ではない: ${stdout.trim().slice(0, 200) || '（空）'}`);
  }
  const o = raw as Partial<CheckOutput>;
  if (!o || !Array.isArray(o.findings)) throw new Error(`check の出力に findings がない: ${stdout.trim().slice(0, 200)}`);
  return {
    errors: o.errors ?? 0,
    warnings: o.warnings ?? 0,
    findings: o.findings.map(f => ({
      ...f,
      file: path.resolve(cwd, f.file),
      ...(f.location ? {location: {...f.location, file: path.resolve(cwd, f.location.file)}} : {}),
      ...(f.related ? {related: f.related.map(p => ({...p, file: path.resolve(cwd, p.file)}))} : {}),
    })),
  };
}

function isSourcePosition(p: SourcePosition | undefined): p is SourcePosition {
  return !!p && Number.isInteger(p.line) && p.line >= 1 && Number.isInteger(p.column) && p.column >= 1;
}

const identifier = /^[$_\p{ID_Start}](?:[$\p{ID_Continue}]|\u200c|\u200d)*/u;
const leadingKeywords = /^(?:(?:new|await|typeof|void|delete|throw|return|yield)\s+)+/u;

/**
 * Where a finding goes in its source text. A CLI line wins. A location in another file goes on the first line.
 * Otherwise a layout finding names its band (`data.band` = 「受付」). A unique string literal puts the squiggle there.
 * Everything else sits on the first line, as a whole-line mark.
 */
export function placeFinding(f: Finding, text: string | undefined): Placed {
  const lines = text?.split(/\r?\n/) ?? [];
  const relatedInformation: RelatedInformation[] = [];
  const loc = isSourcePosition(f.location) ? f.location : undefined;
  if (loc) relatedInformation.push({...loc, label: '指摘箇所'});
  for (const p of f.via ?? []) {
    if (isSourcePosition(p)) relatedInformation.push({...p, file: f.file, label: '呼び出し元'});
  }
  for (const p of f.related ?? []) {
    if (isSourcePosition(p)) relatedInformation.push({...p, label: '相手'});
  }
  const placed = {file: f.file, finding: f, ...(relatedInformation.length ? {relatedInformation} : {})};
  if (f.line && f.line >= 1) {
    const i = f.line - 1;
    const s = lines[i] ?? '';
    if (f.column && f.column >= 1 && f.column <= s.length) {
      const start = f.column - 1;
      const tail = s.slice(start);
      const prefix = tail.match(leadingKeywords)?.[0];
      const operand = prefix && tail.slice(prefix.length).match(identifier)?.[0];
      if (prefix && operand) {
        const operandStart = start + prefix.length;
        return {...placed, line: i, start: operandStart, end: operandStart + operand.length, approximate: false};
      }
      const token = tail.match(identifier)?.[0] ?? tail.match(/^./u)?.[0];
      return {...placed, line: i, start, end: start + (token?.length ?? 1), approximate: false};
    }
    const start = s.length - s.trimStart().length;
    return {...placed, line: i, start, end: Math.max(s.length, start + 1), approximate: false};
  }
  const label = f.data?.band?.match(/^「(.+)」$/)?.[1];
  if (!loc && label && text) {
    const hits: {line: number; col: number}[] = [];
    lines.forEach((s, line) => {
      for (const q of ["'", '"', '`']) {
        for (let col = s.indexOf(q + label + q); col >= 0; col = s.indexOf(q + label + q, col + 1)) hits.push({line, col: col + 1});
      }
    });
    if (hits.length === 1 && hits[0]) {
      const {line, col} = hits[0];
      return {...placed, line, start: col, end: col + label.length, approximate: true};
    }
  }
  return {...placed, line: 0, start: 0, end: Math.max(lines[0]?.length ?? 0, 1), approximate: true};
}

/** The message as shown: the CLI's message, then how to fix it when the CLI says. */
export function findingMessage(f: Finding): string {
  const loc = f.location;
  const message = isSourcePosition(loc) ? `${path.basename(loc.file)}:${loc.line}:${loc.column}: ${f.message}` : f.message;
  return f.data?.fix ? `${message}\n直し方: ${f.data.fix}` : message;
}

/**
 * A diagram source imports the DSL (`from 'svg-diagram'`; 'svg-diagram/browser' is for pages, not sources) and has a
 * default export (the `define()` that build and check call; core only asks that it is a function). Comments do not count. A module of shared parts imports the DSL too, but has no
 * default export: it is not a diagram, and check / build would fail on it.
 */
export function isDiagramSource(fileName: string, text: string): boolean {
  if (!/\.(m?ts|m?js)$/.test(fileName) || /\.d\.ts$/.test(fileName)) return false;
  // Comments are stripped without a tokenizer, so a `/*` inside a string ('icons/*.svg') can swallow real code.
  // Either reading is enough: the stripped text, or the raw text with the statements at the start of a line.
  return looksLikeSource(withoutComments(text), false) || looksLikeSource(text, true);
}

function looksLikeSource(code: string, lineStart: boolean): boolean {
  const at = lineStart ? '^\\s*' : '\\b';
  const importsDsl = new RegExp(`${at}import\\b[^;]*?\\bfrom\\s+['"]svg-diagram['"]|\\bimport\\(\\s*['"]svg-diagram['"]\\s*\\)`, 'm').test(code);
  if (!importsDsl) return false;
  if (new RegExp(`${at}export\\s+default\\b`, 'm').test(code)) return true;
  // `export {define as default}` / `export {default} from './x.ts'`; not `export {default as box} from` (a barrel of parts)
  for (const m of code.matchAll(new RegExp(`${at}export\\s*\\{([^}]*)\\}`, 'gm'))) {
    if ((m[1] ?? '').split(',').map(x => x.trim()).some(x => x === 'default' || /\bas\s+default$/.test(x))) return true;
  }
  return false;
}

/** Drops block comments and line comments (a `//` at the start of a line or after a space: not `https://` in a string). */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/**
 * A finding for a source whose check crashed without JSON (core 0.5.0 and older stop at the first source that throws).
 * The line is the first stack frame (or the header Node prints) inside the source; the message is the `Error: ...` line.
 */
export function crashFinding(file: string, stderr: string): Finding {
  const lines = stderr.split(/\r?\n/);
  let line: number | undefined;
  // Node prints the real path: a workspace opened through a symlink names the file differently
  let real = file;
  try { real = fs.realpathSync(file); } catch { /* gone, or a test path */ }
  const prefixes = [...new Set([file, real])].flatMap(p => [pathToFileURL(p).href, p]);
  for (const prefix of prefixes) {
    for (const s of lines) {
      const i = s.indexOf(prefix + ':');
      const m = i >= 0 ? s.slice(i + prefix.length).match(/^:(\d+)/) : null;
      if (m) { line = Number(m[1]); break; }
    }
    if (line) break;
  }
  const error = lines.find(s => /^[A-Z]\w*(Error|Exception)\b[^:]*: /.test(s));
  const last = [...lines].reverse().find(s => s.trim() && !/^Node\.js v/.test(s) && !/^\s+at /.test(s));
  return {file, ...(line ? {line} : {}), rule: 'build-error', severity: 'error', message: (error ?? last ?? 'check が JSON を出さずに失敗した').trim()};
}
