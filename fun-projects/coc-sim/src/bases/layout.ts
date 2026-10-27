// War-base layout format. Coordinates are build-grid tiles (0..43), top-left corner of
// each building's footprint. This is what the editor exports and the optimizer mutates.
import { DATA } from '../engine/data.ts';
import { MAP } from '../engine/mechanics.ts';

export interface Placed { type: string; x: number; y: number }

export interface Layout {
  name: string;
  description?: string;
  buildings: Placed[];
  walls: [number, number][];
  traps: Placed[];
  /** Defending hero positions (Hero Banner). Only `heroSlots` of them defend at TH8 by default. */
  heroes: Placed[];
  /** Defensive Clan Castle troops, e.g. { dragon: 1, wizard: 1, archer: 1 }. */
  cc: Record<string, number>;
  /** Air Sweeper facing in radians (0 = +x / east). */
  sweeperFacing?: number;
}

export function sizeOf(type: string): [number, number] {
  if (type === 'wall') return [1, 1];
  const b = DATA.buildings[type];
  if (b) return b.size;
  const t = DATA.traps[type];
  if (t) return t.size;
  if (type === 'barbarian-king' || type === 'archer-queen') return [1, 1];
  throw new Error(`unknown type ${type}`);
}

export interface ValidationIssue { level: 'error' | 'warn'; msg: string }

/** Checks a layout against TH8 rules: counts, bounds, overlaps, CC capacity. */
export function validateLayout(l: Layout): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const n = MAP.buildSize;
  const occ = new Map<number, string>();
  const claim = (type: string, x: number, y: number, w: number, h: number) => {
    if (x < 0 || y < 0 || x + w > n || y + h > n) out.push({ level: 'error', msg: `${type} at ${x},${y} out of bounds` });
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
      const k = j * n + i;
      const prev = occ.get(k);
      if (prev) out.push({ level: 'error', msg: `${type} at ${x},${y} overlaps ${prev}` });
      occ.set(k, type);
    }
  };
  const counts: Record<string, number> = {};
  for (const b of l.buildings) {
    const [w, h] = sizeOf(b.type);
    claim(b.type, b.x, b.y, w, h);
    counts[b.type] = (counts[b.type] ?? 0) + 1;
  }
  for (const [x, y] of l.walls) claim('wall', x, y, 1, 1);
  for (const t of l.traps) {
    const [w, h] = sizeOf(t.type);
    claim(t.type, t.x, t.y, w, h);
    counts[t.type] = (counts[t.type] ?? 0) + 1;
  }
  for (const [id, def] of Object.entries(DATA.buildings)) {
    const c = counts[id] ?? 0;
    if (c > def.count) out.push({ level: 'error', msg: `${id}: ${c} placed, max ${def.count}` });
    else if (c < def.count) out.push({ level: 'warn', msg: `${id}: ${c} placed of ${def.count}` });
  }
  for (const [id, def] of Object.entries(DATA.traps)) {
    const c = counts[id] ?? 0;
    if (c > def.count) out.push({ level: 'error', msg: `${id}: ${c} placed, max ${def.count}` });
  }
  if (l.walls.length > DATA.wall.count) out.push({ level: 'error', msg: `walls: ${l.walls.length} > ${DATA.wall.count}` });
  for (const k of Object.keys(counts)) {
    if (!DATA.buildings[k] && !DATA.traps[k]) out.push({ level: 'error', msg: `unknown building ${k}` });
  }
  let cc = 0;
  for (const [t, c] of Object.entries(l.cc)) {
    const d = DATA.ccTroops[t];
    if (!d) out.push({ level: 'error', msg: `unknown CC troop ${t}` });
    else cc += d.housing * c;
  }
  if (cc > DATA.capacities.ccTroops) out.push({ level: 'error', msg: `CC troops ${cc} > ${DATA.capacities.ccTroops}` });
  return out;
}

export function cloneLayout(l: Layout): Layout {
  return JSON.parse(JSON.stringify(l));
}
