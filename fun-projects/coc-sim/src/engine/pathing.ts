// Ground pathfinding: Dijkstra "distance-to-target" fields on the 1-tile grid.
//
// Model (estimate, tunable): troops pick a target by straight-line distance, then walk
// the cheapest route to any tile from which they can hit it. Building tiles are
// impassable; an intact wall tile is passable at an extra cost (wallPathCost +
// hp * wallPathCostPerHp tiles). When the next step is a wall, the troop attacks the
// wall – this is what produces "troops hitting walls" vs "troops walking around".
import { TUNABLES } from './mechanics.ts';

export interface PathGrid {
  n: number;
  blocked: Uint8Array;  // 1 = alive building footprint
  wallHp: Float32Array; // > 0 = alive wall
  version: number;      // bumped whenever passability changes
}

export interface Rect { x0: number; y0: number; x1: number; y1: number }

export function distToRect(px: number, py: number, r: Rect): number {
  const dx = px < r.x0 ? r.x0 - px : px > r.x1 ? px - r.x1 : 0;
  const dy = py < r.y0 ? r.y0 - py : py > r.y1 ? py - r.y1 : 0;
  return Math.hypot(dx, dy);
}

class Heap {
  keys: number[] = [];
  vals: number[] = [];
  push(k: number, v: number) {
    const ks = this.keys, vs = this.vals;
    let i = ks.length;
    ks.push(k); vs.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (ks[p] <= k) break;
      ks[i] = ks[p]; vs[i] = vs[p];
      i = p;
    }
    ks[i] = k; vs[i] = v;
  }
  pop(): number {
    const ks = this.keys, vs = this.vals;
    const top = vs[0];
    const k = ks.pop()!, v = vs.pop()!;
    const n = ks.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && ks[c + 1] < ks[c]) c++;
        if (ks[c] >= k) break;
        ks[i] = ks[c]; vs[i] = vs[c];
        i = c;
      }
      ks[i] = k; vs[i] = v;
    }
    return top;
  }
  get size() { return this.keys.length; }
}

const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];
export { DIRS };

export function wallCost(hp: number): number {
  return TUNABLES.wallPathCost + hp * TUNABLES.wallPathCostPerHp;
}

/** Field of path cost from every cell to the nearest cell within `reach` of `rect`. */
const sharedHeap = new Heap();

/** `limit`: stop expanding once path cost exceeds it (cells beyond stay Infinity). */
export function computeField(g: PathGrid, rect: Rect, reach: number, jump: boolean, reuse?: Float32Array, limit = Infinity): Float32Array {
  const n = g.n;
  const dist = (reuse ?? new Float32Array(n * n)).fill(Infinity);
  const heap = sharedHeap;
  heap.keys.length = 0;
  heap.vals.length = 0;
  const pad = Math.ceil(reach) + 1;
  const ix0 = Math.max(0, Math.floor(rect.x0) - pad), ix1 = Math.min(n - 1, Math.ceil(rect.x1) + pad);
  const iy0 = Math.max(0, Math.floor(rect.y0) - pad), iy1 = Math.min(n - 1, Math.ceil(rect.y1) + pad);
  for (let y = iy0; y <= iy1; y++) {
    for (let x = ix0; x <= ix1; x++) {
      const idx = y * n + x;
      if (g.blocked[idx]) continue;
      if (distToRect(x + 0.5, y + 0.5, rect) <= reach) {
        // A goal cell that is itself a wall still costs breaking it (unless jumping).
        const c = !jump && g.wallHp[idx] > 0 ? wallCost(g.wallHp[idx]) : 0;
        dist[idx] = c;
        heap.push(c, idx);
      }
    }
  }
  while (heap.size) {
    const top = heap.keys[0];
    const idx = heap.pop();
    const d = dist[idx];
    if (top > d) continue; // stale heap entry
    if (d > limit) break;
    const x = idx % n, y = (idx / n) | 0;
    // Expanding outward: moving from neighbour `m` into `idx` costs the step plus idx's wall.
    for (const [dx, dy, step] of DIRS) {
      const mx = x + dx, my = y + dy;
      if (mx < 0 || my < 0 || mx >= n || my >= n) continue;
      const m = my * n + mx;
      if (g.blocked[m]) continue;
      if (dx && dy && (g.blocked[y * n + mx] || g.blocked[my * n + x])) continue; // no corner cutting
      let c = d + step;
      if (!jump && g.wallHp[m] > 0) c += wallCost(g.wallHp[m]);
      if (c < dist[m]) {
        dist[m] = c;
        heap.push(c, m);
      }
    }
  }
  return dist;
}

/**
 * Next cell to step into from (cx, cy), following the field downhill.
 * Returns -1 when already at a goal or when no route exists.
 */
export function nextCell(g: PathGrid, field: Float32Array, cx: number, cy: number): number {
  const n = g.n;
  const here = cy * n + cx;
  let best = -1;
  let bestCost = field[here];
  if (bestCost === 0) return -1;
  for (const [dx, dy, step] of DIRS) {
    const mx = cx + dx, my = cy + dy;
    if (mx < 0 || my < 0 || mx >= n || my >= n) continue;
    const m = my * n + mx;
    if (g.blocked[m]) continue;
    if (dx && dy && (g.blocked[cy * n + mx] || g.blocked[my * n + cx])) continue;
    // The field already includes the wall cost of m; add the step to compare fairly.
    const c = field[m] + step * 0.999;
    if (c < bestCost) {
      bestCost = c;
      best = m;
    }
  }
  return best;
}
