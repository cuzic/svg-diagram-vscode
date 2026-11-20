// Getting a project ready for svg-diagram: which package manager, and what is still missing. No `vscode` import.
import fs from 'node:fs';
import path from 'node:path';

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

/** From the lockfile in the folder or a parent (a monorepo root); npm when there is none. */
export function detectPackageManager(folder: string): PackageManager {
  for (let dir = path.resolve(folder); ; ) {
    if (exists(dir, 'pnpm-lock.yaml') || exists(dir, 'pnpm-workspace.yaml')) return 'pnpm';
    if (exists(dir, 'yarn.lock')) return 'yarn';
    if (exists(dir, 'bun.lock') || exists(dir, 'bun.lockb')) return 'bun';
    if (exists(dir, 'package-lock.json')) return 'npm';
    const up = path.dirname(dir);
    if (up === dir) return 'npm';
    dir = up;
  }
}

/** A package installed for the folder (node_modules/<name>/package.json, walking up like Node does). */
export function hasPackage(folder: string, name: string): boolean {
  for (let dir = path.resolve(folder); ; ) {
    if (exists(dir, 'node_modules', name, 'package.json')) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

export interface SetupState {
  /** svg-diagram is in the project's node_modules (a CLI only on PATH or in the setting does not count: the DSL is imported from the project). */
  hasCore: boolean;
  hasTypescript: boolean;
  hasTypesNode: boolean;
  hasTsconfig: boolean;
  /** package.json has "type": "module". */
  isModule: boolean;
}

export function readSetupState(folder: string): SetupState {
  let isModule = false;
  try { isModule = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')).type === 'module'; } catch { /* no package.json yet */ }
  return {
    hasCore: hasPackage(folder, 'svg-diagram'),
    hasTypescript: hasPackage(folder, 'typescript'),
    hasTypesNode: hasPackage(folder, '@types/node'),
    hasTsconfig: exists(folder, 'tsconfig.json'),
    isModule,
  };
}

/**
 * The shell line that finishes the setup (README「案件のリポジトリに入れる」): add what is missing, then `svg-diagram init`
 * when package.json / tsconfig.json are not ready. Empty when there is nothing to do.
 */
export function setupCommand(pm: PackageManager, s: SetupState): string {
  const missing = [!s.hasCore && 'svg-diagram', !s.hasTypescript && 'typescript', !s.hasTypesNode && '@types/node'].filter((x): x is string => !!x);
  const steps: string[] = [];
  if (missing.length) steps.push(`${pm === 'npm' ? 'npm install' : `${pm} add`} -D ${missing.join(' ')}`);
  if (!s.hasTsconfig || !s.isModule) steps.push(`${{pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx', npm: 'npx'}[pm]} svg-diagram init`);
  return steps.join(' && ');
}

function exists(...parts: string[]): boolean {
  return fs.existsSync(path.join(...parts));
}
