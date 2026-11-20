// Where the svg-diagram CLI is. No `vscode` import here, so it is unit-tested with plain node --test.
//
// Order:
//   1. the `svgDiagram.cliPath` setting (to try a core checked out next to the project: ../svg-diagram/bin/svg-diagram)
//   2. the project's own svg-diagram: node_modules/svg-diagram/package.json, walking up from the workspace folder
//      (pnpm writes node_modules/.bin/* as shell shims, not symlinks, so the package's "bin" field is read instead)
//   3. svg-diagram on PATH (a global install, e.g. ~/.local/bin/svg-diagram as a symlink into a clone)
// The CLI has no --version; the version is read from the package.json beside bin/ when it can be found.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type CliSource = 'setting' | 'project' | 'path';

export interface ResolvedCli {
  /** The executable to spawn. */
  bin: string;
  source: CliSource;
  /** The svg-diagram package directory (has package.json), when known. */
  root?: string;
  version?: string;
}

export interface ResolveResult {
  cli?: ResolvedCli;
  /** Things the user should know even when a CLI was found (e.g. the setting points at nothing, so the project's was used). */
  warnings: string[];
}

export interface ResolveOptions {
  /** The workspace folder the diagram belongs to. */
  folder?: string;
  /** `svgDiagram.cliPath`; relative to `folder`, `~` is the home directory. */
  setting?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const PACKAGE = 'svg-diagram';

export function resolveCli(opts: ResolveOptions): ResolveResult {
  const warnings: string[] = [];
  const setting = opts.setting?.trim();
  if (setting) {
    const bin = expandPath(setting, opts.folder);
    if (isExecutableFile(bin)) return {cli: {bin, source: 'setting', ...packageOf(bin)}, warnings};
    warnings.push(`設定 svgDiagram.cliPath の ${bin} は実行できるファイルではないので、使わなかった`);
  }
  if (opts.folder) {
    const project = findProjectCli(opts.folder);
    if (project) return {cli: project, warnings};
  }
  const onPath = findOnPath(opts.env ?? process.env, opts.platform ?? process.platform);
  if (onPath) return {cli: {bin: onPath, source: 'path', ...packageOf(onPath)}, warnings};
  return {warnings};
}

export function describeCli(cli: ResolvedCli): string {
  const where = {setting: '設定 svgDiagram.cliPath', project: '案件の node_modules', path: 'PATH'}[cli.source];
  return `svg-diagram ${cli.version ?? '(版不明)'}: ${cli.bin}（${where}）`;
}

function expandPath(p: string, folder: string | undefined): string {
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(folder ?? process.cwd(), p);
}

function findProjectCli(folder: string): ResolvedCli | undefined {
  for (let dir = path.resolve(folder); ; ) {
    const root = path.join(dir, 'node_modules', PACKAGE);
    const pkg = readPackage(root);
    if (pkg) {
      const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[PACKAGE];
      const bin = rel && path.resolve(root, rel);
      if (bin && isFile(bin)) return {bin, source: 'project', root, version: pkg.version};
    }
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

function findOnPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const names = platform === 'win32' ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').map(ext => PACKAGE + ext.toLowerCase()) : [PACKAGE];
  for (const dir of (env['PATH'] ?? env['Path'] ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const bin = path.join(dir, name);
      if (isExecutableFile(bin)) return bin;
    }
  }
  return undefined;
}

/** The package a bin belongs to: <root>/bin/svg-diagram → <root>/package.json named svg-diagram (symlinks followed). */
function packageOf(bin: string): {root?: string; version?: string} {
  let real: string;
  try { real = fs.realpathSync(bin); } catch { return {}; }
  const root = path.dirname(path.dirname(real));
  const pkg = readPackage(root);
  return pkg ? {root, version: pkg.version} : {};
}

interface PackageJson { name?: string; version?: string; bin?: string | Record<string, string> }

function readPackage(root: string): PackageJson | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageJson;
    return pkg.name === PACKAGE ? pkg : undefined;
  } catch {
    return undefined;
  }
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isExecutableFile(p: string): boolean {
  if (!isFile(p)) return false;
  if (process.platform === 'win32') return true;
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}
