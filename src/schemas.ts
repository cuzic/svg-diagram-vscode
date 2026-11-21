// The JSON Schemas of svg-diagram's hand-written JSON files (core ADR 0071), served to VS Code's JSON support.
// No `vscode` import here, so it is unit-tested with plain node --test.
//
// package.json's `jsonValidation` points the files at `svg-diagram-schema://schema/<file>`; the extension answers those
// URIs with the files of a project's own svg-diagram (node_modules/svg-diagram/schema/), so the editor checks against
// the same version as the CLI. The figure and deck schemas name spec.schema.json by a relative $ref, which resolves to
// the same scheme, so all five are served side by side, always from one core (one "root").
//
// A `jsonValidation` URI is one per window: VS Code does not say which file a schema is for. So the root is taken from
// one project at a time, the project of the active JSON file (see schema-provider.ts), and every matched file in the
// window is checked against it.
//
// When there is nothing to serve (no svg-diagram in that project, a core older than 0.8.0, or the setting is off), the
// answer is a schema that accepts everything: `site.json` and `deck.json` are common names, and a project unrelated to
// svg-diagram must not see errors in them.
import fs from 'node:fs';
import path from 'node:path';
import type {ResolvedCli} from './cli.ts';

export const SCHEMA_SCHEME = 'svg-diagram-schema';
const AUTHORITY = 'schema';
export const SCHEMA_FILES = ['spec.schema.json', 'figure.schema.json', 'deck.schema.json', 'site.schema.json', 'config.schema.json'] as const;
export type SchemaFile = (typeof SCHEMA_FILES)[number];

export const schemaUri = (file: SchemaFile): string => `${SCHEMA_SCHEME}://${AUTHORITY}/${file}`;

/** The file a `svg-diagram-schema://schema/<file>` URI names, if it is one of ours. */
export function schemaFileOf(uri: {authority: string; path: string}): SchemaFile | undefined {
  if (uri.authority !== AUTHORITY) return undefined;
  const name = uri.path.replace(/^\/+/, '');
  return (SCHEMA_FILES as readonly string[]).includes(name) ? (name as SchemaFile) : undefined;
}

/** The names package.json's `jsonValidation` gives a schema (kept in step by test/unit/manifest.test.ts). */
export const SCHEMA_TARGETS: ReadonlyArray<{pattern: string; file: SchemaFile}> = [
  {pattern: '.svg-diagram.json', file: 'config.schema.json'},
  {pattern: 'site.json', file: 'site.schema.json'},
  {pattern: 'deck.json', file: 'deck.schema.json'},
  {pattern: 'deck-*.json', file: 'deck.schema.json'},
  {pattern: '*.deck.json', file: 'deck.schema.json'},
];

