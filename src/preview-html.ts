// The preview's page and the pieces of `build` it needs. No `vscode` import (unit-tested with node --test).
import path from 'node:path';
import {crashFinding} from './check.ts';
import {hitTest, type PreviewMap} from './preview-locations.ts';

/** `build` into a scratch file: nothing is written into the project; --no-lint so a figure with findings still shows (check reports them). */
export function buildArgs(file: string, out: string, locations?: string): string[] {
  return ['build', file, '--out', out, '--no-lint', ...(locations ? ['--locations', locations] : [])];
}

const layoutFailure = 'layout verification failed before any SVG was written:';

/**
 * Why a build failed, for the banner: the `✗` lines and their layout details when the CLI printed them,
 * else the Error line of a crash (core 0.5.0), else the meaningful rest of stderr.
 */
export function buildErrorText(file: string, stderr: string, workspaceFolder?: string): string {
  const lines = stderr.split(/\r?\n/);
  const meaningful = (s: string) => !!s.trim() && !/DeprecationWarning|--trace-deprecation|^Node\.js v/.test(s);
  const failureLine = /^\s*✗ /;
  const failed: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (!failureLine.test(line) || !meaningful(line)) continue;
    const failure = line.trim().slice(2);
    if (!failure.startsWith(`${file}:`)) {
      failed.push(failure);
      continue;
    }
    // The title already names the source.
    const rest = failure.slice(file.length + 1);
    const detail = rest.startsWith(' ') ? rest.slice(1) : failure;
    const summary = rest ? formatBuildDetail(file, detail, workspaceFolder) : '';
    if (summary) failed.push(summary);
    const firstDetail = failed.length;
    if (!rest || summary.includes(layoutFailure)) {
      for (let j = i + 1; ; j++) {
        const continuation = lines[j];
        if (!continuation || !/^[ \t]+\S/.test(continuation) || failureLine.test(continuation) || !meaningful(continuation)) break;
        failed.push(formatBuildDetail(file, continuation.trim(), workspaceFolder));
      }
    }
    if (!summary && failed.length === firstDetail) failed.push(failure);
  }
  if (failed.length) return failed.join('\n');
  const cleaned = lines.filter(meaningful).join('\n');
  const crash = crashFinding(file, cleaned);
  if (crash.message !== 'check が JSON を出さずに失敗した') return crash.line ? `${crash.message}（${crash.line} 行目）` : crash.message;
  return cleaned.trim() || 'build が失敗した（出力なし）';
}

function formatBuildDetail(file: string, detail: string, workspaceFolder?: string): string {
  const [, source, line, column, text] = detail.match(/^(.+?):(\d+):(\d+): (.*)$/) ?? [];
  const message = (text ?? detail).replace(/^build\(.*\): (?=layout verification failed\b)/, '');
  if (!source) return message;
  // The CLI runs in the source's directory; display paths inside the workspace from its root.
  const resolved = path.resolve(path.dirname(file), source);
  if (resolved === file) return `${message}（${line} 行目）`;
  const relative = workspaceFolder && path.relative(workspaceFolder, resolved);
  const inside = relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  return `${inside ? relative : resolved}:${line}:${column}: ${message}`;
}

/** The SVG as it goes into the page: no XML prolog / doctype (inline SVG in HTML). */
export function inlineSvg(svg: string): string {
  return svg.replace(/^﻿?\s*<\?xml[^>]*\?>\s*/, '').replace(/^\s*<!DOCTYPE[^>]*>\s*/i, '');
}

