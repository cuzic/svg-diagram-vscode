// Starts a real VS Code (downloaded by @vscode/test-electron) with this extension, driven by Playwright over CDP.
// Linux without a display (this machine) uses Chromium's headless Ozone; CI runs under xvfb, macOS has a screen.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {type ChildProcess, spawn} from 'node:child_process';
import {type Browser, chromium, type FrameLocator, type Page} from '@playwright/test';
import {downloadAndUnzipVSCode} from '@vscode/test-electron';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'workspace');

/** Quiet, predictable user settings: no popups over the parts the tests click. */
const SETTINGS = {
  'git.enabled': false,
  'git.openRepositoryInParentFolders': 'never',
  'chat.disableAIFeatures': true,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'extensions.ignoreRecommendations': true,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'window.restoreWindows': 'none',
  'security.workspace.trust.enabled': false,
};

export interface VsCode {
  browser: Browser;
  win: Page;
  close(): Promise<void>;
}

/**
 * Starts VS Code with a DevTools port and connects Playwright to it over CDP. (Playwright's `_electron.launch` attaches
 * to the window before it navigates; on CI runners it then never saw the workbench load. Connecting over CDP to the
 * running app is what works there.) `traceDir`: a Playwright trace (snapshots of every step) is written there on close.
 */
export async function launch(opts: {open: string[]; traceDir?: string; debugDir?: string}): Promise<VsCode> {
  const version = process.env['VSCODE_VERSION'] ?? 'stable';
  const executablePath = await downloadAndUnzipVSCode(version);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svgd-e2e-'));
  fs.mkdirSync(path.join(tmp, 'user', 'User'), {recursive: true});
  fs.writeFileSync(path.join(tmp, 'user', 'User', 'settings.json'), JSON.stringify(SETTINGS, null, 2));
  const headless = process.platform === 'linux' && !process.env['DISPLAY'];
  const args = [
    // port 0: Chromium picks a free one and prints it (no race with another process taking a port we picked)
    '--remote-debugging-port=0',
    ...(headless ? ['--ozone-platform=headless', '--ozone-override-screen-size=1280,800'] : []),
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []),
    `--user-data-dir=${path.join(tmp, 'user')}`,
    `--extensions-dir=${path.join(tmp, 'ext')}`,
    '--disable-workspace-trust',
    // no OS keyring on CI runners (no D-Bus secret service, a locked Keychain): as VS Code's own smoke tests do
    '--use-inmemory-secretstorage',
    ...(process.platform === 'linux' ? ['--password-store=basic'] : []),
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    '--disable-updates',
    '--disable-experiments',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-telemetry',
    ...(process.env['E2E_TRACE'] ? ['--verbose', '--log=trace'] : []),
    `--extensionDevelopmentPath=${ROOT}`,
    ...opts.open,
  ];
  const child = spawn(executablePath, args, {env: {...process.env, VSCODE_CLI: undefined, ELECTRON_RUN_AS_NODE: undefined}, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32'});
  const log: string[] = [];
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (b: Buffer) => { log.push(b.toString()); if (process.env['E2E_TRACE']) process.stderr.write(b); });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));

  /** Kills the whole process group (main, renderer, extension host, the CLI it runs), waits (≤5 s) for it, then removes the profile. */
  const stop = async () => {
    if (child.exitCode === null && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
    }
    try { fs.rmSync(tmp, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}); } catch { /* a straggler still writing: left in the temp dir */ }
  };
  try {
    const browser = await connect(child, log);
    const win = await workbenchWindow(browser, opts.debugDir);
    const context = win.context();
    if (opts.traceDir) await context.tracing.start({screenshots: true, snapshots: true});
    await win.setViewportSize({width: 1280, height: 800}).catch(() => undefined);
    return {
      browser,
      win,
      async close() {
        if (opts.traceDir) await context.tracing.stop({path: path.join(opts.traceDir, 'trace.zip')}).catch(() => undefined);
        await browser.close().catch(() => undefined);
        await stop();
      },
    };
  } catch (e) {
    if (opts.debugDir) { fs.mkdirSync(opts.debugDir, {recursive: true}); fs.writeFileSync(path.join(opts.debugDir, 'vscode.log'), log.join('')); }
    await stop();
    throw e;
  }
}