/** Does a file of this name get one of the schemas? (the file's basename; `*` is any run of characters but `/`) */
export function isSchemaTarget(filePath: string): boolean {
  if (/[\\/]node_modules[\\/]/.test(filePath)) return false;
  const name = path.basename(filePath);
  return SCHEMA_TARGETS.some(({pattern}) => new RegExp(`^${pattern.split('*').map(escapeRegExp).join('[^/]*')}$`).test(name));
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const ACCEPT_ALL = `${JSON.stringify({$comment: 'svg-diagram: no JSON Schema to check this file with (see the svg-diagram output log)'})}\n`;

/** How to get a core with the schemas (npm has only 0.5.0 so far). */
export const CORE_TARBALL = 'https://github.com/cuzic/svg-diagram/releases/download/v0.8.0/svg-diagram-0.8.0.tgz';
export const SCHEMA_CORE_HINT = `0.8.0 以降で効く（npm には 0.5.0 までしかないので、\`pnpm add -D ${CORE_TARBALL}\`）`;

/** One project, as found for a file (or a folder). */
export interface SchemaProject {
  /** The CLI found for it (resolveCli: the setting, the project's node_modules, PATH). */
  cli?: ResolvedCli;
  /** The project's own node_modules/svg-diagram, looked up without the setting and PATH (when `cli` is another one). */
  projectCli?: ResolvedCli;
  /** Where a `.svg-diagram.json` is looked for, walking up: the file's directory (or the folder). */
  from?: string;
  /** The workspace folder: a node_modules/svg-diagram above it is not the project's own. */
  folder?: string;
  /** true when `svgDiagram.cliPath` has no workspace or folder value: a user-level path is not a project of its own. */
  settingIsGlobal?: boolean;
}

/** Which core the five files come from; `dir` unset means "accept everything", for `reason`. */
export interface SchemaRoot {
  dir?: string;
  version?: string;
  /** Which core exactly (real path, version, newest file time): a core upgraded in place is a new root. */
  stamp?: string;
  reason?: string;
}

/**
 * The root of a project. Its own node_modules/svg-diagram (inside its workspace folder) counts. A CLI from PATH, from a
 * user-level `svgDiagram.cliPath`, or from a node_modules above the workspace folder counts only where a
 * `.svg-diagram.json` is found from the file up (a global install must not check every `site.json` on the machine);
 * otherwise the project's own core, if it has one.
 */
export function rootFor(project: SchemaProject): SchemaRoot {
  const {cli} = project;
  if (!cli?.root) return {reason: 'svg-diagram が見つからないので、JSON は検査しない'};
  if (isOwn(cli, project) || (project.from && findUp(project.from, '.svg-diagram.json'))) return rootOf(cli.root, cli.version);
  const own = project.projectCli;
  if (own?.root && own.root !== cli.root && isOwn(own, project)) return rootOf(own.root, own.version);
  const where = {path: 'PATH', setting: 'ユーザー設定の svgDiagram.cliPath', project: 'ワークスペースフォルダの外の node_modules'}[cli.source];
  return {reason: `${where} の svg-diagram（${cli.root}）は、.svg-diagram.json が無い案件には使わないので、JSON は検査しない`};
}

function isOwn(cli: ResolvedCli, project: SchemaProject): boolean {
  if (cli.source === 'setting') return !project.settingIsGlobal;
  if (cli.source !== 'project' || !cli.root || !project.folder) return false;
  const rel = path.relative(project.folder, cli.root);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function rootOf(root: string, version: string | undefined): SchemaRoot {
  const dir = path.join(root, 'schema');
  const times = SCHEMA_FILES.map(f => mtime(path.join(dir, f)));
  if (times[0] === undefined) return {reason: `svg-diagram ${version ?? '(版不明)'}（${root}）には JSON Schema が無い。${SCHEMA_CORE_HINT}`};
  let real = root;
  try { real = fs.realpathSync(root); } catch { /* as found */ }
  return {dir, version, stamp: `${real}|${version}|${Math.max(...times.map(t => t ?? 0))}`};
}

/** The first of several roots that has the schemas, when exactly one does (several folders: no way to choose). */
export function onlyRoot(roots: readonly SchemaRoot[]): SchemaRoot {
  const found = roots.filter(r => r.dir);
  const distinct = new Set(found.map(r => r.dir));
  if (distinct.size === 1 && found[0]) return found[0];
  if (distinct.size > 1) return {reason: 'svg-diagram が複数のフォルダにあるので、JSON のファイルを開くまで検査しない'};
  return roots[0] ?? {reason: 'svg-diagram が見つからないので、JSON は検査しない'};
}

/**
 * The root for the target files that are open (one schema serves them all). Only when they all agree: a file of an
 * unrelated project, or of a project with another core, open beside them turns the checks off, rather than showing
 * errors in a file the schema is not for.
 */
export function rootForOpen(open: ReadonlyArray<{name: string; root: SchemaRoot}>): SchemaRoot | undefined {
  const [first] = open;
  if (!first) return undefined;
  const other = open.find(o => o.root.dir !== first.root.dir);
  if (!other) return first.root;
  const [a, b] = first.root.dir ? [first, other] : [other, first];
  return {reason: `${a.name}（${a.root.dir ? `svg-diagram ${a.root.version ?? ''}` : 'svg-diagram 無し'}）と ${b.name}（${b.root.dir ? `svg-diagram ${b.root.version ?? ''}` : 'svg-diagram 無し'}）が開いていて、1 つの JSON Schema では両方を検査できないので、JSON は検査しない（どちらかを閉じると検査する）`};
}

export const sameRoot = (a: SchemaRoot | undefined, b: SchemaRoot): boolean =>
  !!a && a.dir === b.dir && a.stamp === b.stamp && a.reason === b.reason;

/** The text of one file of a root (accept everything when there is none, or it cannot be read). */
export function schemaText(root: SchemaRoot, file: SchemaFile): string {
  if (!root.dir) return ACCEPT_ALL;
  try { return fs.readFileSync(path.join(root.dir, file), 'utf8'); } catch { return ACCEPT_ALL; }
}

export const describeRoot = (root: SchemaRoot): string => (root.dir ? `svg-diagram ${root.version ?? '(版不明)'} の ${root.dir}` : (root.reason ?? ''));

function mtime(file: string): number | undefined {
  try { return fs.statSync(file).mtimeMs; } catch { return undefined; }
}

function findUp(dir: string, name: string): boolean {
  for (let d = path.resolve(dir); ; ) {
    try { if (fs.statSync(path.join(d, name)).isFile()) return true; } catch { /* not here */ }
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
}
