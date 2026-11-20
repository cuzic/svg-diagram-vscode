// `svg-diagram check --format json` → findings placed in the source. No `vscode` import (unit-tested with node --test).
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export type Severity = 'error' | 'warn' | 'info';

/** One entry of `check --format json`'s `findings` (core: check-diagram.ts CheckFinding). */
export interface Finding {
  file: string;
  line?: number;
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
  /** true when the CLI gave no line: the place is the band's label found in the text, or the first line. */
  approximate: boolean;
  finding: Finding;
}

export function checkArgs(files: string[]): string[] {
  return ['check', '--format', 'json', ...files];
}

/**
 * Parses the CLI's stdout. `file` is made absolute against `cwd` (the CLI echoes the path it was given).
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
    findings: o.findings.map(f => ({...f, file: path.resolve(cwd, f.file)})),
  };
}

/**
 * Where a finding goes in its source text. A CLI line wins. Otherwise a layout finding names its band
 * (`data.band` = 「受付」): when that label appears in exactly one string literal, the squiggle goes on it.
 * Everything else sits on the first line, as a whole-line mark.
 */
export function placeFinding(f: Finding, text: string | undefined): Placed {
  const lines = text?.split(/\r?\n/) ?? [];
  if (f.line && f.line >= 1) {
    const i = f.line - 1;
    const s = lines[i] ?? '';
    const start = s.length - s.trimStart().length;
    return {file: f.file, line: i, start, end: Math.max(s.length, start + 1), approximate: false, finding: f};
  }
  const label = f.data?.band?.match(/^「(.+)」$/)?.[1];
  if (label && text) {
    const hits: {line: number; col: number}[] = [];
    lines.forEach((s, line) => {
      for (const q of ["'", '"', '`']) {
        for (let col = s.indexOf(q + label + q); col >= 0; col = s.indexOf(q + label + q, col + 1)) hits.push({line, col: col + 1});
      }
    });
    if (hits.length === 1 && hits[0]) {
      const {line, col} = hits[0];
      return {file: f.file, line, start: col, end: col + label.length, approximate: true, finding: f};
    }
  }
  return {file: f.file, line: 0, start: 0, end: Math.max(lines[0]?.length ?? 0, 1), approximate: true, finding: f};
}

/** The message as shown: the CLI's message, then how to fix it when the CLI says. */
export function findingMessage(f: Finding): string {
  return f.data?.fix ? `${f.message}\n直し方: ${f.data.fix}` : f.message;
}

/**
 * A diagram source imports the DSL (`from 'svg-diagram'`; 'svg-diagram/browser' is for pages, not sources) and has a
 * default export (the `define()` that build and check call). A module of shared parts imports the DSL too, but has no
 * default export: it is not a diagram, and check / build would fail on it.
 */
export function isDiagramSource(fileName: string, text: string): boolean {
  if (!/\.(m?ts|m?js)$/.test(fileName) || /\.d\.ts$/.test(fileName)) return false;
  const importsDsl = /\bfrom\s+['"]svg-diagram['"]|\brequire\(\s*['"]svg-diagram['"]\s*\)|\bimport\(\s*['"]svg-diagram['"]\s*\)/.test(text);
  return importsDsl && /\bexport\s+default\b|\bexport\s*\{[^}]*\bas\s+default\b/.test(text);
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
