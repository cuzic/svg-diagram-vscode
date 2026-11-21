// The preview's page and the pieces of `build` it needs. No `vscode` import (unit-tested with node --test).
import {crashFinding} from './check.ts';

/** `build` into a scratch file: nothing is written into the project; --no-lint so a figure with findings still shows (check reports them). */
export function buildArgs(file: string, out: string): string[] {
  return ['build', file, '--out', out, '--no-lint'];
}

/**
 * Why a build failed, for the banner: the `✗ <source>: <message>` lines when the CLI printed them (newer core),
 * else the Error line of a crash (core 0.5.0), else the meaningful rest of stderr.
 */
export function buildErrorText(file: string, stderr: string): string {
  const lines = stderr.split(/\r?\n/).filter(s => s.trim() && !/DeprecationWarning|--trace-deprecation|^Node\.js v/.test(s));
  const failed = lines.filter(s => /^\s*✗ /.test(s)).map(s => {
    const failure = s.trim().slice(2);
    if (!failure.startsWith(`${file}:`)) return failure;
    // The title already names the source.
    const detail = failure.slice(file.length + 1);
    const sameFile = detail.match(/^(\d+):\d+: (.*)$/);
    if (sameFile) return `${sameFile[2]}（${sameFile[1]} 行目）`;
    return detail.startsWith(' ') ? detail.slice(1) : failure;
  });
  if (failed.length) return failed.join('\n');
  const crash = crashFinding(file, lines.join('\n'));
  if (crash.message !== 'check が JSON を出さずに失敗した') return crash.line ? `${crash.message}（${crash.line} 行目）` : crash.message;
  return lines.join('\n').trim() || 'build が失敗した（出力なし）';
}

/** The SVG as it goes into the page: no XML prolog / doctype (inline SVG in HTML). */
export function inlineSvg(svg: string): string {
  return svg.replace(/^﻿?\s*<\?xml[^>]*\?>\s*/, '').replace(/^\s*<!DOCTYPE[^>]*>\s*/i, '');
}

/** Messages from the extension to the page. */
export type ToPage =
  | {kind: 'building'; title: string; file: string}
  | {kind: 'svg'; title: string; file: string; svg: string; builtAt: string}
  | {kind: 'error'; title: string; file: string; message: string};

/**
 * The page, set once per panel; contents arrive by postMessage so zoom and scroll survive a rebuild.
 * CSP: no network, scripts only with the nonce (a <script> inside the SVG never runs), inline styles allowed (the SVG's <style>).
 */
export function previewShellHtml(opts: {cspSource: string; nonce: string}): string {
  const {cspSource, nonce} = opts;
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; font-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .bar { position: sticky; top: 0; z-index: 1; display: flex; gap: 6px; align-items: center; padding: 4px 8px; background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-editorWidget-border, transparent); }
  .bar .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar .state { opacity: .8; white-space: nowrap; }
  .bar .state.stale { color: var(--vscode-editorWarning-foreground); opacity: 1; }
  .bar button { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: none; padding: 2px 8px; cursor: pointer; border-radius: 2px; }
  .bar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .bar button[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .error { display: none; margin: 8px; padding: 8px 10px; white-space: pre-wrap; color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
  .error.shown { display: block; }
  .stage { padding: 12px; }
  .stage.bg-light { background: #fff; }
  .stage.bg-dark { background: #1e1e1e; }
  .stage.bg-checker { background: repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0 / 16px 16px; }
  .stage svg { display: block; max-width: none; }
  .stage.fit svg { width: 100% !important; height: auto !important; }
  .stage:not(:has(svg)) { background: none; padding: 0; }
  .empty { padding: 16px; opacity: .7; }
</style>
</head>
<body>
<div class="bar" role="toolbar" aria-label="プレビューの表示">
  <span class="title" id="title">svg-diagram</span>
  <span class="state" id="state"></span>
  <button id="fit" aria-pressed="true" title="幅に合わせる">幅</button>
  <button id="zoomOut" title="縮小">−</button>
  <button id="actual" title="原寸">100%</button>
  <button id="zoomIn" title="拡大">＋</button>
  <button id="bg" title="背景（白 / 暗 / 格子）">背景: 白</button>
</div>
<div class="error" id="error" role="alert"></div>
<div class="stage fit bg-light" id="stage"><div class="empty">図のソースを保存すると、ここに描く。</div></div>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const stage = $('stage'), state = $('state'), error = $('error');
  const BGS = [['light', '白'], ['dark', '暗'], ['checker', '格子']];
  let view = Object.assign({fit: true, zoom: 1, bg: 0}, vscode.getState()?.view);
  let natural = null; // the SVG's own width/height (px)
  let shownFile = null; // the source of the SVG on the stage

  function applyView() {
    stage.classList.toggle('fit', view.fit);
    $('fit').setAttribute('aria-pressed', String(view.fit));
    stage.className = stage.className.replace(/\\bbg-\\w+/, 'bg-' + BGS[view.bg][0]);
    $('bg').textContent = '背景: ' + BGS[view.bg][1];
    const svg = stage.querySelector('svg');
    if (svg && natural && !view.fit) { svg.style.width = natural.w * view.zoom + 'px'; svg.style.height = natural.h * view.zoom + 'px'; }
    $('actual').textContent = view.fit ? '100%' : Math.round(view.zoom * 100) + '%';
    vscode.setState({...vscode.getState(), view});
  }
  const zoomBy = f => { view = {...view, fit: false, zoom: Math.min(8, Math.max(0.1, view.zoom * f))}; applyView(); };
  $('fit').onclick = () => { view = {...view, fit: !view.fit}; applyView(); };
  $('actual').onclick = () => { view = {...view, fit: false, zoom: 1}; applyView(); };
  $('zoomIn').onclick = () => zoomBy(1.25);
  $('zoomOut').onclick = () => zoomBy(0.8);
  $('bg').onclick = () => { view = {...view, bg: (view.bg + 1) % BGS.length}; applyView(); };

  function show(msg) {
    $('title').textContent = msg.title;
    // the drawing on the stage is of another source: never show it under this one's title
    if (msg.kind !== 'svg' && shownFile !== msg.file) { stage.innerHTML = ''; natural = null; shownFile = null; }
    // the banner is about the file it was sent for: switching to another file takes it down
    if (msg.kind === 'building' && error.dataset.file !== msg.file) error.classList.remove('shown');
    if (msg.kind === 'building') { state.textContent = '描いている…'; state.classList.remove('stale'); return; }
    if (msg.kind === 'error') {
      error.textContent = msg.message; error.dataset.file = msg.file; error.classList.add('shown');
      const has = !!stage.querySelector('svg');
      state.textContent = has ? '古い図（今のソースは描けない）' : '描けない'; state.classList.add('stale');
      return;
    }
    error.classList.remove('shown');
    stage.innerHTML = msg.svg; // scripts inserted by innerHTML never run; the CSP blocks the rest
    shownFile = msg.file;
    const svg = stage.querySelector('svg');
    const vb = svg?.viewBox?.baseVal;
    natural = svg ? {w: parseFloat(svg.getAttribute('width')) || vb?.width || 800, h: parseFloat(svg.getAttribute('height')) || vb?.height || 600} : null;
    state.textContent = msg.builtAt + ' に描いた'; state.classList.remove('stale');
    applyView();
  }
  window.addEventListener('message', e => { show(e.data); vscode.setState({...vscode.getState(), last: e.data, view}); });
  const last = vscode.getState()?.last;
  if (last) show(last);
  applyView();
  vscode.postMessage({kind: 'ready'});
})();
</script>
</body>
</html>`;
}
