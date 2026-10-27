// Parametric TH8 war-base generator.
//
// A base = wall template (concentric rings + optional dividers) + a genome that puts
// every building/trap into a ring zone at an angle. Decoding packs buildings greedily
// at the nearest legal spot. The genome is what the base optimizer evolves, so
// "where do Air Defenses go, how far apart, what sits in the core" are all searchable.
import { DATA } from '../engine/data.ts';
import { Rng } from '../engine/rng.ts';
import type { Layout, Placed } from './layout.ts';

const S = 44;
const C = 22; // ring centre tile

export interface Template {
  id: string;
  rings: number[];                   // Chebyshev radii of wall rings (perimeter = 8r walls)
  dividers: [number, number][];      // extra wall tiles
  description: string;
}

function dividerSegments(offsets: number[], from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  for (const o of offsets) {
    for (let d = from; d <= to; d++) {
      out.push([C + o, C - d], [C + o, C + d], [C - d, C + o], [C + d, C + o]);
    }
  }
  return out;
}

export const TEMPLATES: Template[] = [
  { id: 'rings3', rings: [4, 10, 14], dividers: [], description: 'Three concentric rings (core / inner / outer), 224 walls' },
  { id: 'compartments', rings: [5, 13], dividers: dividerSegments([-7, 7], 6, 12), description: 'Core + one wide ring split into 8 compartments' },
  { id: 'tight3', rings: [3, 9, 15], dividers: [], description: 'Small core, wide middle, large outer ring' },
  { id: 'core2', rings: [6, 12], dividers: dividerSegments([0], 7, 11), description: 'Big core with two-tier ring split on the axes' },
  { id: 'grid9', rings: [4, 13], dividers: dividerSegments([-4, 4], 5, 12), description: '3x3 grid of compartments (core + 8 cells), 200 walls' },
  { id: 'compartments12', rings: [5, 13], dividers: dividerSegments([-8, 0, 8], 7, 12), description: 'Core + 12 small outer compartments' },
];

export function templateWalls(t: Template): [number, number][] {
  const set = new Set<number>();
  for (const r of t.rings) {
    for (let i = -r; i <= r; i++) {
      set.add((C - r) * S + (C + i)); set.add((C + r) * S + (C + i));
      set.add((C + i) * S + (C - r)); set.add((C + i) * S + (C + r));
    }
  }
  for (const [x, y] of t.dividers) set.add(y * S + x);
  const walls: [number, number][] = [];
  for (const k of set) {
    const x = k % S, y = (k / S) | 0;
    if (x >= 0 && y >= 0 && x < S && y < S) walls.push([x, y]);
  }
  return walls.slice(0, DATA.wall.count);
}

// ---------------------------------------------------------------- genome
export interface Gene { z: number; a: number; r: number }
export interface Genome {
  template: string;
  buildings: Gene[];   // aligned with INSTANCES
  traps: Gene[];       // aligned with TRAP_INSTANCES
  heroes: Gene[];      // AQ, BK banners
  sweeperFacing: number; // 0..1 of a turn
  cc: Record<string, number>;
}

export const INSTANCES: string[] = (() => {
  const order = ['town-hall', 'clan-castle', 'air-defense', 'wizard-tower', 'mortar', 'hidden-tesla', 'bomb-tower', 'air-sweeper',
    'archer-tower', 'cannon', 'dark-elixir-storage', 'gold-storage', 'elixir-storage', 'army-camp', 'hero-hall', 'laboratory',
    'spell-factory', 'dark-spell-factory', 'barracks', 'dark-barracks', 'blacksmith', 'dark-elixir-drill', 'gold-mine',
    'elixir-collector', 'builders-hut'];
  const out: string[] = [];
  for (const id of order) for (let i = 0; i < DATA.buildings[id].count; i++) out.push(id);
  return out;
})();

export const TRAP_INSTANCES: string[] = (() => {
  const out: string[] = [];
  for (const [id, d] of Object.entries(DATA.traps)) for (let i = 0; i < d.count; i++) out.push(id);
  return out;
})();

export const HERO_IDS = ['archer-queen', 'barbarian-king'];

function zoneBounds(t: Template, z: number): [number, number] {
  // inclusive Chebyshev distance range for zone z (0 = inside first ring)
  const r = t.rings;
  const lo = z === 0 ? 0 : r[z - 1] + 1;
  const hi = z < r.length ? r[z] - 1 : 21;
  return [lo, hi];
}

const cheb = (x: number, y: number) => Math.max(Math.abs(x - C), Math.abs(y - C));

