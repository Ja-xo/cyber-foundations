// Shared plumbing for attack strategies: a timed action script plus reactive rules
// (spells and hero abilities cast when the situation calls for it — like a player
// watching the attack), and base-geometry helpers used to aim the deployment.
import { SIDE_ATT, SIDE_DEF, type Army, type Building, type Controller, type Sim, type Unit } from '../engine/sim.ts';
import { MAP, TUNABLES } from '../engine/mechanics.ts';

export interface StrategyParams {
  /** Attack direction in turns (0..1). 0 = from the east edge, 0.25 = from the south. */
  angle: number;
  /** Width multiplier for deployment lines/funnels. */
  spread: number;
  /** Scales delays between deployment waves. */
  timing: number;
  /** Hero to bring (TH8 has one hero slot). */
  hero: 'barbarian-king' | 'archer-queen';
  equipment?: string[];
  /** Human imprecision: SD of deploy position jitter in tiles and timing jitter in seconds. */
  jitter: number;
  /** Strategy-specific overrides (e.g. which AD to zap). */
  extra?: Record<string, any>;
}

export const DEFAULT_PARAMS: StrategyParams = { angle: 0, spread: 1, timing: 1, hero: 'barbarian-king', jitter: 0.6 };

export const HERO_EQUIPMENT: Record<string, string[]> = {
  'barbarian-king': ['spiky-ball', 'giant-gauntlet'],
  'archer-queen': ['invisibility-vial', 'frozen-arrow'],
};

export interface Strategy {
  id: string;
  name: string;
  description: string;
  kind: 'ground' | 'air' | 'hybrid';
  army(p: StrategyParams): Army;
  plan(s: ScriptController, sim: Sim, geo: Geometry, p: StrategyParams): void;
}

type Action = { t: number; fn: (sim: Sim) => void };
type Rule = (sim: Sim) => boolean | void; // return true to retire the rule

export class ScriptController implements Controller {
  private actions: Action[] = [];
  private rules: Rule[] = [];
  private started = false;
  strategy: Strategy;
  params: StrategyParams;
  geo!: Geometry;

  constructor(strategy: Strategy, params: StrategyParams) {
    this.strategy = strategy;
    this.params = params;
  }

  at(t: number, fn: (sim: Sim) => void) {
    this.actions.push({ t, fn });
    this.actions.sort((a, b) => a.t - b.t);
  }

  rule(r: Rule) { this.rules.push(r); }

  onTick(sim: Sim) {
    if (!this.started) {
      this.started = true;
      this.geo = new Geometry(sim);
      this.strategy.plan(this, sim, this.geo, this.params);
      // Anything the plan did not deploy (e.g. from army swaps) goes in behind the main push.
      const last = this.actions.reduce((m, a) => Math.max(m, a.t), 0);
      const p = this.params, geo = this.geo;
      this.at(Math.min(last, 40) + 2, (sm) => {
        const pts = geo.line(p.angle, 5, 8 * p.spread);
        let i = 0;
        for (const [type, n] of Object.entries(sm.remaining.troops)) {
          for (let k = 0; k < n; k++) { const [x, y] = jit(sm, p, pts[i++ % pts.length]); sm.deploy(type, x, y); }
        }
        for (const h of [...sm.remaining.heroes]) sm.deployHero(h, ...geo.edge(p.angle));
      });
    }
    while (this.actions.length && this.actions[0].t <= sim.t) this.actions.shift()!.fn(sim);
    if (this.rules.length) this.rules = this.rules.filter((r) => !r(sim));
  }

  finished(): boolean {
    return this.started && this.actions.length === 0;
  }
}

// ---------------------------------------------------------------- geometry
export class Geometry {
  sim: Sim;
  cx: number;
  cy: number;
  constructor(sim: Sim) {
    this.sim = sim;
    let x = 0, y = 0, n = 0;
    for (const b of sim.structures) { x += b.cx; y += b.cy; n++; }
    this.cx = x / n;
    this.cy = y / n;
  }

  dir(turns: number): [number, number] {
    return [Math.cos(turns * 2 * Math.PI), Math.sin(turns * 2 * Math.PI)];
  }

