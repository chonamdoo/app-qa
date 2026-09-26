// Geometry, hit-testing and un-occluded tap-point selection.
import type { Point, RawNode, Rect } from '../core/types.ts';

/**
 * Occluder candidates: only nodes that intercept touches. Plain containers/backgrounds never hide anything.
 * Desktop DOM nodes (`web:*`): only click targets, editable/checkable controls and the extract's hit-tested occluders
 * (flagged clickable) count. Focusable (tabindex) wrappers and scroll containers are not covering layers, and DOM order
 * alone does not prove paint order.
 */
export function isTouchable(n: RawNode): boolean {
  const f = n.flags;
  if (n.className.startsWith('web:')) return f.clickable || f.editable || f.checkable;
  return f.clickable || f.longClickable || f.focusable || f.scrollable;
}

const SCROLL_CLASS = /ScrollView|RecyclerView|ListView|GridView|ViewPager|^Table$|^CollectionView$|^WebView$|^web:scroll$/;

/** Containers that clip their children to their own bounds (scroll viewports). */
export function isScrollContainer(n: RawNode): boolean {
  return n.flags.scrollable || SCROLL_CLASS.test(n.className);
}

export function containsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

/** Intersection, or null when it has no area. */
export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return r > x && bottom > y ? { x, y, width: r - x, height: bottom - y } : null;
}

export function iou(a: Rect, b: Rect): number {
  const i = intersect(a, b);
  if (!i) return 0;
  const inter = i.width * i.height;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

/** True when the point is inside every scroll-viewport ancestor of `n` (content scrolled out of view is not hit). */
function insideScrollAncestors(n: RawNode, p: Point, byId: ReadonlyMap<string, RawNode>): boolean {
  for (let a = n.parentId ? byId.get(n.parentId) : undefined; a; a = a.parentId ? byId.get(a.parentId) : undefined) {
    if (isScrollContainer(a) && !containsPoint(a.rect, p)) return false;
  }
  return true;
}

/**
 * Topmost touch-intercepting node at `p`: highest z among touchable nodes (clickable | longClickable | focusable |
 * scrollable) whose rect — clipped by scroll-viewport ancestors — contains `p`. Null when nothing touchable is there.
 */
export function topmostAt(nodes: readonly RawNode[], p: Point): RawNode | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let best: RawNode | null = null;
  for (const n of nodes) {
    if ((best && n.z <= best.z) || !isTouchable(n) || !containsPoint(n.rect, p)) continue;
    if (insideScrollAncestors(n, p, byId)) best = n;
  }
  return best;
}

/**
 * Freshness hit-test: a tap at `p` reaches `target` unless a touchable node drawn above it (and not inside it) covers
 * `p`. Touchables below the target (e.g. the button behind a label) and the target's own descendants do not count.
 */
export function isUnoccludedAt(nodes: readonly RawNode[], target: RawNode, p: Point): boolean {
  const top = topmostAt(nodes, p);
  if (!top || top.z <= target.z) return true;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (let a = top.parentId ? byId.get(top.parentId) : undefined; a; a = a.parentId ? byId.get(a.parentId) : undefined) {
    if (a.id === target.id) return true;
  }
  return false;
}

const MAX_CELLS = 15;
const CELL = 8;

/** Odd sample count per axis (so the exact centre is a sample), ~one sample per 8 units, at most 15. */
function cellCount(len: number): number {
  const n = Math.min(MAX_CELLS, Math.max(1, Math.ceil(len / CELL)));
  return n % 2 === 0 ? n + 1 : n;
}

export interface VisibleRegion {
  tapPoint: Point;
  /** Share of grid samples not covered by occluders (0 < fraction ≤ 1). */
  fraction: number;
}

/**
 * Grid-samples `rect`. A sample is visible when no occluder contains it; null when no sample is visible.
 * The tap point is the most interior sample (Chebyshev distance to hidden samples / the rect edge) of the largest
 * 4-connected visible component, ties broken by closeness to the rect centre — so an un-occluded rect taps its centre.
 * Samples covered by `avoid` rects (touchable descendants that would take the tap) are skipped when any other
 * visible sample exists; they still count as visible.
 */
