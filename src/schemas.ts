// The JSON Schemas of svg-diagram's hand-written JSON files (core ADR 0071), served to VS Code's JSON support.
// No `vscode` import here, so it is unit-tested with plain node --test.
//
// package.json's `jsonValidation` points the files at `svg-diagram-schema://schema/<file>`; the extension answers those
// URIs with the files of the project's own svg-diagram (node_modules/svg-diagram/schema/), so the editor checks against
// the same version as the CLI. The figure and deck schemas name spec.schema.json by a relative $ref, which resolves to
// the same scheme, so all five are served side by side.
//
// When there is nothing to serve (no svg-diagram, a core older than 0.8.0, or the setting is off), the answer is a schema
// that accepts everything: `site.json` and `deck.json` are common names, and a project unrelated to svg-diagram must not
// see errors in them.
import fs from 'node:fs';
import path from 'node:path';
import type {ResolvedCli} from './cli.ts';

export const SCHEMA_SCHEME = 'svg-diagram-schema';
export const SCHEMA_FILES = ['spec.schema.json', 'figure.schema.json', 'deck.schema.json', 'site.schema.json', 'config.schema.json'] as const;
export type SchemaFile = (typeof SCHEMA_FILES)[number];

export const schemaUri = (file: SchemaFile): string => `${SCHEMA_SCHEME}://schema/${file}`;

/** The file a `svg-diagram-schema://schema/<file>` URI path names, if it is one of ours. */
export function schemaFileOf(uriPath: string): SchemaFile | undefined {
  const name = uriPath.replace(/^\/+/, '');
  return (SCHEMA_FILES as readonly string[]).includes(name) ? (name as SchemaFile) : undefined;
}

export const ACCEPT_ALL = `${JSON.stringify({$comment: 'svg-diagram: no JSON Schema to check this file with (see the svg-diagram output log)'})}\n`;

/** Where one schema could come from: the CLI found for a file or folder, and that workspace folder. */
export interface SchemaCandidate {
  cli?: ResolvedCli;
  folder?: string;
}

export interface SchemaAnswer {
  text: string;
  /** The file served, when one was. */
  file?: string;
  /** Its modification time: a changed file (core upgraded in place) is served again. */
  mtimeMs?: number;
  /** Why everything is accepted, when it is (for the log). */
  reason?: string;
}

/**
 * The first candidate whose svg-diagram has the schema. A CLI found only on PATH counts only in a folder that has a
 * `.svg-diagram.json` (a global install must not check every `site.json` on the machine).
 */
export function findSchema(file: SchemaFile, candidates: readonly SchemaCandidate[], read = readFile): SchemaAnswer {
  let old: ResolvedCli | undefined;
  for (const {cli, folder} of candidates) {
    if (!cli?.root) continue;
    if (cli.source === 'path' && !(folder && isFile(path.join(folder, '.svg-diagram.json')))) continue;
    const full = path.join(cli.root, 'schema', file);
    const got = read(full);
    if (got) return {text: got.text, file: full, mtimeMs: got.mtimeMs};
    old ??= cli;
  }
  const reason = old
    ? `svg-diagram ${old.version ?? '(版不明)'}（${old.root}）には JSON Schema が無い。0.8.0 以降に上げると、JSON の補完と検査が効く`
    : 'svg-diagram が見つからないので、JSON は検査しない';
  return {text: ACCEPT_ALL, reason};
}

function readFile(file: string): {text: string; mtimeMs: number} | undefined {
  try {
    return {mtimeMs: fs.statSync(file).mtimeMs, text: fs.readFileSync(file, 'utf8')};
  } catch {
    return undefined;
  }
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** Same answer as before? (only a changed one makes VS Code fetch the schema and re-check the open JSON files) */
export const sameAnswer = (a: SchemaAnswer | undefined, b: SchemaAnswer): boolean =>
  !!a && a.file === b.file && a.mtimeMs === b.mtimeMs && a.text === b.text;
