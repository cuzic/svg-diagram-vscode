// The location map crosses two boundaries: core's JSON enters here, and only hit geometry goes to the page.
import path from 'node:path';
import type {ToPage} from './preview-html.ts';

interface Point { x: number; y: number }
interface Rect extends Point { w: number; h: number }
type Segment = [number, number, number, number];
interface PartHit { id: number; kind: string; label?: string; rect: Rect }
interface ConnectHit { id: number; kind: 'connect'; segments: Segment[] }
export interface PreviewMap { parts: PartHit[]; connects: ConnectHit[] }

interface Position { line: number; column: number }
interface Location extends Position { file: string }
interface Target { loc: Location; via?: Position[] }
interface Locations { map: PreviewMap; targets: Target[] }
export interface RevealTable {
  file: string;
  build: string;
  sourceVersion?: number;
  targets: Target[];
}

type CoreEntry = Partial<Target> & {
  final?: boolean;
  generated?: boolean;
  kind?: string;
  label?: string;
  rect?: Rect;
  segments?: Segment[];
};

function position(p: Position | undefined): p is Position {
  return !!p && Number.isSafeInteger(p.line) && p.line > 0 && Number.isSafeInteger(p.column) && p.column > 0;
}

function target(entry: CoreEntry, dir: string): Target | undefined {
  const {loc, via} = entry;
  if (!position(loc) || typeof loc.file !== 'string' || !loc.file || loc.file.includes('\0')) return undefined;
  if (via !== undefined && (!Array.isArray(via) || !via.every(position))) return undefined;
  return {loc: {file: path.resolve(dir, loc.file), line: loc.line, column: loc.column}, ...(via && {via})};
}

/** The core writes a zero-origin viewBox and matching numeric width/height on the outer SVG. */
function svgMatches(svg: string, width: number, height: number): boolean {
  const root = svg.match(/^\s*<svg(?=[\s>])((?:[^'"<>]|"[^"]*"|'[^']*')*)>/)?.[1];
  if (!root) return false;
  const attrs = new Map(Array.from(root.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs), ([, k, , v]) => [k, v]));
  const viewBox = attrs.get('viewBox')?.trim().split(/[\s,]+/).map(Number);
  return Number(attrs.get('width')) === width && Number(attrs.get('height')) === height &&
    viewBox?.length === 4 && viewBox[0] === 0 && viewBox[1] === 0 && viewBox[2] === width && viewBox[3] === height;
}

export function readPreviewLocations(json: string, mapFile: string, svg: string): Locations | undefined {
  let raw: {version: number; width: number; height: number; parts: CoreEntry[]; connects: CoreEntry[]} | undefined;
  try { raw = JSON.parse(json); } catch { return undefined; }
  if (raw?.version !== 1 || !Number.isFinite(raw.width) || !Number.isFinite(raw.height) || raw.width <= 0 || raw.height <= 0 ||
    !svgMatches(svg, raw.width, raw.height) || !Array.isArray(raw.parts) || !Array.isArray(raw.connects)) return undefined;

  const map: PreviewMap = {parts: [], connects: []};
  const targets: Target[] = [];
  const dir = path.dirname(mapFile);
  for (const part of raw.parts) {
    if (!part) return undefined;
    if (part.final === false) continue;
    const at = target(part, dir);
    const {rect, kind, label} = part;
    if (!at || typeof kind !== 'string' || !rect) return undefined;
    const {x, y, w, h} = rect;
    if (![x, y, w, h].every(Number.isFinite) || w < 0 || h < 0) return undefined;
    const publicLabel = part.generated !== true && typeof label === 'string' && label && label !== '(band)';
    map.parts.push({id: targets.length, kind, ...(publicLabel && {label}), rect: {x, y, w, h}});
    targets.push(at);
  }
  for (const connect of raw.connects) {
    if (!connect) return undefined;
    if (connect.final === false) continue;
    const at = target(connect, dir);
    const {segments} = connect;
    if (!at || !Array.isArray(segments) || !segments.every(s => Array.isArray(s) && s.length === 4 && s.every(Number.isFinite))) return undefined;
    map.connects.push({id: targets.length, kind: 'connect', segments});
    targets.push(at);
  }
  return {map, targets};
}

export function tableAfterMessage(current: RevealTable | undefined, message: ToPage, locations?: Locations, sourceVersion?: number): RevealTable | undefined {
  if (message.kind === 'svg') return locations && {file: message.file, build: message.build, sourceVersion, targets: locations.targets};
  return current?.file === message.file ? current : undefined;
}

export function revealTarget(table: RevealTable | undefined, message: unknown): Target | undefined {
  if (!table || !message || typeof message !== 'object') return undefined;
  const {kind, build, id} = message as {kind?: unknown; build?: unknown; id?: unknown};
  if (kind !== 'reveal' || build !== table.build || typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= table.targets.length) return undefined;
  return table.targets[id];
}

/** Keep this self-contained: the webview calls the serialized function in its own scope. */
export function hitTest(map: PreviewMap, {x, y}: Point, pxToSvg: number): PartHit | ConnectHit | undefined {
  let nearest: ConnectHit | undefined;
  let distance = 5 * pxToSvg;
  for (const connect of map.connects) {
    for (const [x1, y1, x2, y2] of connect.segments) {
      const dx = x2 - x1, dy = y2 - y1;
      const lengthSquared = dx * dx + dy * dy;
      const along = lengthSquared ? Math.min(1, Math.max(0, ((x - x1) * dx + (y - y1) * dy) / lengthSquared)) : 0;
      const d = Math.hypot(x - (x1 + along * dx), y - (y1 + along * dy));
      if (d <= distance) {
        distance = d;
        nearest = connect;
      }
    }
  }
  if (nearest) return nearest;

  let smallest: PartHit | undefined;
  let area = Infinity;
  for (const part of map.parts) {
    const {x: left, y: top, w, h} = part.rect;
    if (x >= left && x <= left + w && y >= top && y <= top + h && w * h <= area) {
      area = w * h;
      smallest = part;
    }
  }
  return smallest;
}