export function decode(g: Genome, name = 'generated'): Layout {
  const t = TEMPLATES.find((x) => x.id === g.template) ?? TEMPLATES[0];
  const nz = t.rings.length + 1;
  const occ = new Uint8Array(S * S);
  const walls = templateWalls(t);
  for (const [x, y] of walls) occ[y * S + x] = 1;

  const fits = (x: number, y: number, w: number, h: number, lo: number, hi: number) => {
    if (x < 0 || y < 0 || x + w > S || y + h > S) return false;
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
      if (occ[j * S + i]) return false;
      const d = cheb(i, j);
      if (d < lo || d > hi) return false;
    }
    return true;
  };

  const place = (type: string, gene: Gene, size: [number, number]): Placed | null => {
    const [w, h] = size;
    const z0 = Math.max(0, Math.min(nz - 1, Math.round(gene.z)));
    for (let attempt = 0; attempt < nz * 2; attempt++) {
      const z = attempt === 0 ? z0 : (z0 + Math.ceil(attempt / 2) * (attempt % 2 ? 1 : -1) + nz * 4) % nz;
      const [lo, hi] = zoneBounds(t, z);
      if (hi - lo + 1 < Math.min(w, h)) continue;
      const rad = lo + (hi - lo) * Math.max(0, Math.min(1, gene.r));
      const ang = gene.a * Math.PI * 2;
      const tx = C + Math.cos(ang) * rad, ty = C + Math.sin(ang) * rad;
      let best: Placed | null = null, bd = Infinity;
      for (let y = 0; y + h <= S; y++) for (let x = 0; x + w <= S; x++) {
        const d = Math.hypot(x + w / 2 - tx, y + h / 2 - ty);
        if (d >= bd) continue;
        if (!fits(x, y, w, h, lo, hi)) continue;
        bd = d; best = { type, x, y };
      }
      if (best) {
        for (let j = best.y; j < best.y + h; j++) for (let i = best.x; i < best.x + w; i++) occ[j * S + i] = 1;
        return best;
      }
    }
    return null;
  };

  const buildings: Placed[] = [];
  INSTANCES.forEach((type, i) => {
    const p = place(type, g.buildings[i], DATA.buildings[type].size);
    if (p) buildings.push(p);
  });
  const traps: Placed[] = [];
  TRAP_INSTANCES.forEach((type, i) => {
    const p = place(type, g.traps[i], DATA.traps[type].size);
    if (p) traps.push(p);
  });
  const heroes: Placed[] = [];
  HERO_IDS.forEach((type, i) => {
    const p = place(type, g.heroes[i], [1, 1]);
    if (p) heroes.push(p);
  });
  return {
    name, description: `template ${t.id}`, buildings, walls, traps, heroes, cc: { ...g.cc },
    sweeperFacing: g.sweeperFacing * Math.PI * 2,
  };
}

// ---------------------------------------------------------------- genome operators
export const DEFAULT_CC = { dragon: 1, wizard: 1, archer: 1 };

export function randomGenome(rng: Rng, template?: string): Genome {
  const t = template ?? rng.pick(TEMPLATES).id;
  const nz = (TEMPLATES.find((x) => x.id === t) ?? TEMPLATES[0]).rings.length + 1;
  const gene = (): Gene => ({ z: rng.int(0, nz - 1), a: rng.next(), r: rng.next() });
  return {
    template: t,
    buildings: INSTANCES.map(gene), traps: TRAP_INSTANCES.map(gene), heroes: HERO_IDS.map(gene),
    sweeperFacing: rng.next(), cc: { ...DEFAULT_CC },
  };
}

export function mutate(g: Genome, rng: Rng, rate = 0.08): Genome {
  const nz = (TEMPLATES.find((x) => x.id === g.template) ?? TEMPLATES[0]).rings.length + 1;
  const m = (x: Gene): Gene => {
    if (rng.next() > rate) return { ...x };
    const k = rng.next();
    if (k < 0.25) return { ...x, z: Math.max(0, Math.min(nz - 1, x.z + (rng.next() < 0.5 ? -1 : 1))) };
    if (k < 0.75) return { ...x, a: (x.a + rng.gauss(0.06) + 1) % 1 };
    return { ...x, r: Math.max(0, Math.min(1, x.r + rng.gauss(0.25))) };
  };
  const out: Genome = { ...g, buildings: g.buildings.map(m), traps: g.traps.map(m), heroes: g.heroes.map(m), cc: { ...g.cc } };
  // occasional swap of two buildings' positions (e.g. AD <-> mortar)
  if (rng.next() < 0.5) {
    const i = rng.int(0, out.buildings.length - 1), j = rng.int(0, out.buildings.length - 1);
    [out.buildings[i], out.buildings[j]] = [out.buildings[j], out.buildings[i]];
  }
  if (rng.next() < 0.1) out.sweeperFacing = (out.sweeperFacing + rng.gauss(0.1) + 1) % 1;
  return out;
}