  /** Legal deploy point just outside the base along the ray at `turns`, offset sideways by `side` tiles. */
  edge(turns: number, side = 0, back = 0): [number, number] {
    const [dx, dy] = this.dir(turns);
    const px = -dy, py = dx;
    const N = MAP.size;
    const ox = this.cx + px * side, oy = this.cy + py * side;
    let lastFree: [number, number] | null = null;
    for (let r = 40; r >= 0; r -= 0.5) {
      const x = ox + dx * r, y = oy + dy * r;
      if (x < 0.3 || y < 0.3 || x > N - 0.3 || y > N - 0.3) continue;
      const k = Math.floor(y) * N + Math.floor(x);
      if (this.sim.noDeploy[k]) break;
      lastFree = [x, y];
    }
    if (!lastFree) lastFree = this.sim.legalPoint(ox + dx * 30, oy + dy * 30);
    return this.sim.legalPoint(lastFree[0] + dx * back, lastFree[1] + dy * back);
  }

  /** Points spread along the edge around `turns`. */
  line(turns: number, n: number, width: number, back = 0): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const s = n === 1 ? 0 : -width / 2 + (width * i) / (n - 1);
      out.push(this.edge(turns, s, back));
    }
    return out;
  }

  angleOf(x: number, y: number): number {
    return ((Math.atan2(y - this.cy, x - this.cx) / (2 * Math.PI)) + 1) % 1;
  }

  structures(type: string): Building[] {
    return this.sim.structures.filter((b) => b.alive && b.type === type);
  }

  /** Structures ordered by distance to a point. */
  byDistance(list: Building[], x: number, y: number): Building[] {
    return [...list].sort((a, b) => Math.hypot(a.cx - x, a.cy - y) - Math.hypot(b.cx - x, b.cy - y));
  }

  th(): Building | undefined { return this.sim.structures.find((b) => b.type === 'town-hall'); }
  cc(): Building | undefined { return this.sim.structures.find((b) => b.type === 'clan-castle'); }
}

// ---------------------------------------------------------------- helpers used by strategies
export function jit(sim: Sim, p: StrategyParams, [x, y]: [number, number]): [number, number] {
  return [x + sim.rng.gauss(p.jitter), y + sim.rng.gauss(p.jitter)];
}

export function jt(sim: Sim, p: StrategyParams, t: number): number {
  return Math.max(0, t * p.timing + sim.rng.gauss(p.jitter * 0.4));
}

/** Deploy `n` of `type` spread over the given points (round robin), `gap` seconds apart. */
export function drop(s: ScriptController, sim: Sim, p: StrategyParams, type: string, n: number, pts: [number, number][], t0: number, gap = 0.1) {
  for (let i = 0; i < n; i++) {
    const pt = pts[i % pts.length];
    s.at(jt(sim, p, t0) + i * gap, (sm) => { const [x, y] = jit(sm, p, pt); sm.deploy(type, x, y); });
  }
}

export function attackersOf(sim: Sim, types: string[]): Unit[] {
  return sim.units.filter((u) => u.alive && u.side === SIDE_ATT && types.includes(u.type));
}

export function defendersAlive(sim: Sim): Unit[] {
  return sim.units.filter((u) => u.alive && u.side === SIDE_DEF && !u.hero);
}

/** Best cluster centre among `units`: point with most units within r; returns [x,y,count,meanHp%]. */
export function cluster(units: Unit[], r: number): [number, number, number, number] | null {
  let best: [number, number, number, number] | null = null;
  for (const u of units) {
    let n = 0, sx = 0, sy = 0, hp = 0;
    for (const v of units) {
      if (Math.hypot(u.x - v.x, u.y - v.y) <= r) { n++; sx += v.x; sy += v.y; hp += v.hp / v.maxHp; }
    }
    if (!best || n > best[2]) best = [sx / n, sy / n, n, hp / n];
  }
  return best;
}

export function nearDefense(sim: Sim, x: number, y: number, r: number): boolean {
  return sim.structures.some((b) => b.alive && b.isDefense && !b.hidden && Math.hypot(b.cx - x, b.cy - y) <= r);
}