/** Messages from the extension to the page. */
export type ToPage =
  | {kind: 'building'; title: string; file: string}
  | {kind: 'svg'; title: string; file: string; svg: string; builtAt: string; build: string; map?: PreviewMap}
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
  .stage > svg { display: block; max-width: none; }
  .stage.fit > svg { width: 100% !important; height: auto !important; }
  .stage:not(:has(> svg)) { background: none; padding: 0; }
  .hit-outline { pointer-events: none; overflow: visible; }
  .hit-outline > * { fill: none; stroke: #007acc; stroke-width: 2; vector-effect: non-scaling-stroke; }
  .hit-tooltip { position: fixed; z-index: 2; pointer-events: none; padding: 3px 6px; border-radius: 3px; color: var(--vscode-editorHoverWidget-foreground); background: var(--vscode-editorHoverWidget-background); border: 1px solid var(--vscode-editorHoverWidget-border, transparent); }
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
<div class="hit-tooltip" id="hit-tooltip" role="tooltip" hidden></div>
<script nonce="${nonce}">
(() => {
  const hitTest = (${String(hitTest)});
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const stage = $('stage'), state = $('state'), error = $('error'), tooltip = $('hit-tooltip');
  const rootSvg = () => stage.querySelector(':scope > svg');
  const BGS = [['light', '白'], ['dark', '暗'], ['checker', '格子']];
  let view = Object.assign({fit: true, zoom: 1, bg: 0}, vscode.getState()?.view);
  let natural = null; // the SVG's own width/height (px)
  let shown = null;
  let outline = null;
  let hovered = null;
  let press = null;

  function hitAt(event) {
    if (!shown?.map) return;
    const matrix = rootSvg()?.getScreenCTM();
    const scale = matrix && Math.hypot(matrix.a, matrix.b);
    if (!scale) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return hitTest(shown.map, point, 1 / scale);
  }

  function svgElement(name, attrs) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
    return element;
  }

  function highlight(hit, event) {
    if (hovered !== hit) {
      outline?.remove();
      outline = null;
      hovered = hit;
      stage.style.cursor = hit ? 'pointer' : '';
      tooltip.hidden = !hit;
      if (hit) {
        outline = svgElement('svg', {class: 'hit-outline', width: '100%', height: '100%', 'aria-hidden': 'true'});
        if ('segments' in hit) {
          const d = hit.segments.map(([x1, y1, x2, y2]) => 'M' + x1 + ' ' + y1 + 'L' + x2 + ' ' + y2).join(' ');
          outline.append(svgElement('path', {d}));
        } else {
          const {x, y, w, h} = hit.rect;
          outline.append(svgElement('rect', {x, y, width: w, height: h}));
        }
        rootSvg().append(outline);
        tooltip.textContent = hit.label ? hit.kind + ' · ' + hit.label : hit.kind;
      }
    }
    if (hit) {
      tooltip.style.left = Math.max(0, Math.min(event.clientX + 12, window.innerWidth - tooltip.offsetWidth)) + 'px';
      tooltip.style.top = Math.max(0, Math.min(event.clientY + 12, window.innerHeight - tooltip.offsetHeight)) + 'px';
    }
  }

  stage.addEventListener('pointermove', event => highlight(hitAt(event), event));
  stage.addEventListener('pointerleave', () => highlight());
  window.addEventListener('pointerdown', event => {
    press = event.isPrimary && event.button === 0 && shown?.map && stage.contains(event.target)
      ? {pointerId: event.pointerId, x: event.clientX, y: event.clientY, dragged: false} : null;
  });
  function trackDrag(event) {
    if (press?.pointerId === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) >= 4) press.dragged = true;
  }
  window.addEventListener('pointermove', trackDrag);
  window.addEventListener('pointerup', trackDrag);
  window.addEventListener('pointercancel', () => { press = null; });
  window.addEventListener('blur', () => { press = null; highlight(); });
  stage.addEventListener('click', event => {
    const clicked = press;
    press = null;
    if (!clicked || clicked.dragged) return;
    const hit = hitAt(event);
    if (hit) vscode.postMessage({kind: 'reveal', build: shown.build, id: hit.id});
  });

  function applyView() {
    highlight();
    stage.classList.toggle('fit', view.fit);
    $('fit').setAttribute('aria-pressed', String(view.fit));
    stage.className = stage.className.replace(/\\bbg-\\w+/, 'bg-' + BGS[view.bg][0]);
    $('bg').textContent = '背景: ' + BGS[view.bg][1];
    const svg = rootSvg();
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
    if (msg.kind !== 'svg' && shown?.file !== msg.file) {
      highlight();
      stage.innerHTML = '';
      natural = shown = press = null;
    }
    // the banner is about the file it was sent for: switching to another file takes it down
    if (msg.kind === 'building' && error.dataset.file !== msg.file) error.classList.remove('shown');
    if (msg.kind === 'building') { state.textContent = '描いている…'; state.classList.remove('stale'); return; }
    if (msg.kind === 'error') {
      error.textContent = msg.message; error.dataset.file = msg.file; error.classList.add('shown');
      const has = !!rootSvg();
      state.textContent = has ? '古い図（今のソースは描けない）' : '描けない'; state.classList.add('stale');
      return;
    }
    error.classList.remove('shown');
    highlight();
    stage.innerHTML = msg.svg; // scripts inserted by innerHTML never run; the CSP blocks the rest
    shown = msg;
    press = null;
    const svg = rootSvg();
    const vb = svg?.viewBox?.baseVal;
    natural = svg ? {w: parseFloat(svg.getAttribute('width')) || vb?.width || 800, h: parseFloat(svg.getAttribute('height')) || vb?.height || 600} : null;
    state.textContent = msg.builtAt + ' に描いた'; state.classList.remove('stale');
    applyView();
  }
  window.addEventListener('message', e => {
    show(e.data);
    vscode.setState({...vscode.getState(), last: e.data, drawing: e.data.kind === 'svg' ? undefined : shown, view});
  });
  const {last, drawing} = vscode.getState() ?? {};
  if (drawing && drawing.file === last?.file) show(drawing);
  if (last) show(last);
  applyView();
  vscode.postMessage({kind: 'ready'});
})();
</script>
</body>
</html>`;
}
