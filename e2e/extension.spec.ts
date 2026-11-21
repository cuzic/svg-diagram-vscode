// End-to-end: the extension in a real VS Code window, clicked through like a user would.
// Each step leaves a screenshot in the report (CI uploads them with a Playwright trace).
import path from 'node:path';
import {expect, type Page, test, type TestInfo} from '@playwright/test';
import {activeTab, FIXTURE, launch, openFile, previewFrame, runCommand, type VsCode} from './vscode.ts';

test.describe.configure({mode: 'serial'});

let vscode: VsCode;
let win: Page;

test.beforeAll(async ({}, info) => {
  info.setTimeout(420_000); // downloading VS Code (~400 MB) on a cold CI cache, then its first start
  vscode = await launch({open: [FIXTURE, path.join(FIXTURE, 'untitled.diagram.ts')], traceDir: info.outputPath('trace'), debugDir: info.outputPath('launch')});
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

/** The preview page's title, state, banner and figure, read at one moment (no retrying). */
function whileDrawing(page: ReturnType<typeof previewFrame>) {
  // runs in the page; the repo's tsconfig has no DOM lib, so the document is typed here by hand
  type El = {textContent: string | null; classList: {contains(c: string): boolean}};
  return page.locator('body').evaluate(() => {
    const doc = (globalThis as unknown as {document: {getElementById(id: string): El | null; querySelector(s: string): unknown}}).document;
    return {
      title: doc.getElementById('title')?.textContent,
      state: doc.getElementById('state')?.textContent,
      banner: !!doc.getElementById('error')?.classList.contains('shown'),
      figure: !!doc.querySelector('#stage svg'),
    };
  });
}

const statusItem = () => win.locator('.statusbar-item', {hasText: /svg-diagram/});

test('the status bar shows the CLI version for a diagram source', async ({}, info) => {
  await expect(activeTab(win, 'untitled.diagram.ts')).toBeVisible();
  await expect(statusItem()).toContainText('svg-diagram 0.8.0', {timeout: 60_000});
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

test('while another file is drawing, the last file\'s error banner is down', async ({}, info) => {
  // the preview shows broken.diagram.ts's reason now; slow.diagram.ts takes 3 s to build
  await openFile(win, 'slow.diagram.ts');
  const page = previewFrame(win);
  await expect(page.locator('#state')).toHaveText('描いている…');
  // one reading of the page while it is still drawing: a retrying expect would wait until the finished figure
  // hides the banner anyway, and pass for the wrong reason
  const now = await whileDrawing(page);
  expect(now).toEqual({title: 'slow.diagram.ts', state: '描いている…', banner: false, figure: false});
  await shot(info, '6-building-after-error');
  await expect(page.locator('#stage svg')).toBeVisible({timeout: 60_000});
});

test('while another file is drawing, the last file\'s figure is not shown under its title', async ({}, info) => {
  await openFile(win, 'untitled.diagram.ts');
  const page = previewFrame(win);
  await expect(page.locator('#title')).toHaveText('untitled.diagram.ts', {timeout: 60_000});
  await expect(page.locator('#state')).toContainText('に描いた', {timeout: 60_000});
  await openFile(win, 'slow.diagram.ts');
  await expect(page.locator('#state')).toHaveText('描いている…');
  const now = await whileDrawing(page);
  expect(now).toEqual({title: 'slow.diagram.ts', state: '描いている…', banner: false, figure: false});
  await shot(info, '7-building-after-figure');
  await expect(page.locator('#stage svg')).toBeVisible({timeout: 60_000});
  await expect(page.locator('#error')).toBeHidden();
});

test('the status bar item opens the menu', async ({}, info) => {
  await openFile(win, 'untitled.diagram.ts');
  await statusItem().click();
  const menu = win.locator('.quick-input-widget');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('プレビューを横に開く');
  await expect(menu).toContainText('型検査（typecheck）');
  await shot(info, '8-menu');
  await win.keyboard.press('Escape');
});

test('a module of shared parts gets no status bar item and no findings', async ({}, info) => {
  await openFile(win, 'parts.ts');
  await expect(statusItem()).toBeHidden();
  await runCommand(win, 'View: Focus Problems (Errors, Warnings, Infos)');
  await win.waitForTimeout(3000); // a check would have answered by now (the others take about a second)
  await expect(win.locator('.markers-panel')).not.toContainText('parts.ts');
  await shot(info, '9-parts');
});