export function crossover(a: Genome, b: Genome, rng: Rng): Genome {
  if (a.template !== b.template) return rng.next() < 0.5 ? a : b;
  const pick = (x: Gene[], y: Gene[]) => x.map((g, i) => ({ ...(rng.next() < 0.5 ? g : y[i]) }));
  return {
    template: a.template, buildings: pick(a.buildings, b.buildings), traps: pick(a.traps, b.traps), heroes: pick(a.heroes, b.heroes),
    sweeperFacing: rng.next() < 0.5 ? a.sweeperFacing : b.sweeperFacing, cc: { ...a.cc },
  };
}

// ---------------------------------------------------------------- hand-designed archetypes
// These encode the TH8 war-base principles found in 2025-2026 guides: centralised TH+CC,
// Air Defenses spread ~120° apart one ring out, Wizard Towers covering ADs, Teslas near
// the core, Giant Bombs in pairs on hog paths between defenses, SAMs/air bombs near ADs.
const g = (z: number, a: number, r = 0.5): Gene => ({ z, a: ((a % 1) + 1) % 1, r });

export function archetype(id: 'ring-core' | 'anti-air-spread' | 'compartment-cc' | 'offset-th'): Genome {
  const per = (type: string) => INSTANCES.filter((x) => x === type).length;
  const genes: Gene[] = [];
  const counters: Record<string, number> = {};
  const next = (type: string) => (counters[type] = (counters[type] ?? 0) + 1) - 1;
  const spread = (type: string, k: number, offset = 0) => (k + offset) / per(type);
  const coreish = id === 'offset-th' ? 2 : 0;
  for (const type of INSTANCES) {
    const k = next(type);
    switch (type) {
      case 'town-hall': genes.push(id === 'offset-th' ? g(2, 0.25, 0.3) : g(0, 0, 0)); break;
      case 'clan-castle': genes.push(id === 'compartment-cc' ? g(0, 0.5, 0.5) : g(coreish === 0 ? 0 : 1, 0.6, 0.3)); break;
      case 'air-defense': genes.push(id === 'anti-air-spread' ? g(1, spread(type, k), 1) : g(1, spread(type, k, 0.15), 0.4)); break;
      case 'wizard-tower': genes.push(g(1, spread(type, k, 0.5), 0.6)); break;
      case 'mortar': genes.push(g(id === 'compartment-cc' ? 1 : 2, spread(type, k, 0.1), 0.5)); break;
      case 'hidden-tesla': genes.push(g(id === 'ring-core' ? 0 : 1, spread(type, k, 0.33), 0.8)); break;
      case 'bomb-tower': genes.push(g(1, 0.45, 0.2)); break;
      case 'air-sweeper': genes.push(g(1, 0.8, 0.2)); break;
      case 'archer-tower': genes.push(g(2, spread(type, k, 0.3), 0.5)); break;
      case 'cannon': genes.push(g(2, spread(type, k, 0.0), 0.5)); break;
      case 'dark-elixir-storage': genes.push(g(1, 0.2, 0.5)); break;
      case 'gold-storage': case 'elixir-storage': genes.push(g(2, spread(type, k, type === 'gold-storage' ? 0.15 : 0.65), 0.5)); break;
      case 'builders-hut': genes.push(g(9, spread(type, k), 1)); break;
      default: genes.push(g(9, (k * 0.137 + type.length * 0.071) % 1, 0.4)); break;
    }
  }
  const nz = (TEMPLATES.find((x) => x.id === (id === 'compartment-cc' ? 'compartments' : 'rings3'))!).rings.length + 1;
  const clamp = (x: Gene) => ({ ...x, z: Math.min(nz - 1, x.z) });
  const trapGenes = TRAP_INSTANCES.map((type, i) => {
    switch (type) {
      case 'giant-bomb': return g(1, 0.1 + i * 0.29, 0.5);
      case 'spring-trap': return g(2, i * 0.17, 0.5);
      case 'bomb': return g(2, 0.05 + i * 0.16, 0.2);
      case 'seeking-air-mine': return g(1, 0.15 + i * 0.33, 0.9);
      case 'air-bomb': return g(2, 0.2 + i * 0.25, 0.9);
      default: return g(1, 0.4 + i * 0.5, 0.5);
    }
  });
  return {
    template: id === 'compartment-cc' ? 'compartments' : 'rings3',
    buildings: genes.map(clamp), traps: trapGenes.map(clamp),
    heroes: [g(1, 0.9, 0.5), g(1, 0.4, 0.5)].map(clamp),
    sweeperFacing: 0.25, cc: { ...DEFAULT_CC },
  };
}

export const ARCHETYPES = ['ring-core', 'anti-air-spread', 'compartment-cc', 'offset-th'] as const;