/** Waits for Chromium's "DevTools listening on ws://127.0.0.1:<port>/..." line, then connects to that port. */
async function connect(child: ChildProcess, log: string[]): Promise<Browser> {
  const end = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`VS Code exited (code ${child.exitCode}) before its DevTools port opened`);
    const port = log.join('').match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1];
    if (port) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(5000)});
        if (res.ok) return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      } catch { /* not answering yet */ }
    }
    if (Date.now() > end) throw new Error('VS Code did not open its DevTools port within 120s');
    await new Promise(r => setTimeout(r, 300));
  }
}

/**
 * The page with the workbench. Every page of every context is looked at until one has `.monaco-workbench`; each probe
 * has its own deadline. When none does, each page's URL and a screenshot go to `debugDir`.
 */
async function workbenchWindow(browser: Browser, debugDir?: string): Promise<Page> {
  const t0 = Date.now();
  const pages = () => browser.contexts().flatMap(c => c.pages());
  for (const end = Date.now() + 120_000; Date.now() < end; await new Promise(r => setTimeout(r, 500))) {
    for (const page of pages()) {
      const found = await Promise.race([page.locator('.monaco-workbench').count().catch(() => 0), new Promise<number>(r => setTimeout(() => r(0), 2000))]);
      if (found) {
        console.log(`[e2e] workbench after ${Date.now() - t0}ms`);
        return page;
      }
    }
  }
  const lines = pages().map((p, i) => `${i}: ${p.url()}`);
  if (debugDir) {
    fs.mkdirSync(debugDir, {recursive: true});
    fs.writeFileSync(path.join(debugDir, 'windows.txt'), lines.join('\n') + '\n');
    for (const [i, p] of pages().entries()) await p.screenshot({path: path.join(debugDir, `window-${i}.png`), timeout: 10_000}).catch(() => undefined);
  }
  throw new Error(`no VS Code window with the workbench after 120s; pages:\n${lines.join('\n')}`);
}

/** Runs a command by its title from the command palette (F1 works on every platform). */
export async function runCommand(win: Page, title: string): Promise<void> {
  await win.keyboard.press('Escape');
  await win.keyboard.press('F1');
  const input = win.locator('.quick-input-widget input');
  await input.waitFor({state: 'visible'});
  await input.fill(`>${title}`);
  const row = win.locator('.quick-input-widget .monaco-list-row', {hasText: title}).first();
  await row.click(); // the row that matched, not whichever one Enter would pick (a recently used entry)
}

/**
 * Opens a file of the workspace through Quick Open ("Go to File"), in the first editor group: with the preview
 * focused, Quick Open would open it in the preview's group and hide the preview behind it.
 */
export async function openFile(win: Page, name: string): Promise<void> {
  await runCommand(win, 'View: Focus First Editor Group');
  await runCommand(win, 'Go to File...');
  const input = win.locator('.quick-input-widget input');
  await input.fill(name);
  await win.locator('.quick-input-widget .monaco-list-row', {hasText: name}).first().click();
  await activeTab(win, name).waitFor({state: 'visible'});
}

/** The preview's page: VS Code puts a webview in an iframe, and the page in an inner one. */
export function previewFrame(win: Page): FrameLocator {
  return win.frameLocator('iframe.webview.ready').frameLocator('#active-frame');
}

/** The active tab whose label is exactly `name` (not the preview's tab, whose title contains the name too). */
export function activeTab(win: Page, name: string) {
  const exact = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  return win.locator('.tab.active', {has: win.locator('.label-name', {hasText: exact})}).first();
}