/** Casts after the player's reaction time, at the spot chosen now. */
export function later(s: ScriptController, sim: Sim, spell: string, x: number, y: number, fromCC = false) {
  s.at(sim.t + TUNABLES.reactionTime, (sm) => sm.cast(spell, x, y, fromCC));
}

/** Reactive heal: cast on a cluster of `types` that is taking damage. */
export function healRule(s: ScriptController, types: string[], minUnits: number, hpBelow: number, cooldown = 4) {
  let last = -99;
  s.rule((sim) => {
    if (!sim.remaining.spells['healing-spell']) return true;
    if (sim.t - last < cooldown) return;
    const c = cluster(attackersOf(sim, types), 3.5);
    if (!c || c[2] < minUnits || c[3] > hpBelow) return;
    // lead the target slightly: troops keep moving
    const us = attackersOf(sim, types).filter((u) => Math.hypot(u.x - c[0], u.y - c[1]) <= 3.5);
    let vx = 0, vy = 0;
    for (const u of us) { const b = u.tgtB >= 0 ? sim.buildings[u.tgtB] : null; if (b) { vx += b.cx - u.x; vy += b.cy - u.y; } }
    const vl = Math.hypot(vx, vy) || 1;
    later(s, sim, 'healing-spell', c[0] + (vx / vl) * 1.5, c[1] + (vy / vl) * 1.5);
    last = sim.t;
  });
}

/** Reactive rage: cast where `minUnits` damage dealers are fighting near defenses. */
export function rageRule(s: ScriptController, types: string[], minUnits: number, cooldown = 6, startAfter = 0) {
  let last = -99;
  s.rule((sim) => {
    if (!sim.remaining.spells['rage-spell']) return true;
    if (sim.t < startAfter || sim.t - last < cooldown) return;
    const c = cluster(attackersOf(sim, types), 3.5);
    if (!c || c[2] < minUnits || !nearDefense(sim, c[0], c[1], 7)) return;
    later(s, sim, 'rage-spell', c[0], c[1]);
    last = sim.t;
  });
}

/** Poison the defending Clan Castle troops once they are out and bunched up. */
export function poisonRule(s: ScriptController) {
  s.rule((sim) => {
    if (!sim.remaining.spells['poison-spell']) return true;
    const d = defendersAlive(sim);
    if (!sim.ccTriggered || d.length < 2) return;
    const c = cluster(d, 3);
    if (!c || c[2] < Math.min(2, d.length)) return;
    later(s, sim, 'poison-spell', c[0], c[1]);
    return true;
  });
}

/** Hero ability when health drops (or a fixed time as fallback). */
export function heroAbilityRule(s: ScriptController, hpBelow = 0.45, latest = 150) {
  s.rule((sim) => {
    const h = sim.heroUnits.find((u) => u.alive && !u.abilityUsed);
    if (!h) return sim.heroUnits.length > 0 && sim.heroUnits.every((u) => !u.alive || u.abilityUsed);
    if (h.hp / h.maxHp < hpBelow || sim.t > latest) sim.activateHero(h);
  });
}

/**
 * Army composition tweak: swap housing from one troop to another, e.g.
 * ['archer', 'wall-breaker', 8] = remove 8 housing of archers, add wall breakers.
 */
export type Swap = [string, string, number];

export function applySwaps(army: Army, swaps: Swap[] | undefined, housingOf: (t: string) => number): Army {
  if (!swaps?.length) return army;
  const troops = { ...army.troops };
  for (const [from, to, space] of swaps) {
    const hf = housingOf(from), ht = housingOf(to);
    if (!hf || !ht || !troops[from]) continue;
    const remove = Math.min(troops[from], Math.ceil(space / hf));
    const freed = remove * hf;
    const add = Math.floor(freed / ht);
    if (add <= 0) continue;
    troops[from] -= remove;
    if (!troops[from]) delete troops[from];
    troops[to] = (troops[to] ?? 0) + add;
  }
  return { ...army, troops };
}

export function heroSpec(p: StrategyParams) {
  return [{ id: p.hero, equipment: p.equipment ?? HERO_EQUIPMENT[p.hero] }];
}
