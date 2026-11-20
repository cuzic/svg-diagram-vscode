// Starts a real VS Code (downloaded by @vscode/test-electron) with this extension, driven by Playwright.
// Linux without a display (this machine) uses Chromium's headless Ozone; CI runs under xvfb, macOS has a screen.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {_electron, type ElectronApplication, type FrameLocator, type Page} from '@playwright/test';
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
  app: ElectronApplication;
  win: Page;
  close(): Promise<void>;
}

export async function launch(opts: {open: string[]; videoDir?: string}): Promise<VsCode> {
  const version = process.env['VSCODE_VERSION'] ?? 'stable';
  const executablePath = await downloadAndUnzipVSCode(version);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svgd-e2e-'));
  fs.mkdirSync(path.join(tmp, 'user', 'User'), {recursive: true});
  fs.writeFileSync(path.join(tmp, 'user', 'User', 'settings.json'), JSON.stringify(SETTINGS, null, 2));
  const headless = process.platform === 'linux' && !process.env['DISPLAY'];
  const app = await _electron.launch({
    executablePath,
    args: [
      ...(headless ? ['--ozone-platform=headless', '--ozone-override-screen-size=1280,800'] : []),
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []),
      `--user-data-dir=${path.join(tmp, 'user')}`,
      `--extensions-dir=${path.join(tmp, 'ext')}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-telemetry',
      `--extensionDevelopmentPath=${ROOT}`,
      ...opts.open,
    ],
    ...(opts.videoDir ? {recordVideo: {dir: opts.videoDir, size: {width: 1280, height: 800}}} : {}),
    timeout: 120_000,
  });
  const win = await app.firstWindow();
  await win.waitForSelector('.monaco-workbench', {timeout: 120_000});
  // a fixed window size, so the editor, the preview beside it and the panel all have room (and screenshots compare)
  await app.evaluate(({BrowserWindow}) => { for (const w of BrowserWindow.getAllWindows()) { w.unmaximize(); w.setContentSize(1280, 800); } });
  await win.waitForFunction('window.innerWidth >= 1200', undefined, {timeout: 10_000}).catch(() => undefined);
  return {
    app,
    win,
    async close() {
      await app.close().catch(() => undefined);
      fs.rmSync(tmp, {recursive: true, force: true});
    },
  };
}

/** Runs a command by its title from the command palette (F1 works on every platform). */
export async function runCommand(win: Page, title: string): Promise<void> {
  await win.keyboard.press('Escape');
  await win.keyboard.press('F1');
  const input = win.locator('.quick-input-widget input');
  await input.waitFor({state: 'visible'});
  await input.fill(`>${title}`);
  const row = win.locator('.quick-input-widget .monaco-list-row', {hasText: title}).first();
  await row.waitFor({state: 'visible'});
  await win.keyboard.press('Enter');
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
  await win.locator('.quick-input-widget .monaco-list-row', {hasText: name}).first().waitFor({state: 'visible'});
  await win.keyboard.press('Enter');
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
