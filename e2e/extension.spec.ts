// End-to-end: the extension in a real VS Code window, clicked through like a user would.
// Each step leaves a screenshot in the report (CI uploads it with the video).
import path from 'node:path';
import {expect, type Page, test, type TestInfo} from '@playwright/test';
import {activeTab, FIXTURE, launch, openFile, previewFrame, runCommand, type VsCode} from './vscode.ts';

test.describe.configure({mode: 'serial'});

let vscode: VsCode;
let win: Page;

test.beforeAll(async ({}, info) => {
  vscode = await launch({open: [FIXTURE, path.join(FIXTURE, 'untitled.diagram.ts')], videoDir: info.outputPath('video')});
  win = vscode.win;
});

test.afterAll(async () => {
  await vscode?.close();
});

/** A screenshot in the test's output folder (CI uploads test-results/) and in the HTML report. */
async function shot(info: TestInfo, name: string): Promise<void> {
  const file = info.outputPath(`${name}.png`);
  await win.screenshot({path: file});
  await info.attach(name, {path: file, contentType: 'image/png'});
}

const statusItem = () => win.locator('.statusbar-item', {hasText: /svg-diagram/});

test('the status bar shows the CLI version for a diagram source', async ({}, info) => {
  await expect(activeTab(win, 'untitled.diagram.ts')).toBeVisible();
  await expect(statusItem()).toContainText('svg-diagram 0.5.0', {timeout: 60_000});
  await shot(info, '1-status-bar');
});

test('the check finding is in the Problems panel', async ({}, info) => {
  await runCommand(win, 'View: Focus Problems (Errors, Warnings, Infos)');
  const problems = win.locator('.markers-panel');
  await expect(problems).toContainText('a11y-no-title', {timeout: 60_000});
  await expect(problems).toContainText('svg-diagram');
  await shot(info, '2-problems');
});

test('the editor title has the preview button', async () => {
  await expect(win.locator('.editor-actions [aria-label*="プレビューを横に開く"]').first()).toBeVisible();
});

test('the preview draws the SVG', async ({}, info) => {
  await runCommand(win, 'svg-diagram: プレビューを横に開く');
  const page = previewFrame(win);
  await expect(page.locator('#stage svg')).toBeVisible({timeout: 60_000});
  await expect(page.locator('#state')).toContainText('に描いた');
  await expect(page.locator('#title')).toHaveText('untitled.diagram.ts');
  const box = await page.locator('#stage svg').boundingBox();
  expect(box && box.width > 100 && box.height > 10).toBeTruthy();
  await shot(info, '3-preview');
});

test('zoom and background buttons work', async ({}, info) => {
  const page = previewFrame(win);
  const width = async () => (await page.locator('#stage svg').boundingBox())?.width ?? 0;
  await page.locator('#actual').click();
  await expect(page.locator('#actual')).toHaveText('100%');
  const at100 = await width();
  await page.locator('#zoomIn').click();
  await expect(page.locator('#actual')).toHaveText('125%');
  expect(await width()).toBeGreaterThan(at100 * 1.2);
  await page.locator('#bg').click();
  await expect(page.locator('#bg')).toHaveText('背景: 暗');
  await expect(page.locator('#stage')).toHaveClass(/bg-dark/);
  await shot(info, '4-zoom-dark');
  await page.locator('#fit').click();
  await page.locator('#bg').click();
  await page.locator('#bg').click();
});

test('a source that throws: the preview says why, the Problems panel has the build-error', async ({}, info) => {
  await openFile(win, 'broken.diagram.ts');
  const page = previewFrame(win);
  await expect(page.locator('#title')).toHaveText('broken.diagram.ts', {timeout: 60_000});
  await expect(page.locator('#error')).toContainText('わざと壊した図', {timeout: 60_000});
  await expect(page.locator('#stage svg')).toHaveCount(0); // not the other file's drawing
  await expect(page.locator('#error')).not.toContainText('/broken.diagram.ts:'); // the title names the file already
  await runCommand(win, 'View: Focus Problems (Errors, Warnings, Infos)');
  await expect(win.locator('.markers-panel')).toContainText('build-error', {timeout: 60_000});
  await shot(info, '5-broken');
});

test('back to a source that builds: the other file\'s error banner goes', async ({}, info) => {
  await openFile(win, 'untitled.diagram.ts');
  const page = previewFrame(win);
  await expect(page.locator('#stage svg')).toBeVisible({timeout: 60_000});
  await expect(page.locator('#error')).toBeHidden();
  await shot(info, '6-back');
});

test('the status bar item opens the menu', async ({}, info) => {
  await statusItem().click();
  const menu = win.locator('.quick-input-widget');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('プレビューを横に開く');
  await expect(menu).toContainText('型検査（typecheck）');
  await shot(info, '7-menu');
  await win.keyboard.press('Escape');
});

test('a module of shared parts gets no status bar item and no findings', async ({}, info) => {
  await openFile(win, 'parts.ts');
  await expect(statusItem()).toBeHidden();
  await shot(info, '8-parts');
});