export function visibleRegion(rect: Rect, occluders: readonly Rect[], avoid: readonly Rect[]): VisibleRegion | null {
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  if (occluders.length === 0 && avoid.length === 0) return { tapPoint: { x: Math.round(center.x), y: Math.round(center.y) }, fraction: 1 };
  for (const o of occluders) {
    if (o.x <= rect.x && o.y <= rect.y && o.x + o.width >= rect.x + rect.width && o.y + o.height >= rect.y + rect.height) return null;
  }
  const nx = cellCount(rect.width);
  const ny = cellCount(rect.height);
  const cw = rect.width / nx;
  const ch = rect.height / ny;
  const total = nx * ny;
  // 0 = hidden, 1 = visible but covered by `avoid`, 2 = visible and free.
  const state = new Uint8Array(total);
  let visible = 0;
  let free = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const p = { x: rect.x + (i + 0.5) * cw, y: rect.y + (j + 0.5) * ch };
      if (occluders.some((o) => containsPoint(o, p))) continue;
      visible++;
      if (avoid.some((a) => containsPoint(a, p))) state[j * nx + i] = 1;
      else {
        state[j * nx + i] = 2;
        free++;
      }
    }
  }
  if (visible === 0) return null;
  const level = free > 0 ? 2 : 1;

  // Largest 4-connected component among eligible samples.
  const comp = new Int32Array(total).fill(-1);
  let bestComp = -1;
  let bestSize = 0;
  const queue = new Int32Array(total);
  for (let k = 0, id = 0; k < total; k++) {
    if (state[k]! < level || comp[k] !== -1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = k;
    comp[k] = id;
    while (head < tail) {
      const c = queue[head++]!;
      const ci = c % nx;
      const cj = (c - ci) / nx;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const nk = nj * nx + ni;
        if (state[nk]! >= level && comp[nk] === -1) {
          comp[nk] = id;
          queue[tail++] = nk;
        }
      }
    }
    if (tail > bestSize) {
      bestSize = tail;
      bestComp = id;
    }
    id++;
  }

  // Chebyshev distance transform inside the chosen component (two-pass chamfer).
  const dist = new Int32Array(total);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      dist[k] = comp[k] === bestComp ? Math.min(i + 1, nx - i, j + 1, ny - j) : 0;
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!dist[k]) continue;
      if (i > 0) dist[k] = Math.min(dist[k]!, dist[k - 1]! + 1);
      if (j > 0) {
        dist[k] = Math.min(dist[k]!, dist[k - nx]! + 1);
        if (i > 0) dist[k] = Math.min(dist[k]!, dist[k - nx - 1]! + 1);
        if (i < nx - 1) dist[k] = Math.min(dist[k]!, dist[k - nx + 1]! + 1);
      }
    }
  }
  for (let j = ny - 1; j >= 0; j--) {
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      if (!dist[k]) continue;
      if (i < nx - 1) dist[k] = Math.min(dist[k]!, dist[k + 1]! + 1);
      if (j < ny - 1) {
        dist[k] = Math.min(dist[k]!, dist[k + nx]! + 1);
        if (i < nx - 1) dist[k] = Math.min(dist[k]!, dist[k + nx + 1]! + 1);
        if (i > 0) dist[k] = Math.min(dist[k]!, dist[k + nx - 1]! + 1);
      }
    }
  }

  let pick = { x: center.x, y: center.y };
  let pickDist = -1;
  let pickOff = Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const d = dist[j * nx + i]!;
      if (d === 0 || d < pickDist) continue;
      const p = { x: rect.x + (i + 0.5) * cw, y: rect.y + (j + 0.5) * ch };
      const off = (p.x - center.x) ** 2 + (p.y - center.y) ** 2;
      if (d > pickDist || off < pickOff) {
        pick = p;
        pickDist = d;
        pickOff = off;
      }
    }
  }
  return { tapPoint: { x: Math.round(pick.x), y: Math.round(pick.y) }, fraction: visible / total };
}
