// Tick-based Clash of Clans battle simulation (home village / war, TH8).
//
// One Sim = one attack on one layout. The attacker is driven by a Controller
// (see src/strategies) that deploys troops, casts spells and fires hero abilities
// through the public methods below — exactly the inputs a player has.
import { DATA, num, type AttackStats, type TroopDef } from './data.ts';
import {
  MAP, TUNABLES as T, PREFERENCE, AIR_UNITS, WALL_JUMPERS, IGNORES_UNITS, MIN_RANGE,
  AIR_SWEEPER_HALF_ANGLE, SKELETON, SNAKE, EQ_DIMINISH, type Preference,
} from './mechanics.ts';
import { Rng } from './rng.ts';
import { computeField, nextCell, distToRect, type PathGrid, type Rect } from './pathing.ts';
import type { Layout } from '../bases/layout.ts';

export const SIDE_ATT = 0;
export const SIDE_DEF = 1;

export interface Building {
  uid: number; type: string; kind: string;
  x: number; y: number; w: number; h: number; // world tiles (top-left)
  cx: number; cy: number; rect: Rect;
  hp: number; maxHp: number; alive: boolean;
  isWall: boolean; counts: boolean; isDefense: boolean; isResource: boolean;
  attack?: AttackStats; minRange: number;
  cooldown: number; target: number; hidden: boolean; eqHits: number; wallEqHits: number;
  facing: number; frozenUntil: number; destroyedAt: number;
  damageDealt: number; kills: number;
}

export interface Unit {
  uid: number; type: string; side: number; x: number; y: number;
  hp: number; maxHp: number; alive: boolean;
  air: boolean; hero: boolean; housing: number;
  speedPts: number; range: number; attackSpeed: number; dmgPerShot: number;
  damageType: 'single' | 'splash' | 'none'; canHit: 'ground' | 'air' | 'both'; splash: number;
  pref: Preference; jumper: boolean; ignoresUnits: boolean;
  cooldown: number; tgtB: number; tgtU: number; wallTarget: number;
  // timed effects
  rageUntil: number; rageDmg: number; rageSpeed: number;
  eqUntil: number; eqDmg: number; eqSpeed: number; eqAtkSpeed: number;
  hasteUntil: number; hasteSpeed: number;
  slowUntil: number; slowFactor: number; frozenUntil: number; invisibleUntil: number;
  poisonUntil: number; poisonSlow: number; poisonAtk: number;
  dmgReduction: number; reductionUntil: number; selfHeal: number; selfHealUntil: number;
  splashUntil: number; splashBoost: number; invisBonus: number;
  lifeUntil: number;
  // hero
  equipment: string[]; abilityUsed: boolean; abilityHeal: number; snakesLeft: number; nextSnakeHp: number;
  frozenArrow: boolean; monolith: number;
  // healer
  healPerSec: number; healHeroPerSec: number;
  // defender
  homeX: number; homeY: number; leash: number;
  deathDamage: number; golemites: number;
  spawnedAt: number; diedAt: number; killedBy: string;
  rescan: number; stuck: number; idleUntil: number;
}

interface Projectile { x: number; y: number; t: number; dmg: number; radius: number; hits: 'ground' | 'air' | 'both'; src: number }
interface Trap { uid: number; type: string; cx: number; cy: number; x: number; y: number; w: number; armedAt: number; done: boolean; trig: number }
interface ActiveSpell { type: string; x: number; y: number; radius: number; start: number; until: number; nextPulse: number; side: number; level: any }

export interface Army {
  troops: Record<string, number>;
  spells: Record<string, number>;
  cc: { troops: Record<string, number>; spells: Record<string, number> };
  heroes: { id: string; equipment: string[] }[];
}

export interface Controller {
  onTick(sim: Sim): void;
  /** true when the controller will never deploy/cast anything again */
  finished(sim: Sim): boolean;
}

export interface Frame {
  t: number;
  units: [number, string, number, number, number, number][]; // uid, type, side, x, y, hp%
  bhp: number[]; // per non-wall building hp (0 = destroyed), same order as sim.structures
  walls: number[]; // destroyed wall uids so far
  spells: [string, number, number, number][];
  shots: [number, number, number, number][]; // from x,y to x,y
}

export interface SimResult {
  stars: number; pct: number; thDestroyed: boolean; time: number;
  timeline: { t: number; pct: number; stars: number }[];
  defenseStats: { type: string; uid: number; damage: number; kills: number; destroyedAt: number }[];
  unitsLost: Record<string, number>;
  killedBy: Record<string, number>;
  frames?: Frame[];
  log: string[];
}

export interface SimOptions {
  seed?: number;
  dt?: number;
  record?: boolean;
  frameEvery?: number;
  /** Number of defending heroes (default: data heroSlots). */
  defendingHeroes?: number;
  defendingHeroEquipment?: Record<string, string[]>;
  heroSlots?: number;
}

const N = MAP.size;
const B = MAP.border;

function dist(ax: number, ay: number, bx: number, by: number) { return Math.hypot(ax - bx, ay - by); }

export function validateArmy(a: Army, heroSlots = DATA.capacities.heroSlots): string[] {
  const errs: string[] = [];
  let h = 0;
  for (const [t, c] of Object.entries(a.troops)) {
    const d = DATA.troops[t];
    if (!d) errs.push(`troop ${t} not available at TH8`);
    else h += d.housing * c;
  }
  if (h > DATA.capacities.army) errs.push(`army housing ${h} > ${DATA.capacities.army}`);
  let s = 0, ds = 0;
  for (const [t, c] of Object.entries(a.spells)) {
    const d = DATA.spells[t];
    if (!d) { errs.push(`spell ${t} not available at TH8`); continue; }
    if (d.spellType === 'dark') ds += d.housingSpace * c; else s += d.housingSpace * c;
  }
  if (s > DATA.capacities.spells) errs.push(`spell housing ${s} > ${DATA.capacities.spells}`);
  if (ds > DATA.capacities.darkSpells) errs.push(`dark spell housing ${ds} > ${DATA.capacities.darkSpells}`);
  let ch = 0, cs = 0;
  for (const [t, c] of Object.entries(a.cc.troops)) {
    const d = DATA.ccTroops[t];
    if (!d) errs.push(`CC troop ${t} unknown`); else ch += d.housing * c;
  }
  for (const [t, c] of Object.entries(a.cc.spells)) {
    const d = DATA.ccSpells[t];
    if (!d) errs.push(`CC spell ${t} unknown`); else cs += d.housingSpace * c;
  }
  if (ch > DATA.capacities.ccTroops) errs.push(`CC troops ${ch} > ${DATA.capacities.ccTroops}`);
  if (cs > DATA.capacities.ccSpells) errs.push(`CC spells ${cs} > ${DATA.capacities.ccSpells}`);
  if (a.heroes.length > heroSlots) errs.push(`${a.heroes.length} heroes > ${heroSlots} hero slot(s)`);
  for (const hero of a.heroes) {
    if (!DATA.heroes[hero.id]) errs.push(`hero ${hero.id} unknown`);
    if (hero.equipment.length > 2) errs.push(`${hero.id}: more than 2 equipment`);
    for (const e of hero.equipment) {
      const ed = DATA.equipment[e];
      if (!ed) errs.push(`equipment ${e} not available at TH8`);
      else if (ed.hero !== hero.id) errs.push(`equipment ${e} belongs to ${ed.hero}`);
    }
  }
  return errs;
}

export class Sim {
  t = 0;
  dt: number;
  rng: Rng;
  layout: Layout;
  army: Army;
  ctrl: Controller;
  opts: SimOptions;

  buildings: Building[] = [];   // everything incl. walls, index = uid
  structures: Building[] = [];  // non-wall buildings (for targeting/scoring)
  units: Unit[] = [];
  traps: Trap[] = [];
  spells: ActiveSpell[] = [];
  projectiles: Projectile[] = [];

  grid: PathGrid;
  wallAt: Int32Array;
  noDeploy: Uint8Array;
  private fields = new Map<string, { v: number; at: number; f: Float32Array; limit: number }>();

  remaining: { troops: Record<string, number>; spells: Record<string, number>; ccTroops: Record<string, number>; ccSpells: Record<string, number>; heroes: string[] };
  deployedAny = false;
  ccTriggered = false;
  private ccQueue: string[] = [];
  private ccNextRelease = 0;
  private ccBuilding: Building | null = null;
  totalCounted = 0;
  destroyedCounted = 0;
  thDestroyed = false;
  timeline: { t: number; pct: number; stars: number }[] = [];
  frames: Frame[] = [];
  log: string[] = [];
  unitsLost: Record<string, number> = {};
  killedBy: Record<string, number> = {};
  private nextUid = 0;
  private lastFrame = -1;
  private shots: [number, number, number, number][] = [];
  private destroyedWalls: number[] = [];
  heroUnits: Unit[] = [];

  constructor(layout: Layout, army: Army, ctrl: Controller, opts: SimOptions = {}) {
    this.layout = layout;
    this.army = army;
    this.ctrl = ctrl;
    this.opts = opts;
    this.dt = opts.dt ?? 0.1;
    this.rng = new Rng(opts.seed ?? 1);
    const errs = validateArmy(army, opts.heroSlots);
    if (errs.length) throw new Error('invalid army: ' + errs.join('; '));
    this.remaining = {
      troops: { ...army.troops }, spells: { ...army.spells },
      ccTroops: { ...army.cc.troops }, ccSpells: { ...army.cc.spells },
      heroes: army.heroes.map((h) => h.id),
    };
    this.grid = { n: N, blocked: new Uint8Array(N * N), wallHp: new Float32Array(N * N), version: 0 };
    this.wallAt = new Int32Array(N * N).fill(-1);
    this.noDeploy = new Uint8Array(N * N);
    this.buildBase();
  }

  // ------------------------------------------------------------------ setup
  private buildBase() {
    const L = this.layout;
    const add = (type: string, bx: number, by: number) => {
      const isWall = type === 'wall';
      const def = isWall ? null : DATA.buildings[type];
      if (!isWall && !def) throw new Error(`unknown building ${type}`);
      const [w, h] = isWall ? [1, 1] : def!.size;
      const x = bx + B, y = by + B;
      const hp = isWall ? DATA.wall.hp : def!.hp;
      const b: Building = {
        uid: this.buildings.length, type, kind: isWall ? 'wall' : def!.kind,
        x, y, w, h, cx: x + w / 2, cy: y + h / 2,
        // Hit box: footprint minus the grass rim (half a tile) for real buildings.
        rect: isWall ? { x0: x, y0: y, x1: x + 1, y1: y + 1 } : { x0: x + 0.5, y0: y + 0.5, x1: x + w - 0.5, y1: y + h - 0.5 },
        hp, maxHp: hp, alive: true, isWall, counts: !isWall,
        isDefense: !isWall && def!.kind === 'defense' && type !== 'builders-hut',
        isResource: !isWall && (def!.kind === 'resource' || type === 'town-hall'),
        attack: def?.attack, minRange: MIN_RANGE[type] ?? 0,
        cooldown: 0, target: -1, hidden: type === 'hidden-tesla', eqHits: 0, wallEqHits: 0,
        facing: type === 'air-sweeper' ? (L.sweeperFacing ?? this.outwardAngle(x + w / 2, y + h / 2)) : 0,
        frozenUntil: -1, destroyedAt: -1, damageDealt: 0, kills: 0,
      };
      this.buildings.push(b);
      if (!isWall) this.structures.push(b);
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
        const k = j * N + i;
        if (isWall) { this.wallAt[k] = b.uid; this.grid.wallHp[k] = hp; } else this.grid.blocked[k] = 1;
      }
      const m = T.noDeployMargin;
      for (let j = y - m; j < y + h + m; j++) for (let i = x - m; i < x + w + m; i++) {
        if (i >= 0 && j >= 0 && i < N && j < N) this.noDeploy[j * N + i] = 1;
      }
      if (type === 'clan-castle') this.ccBuilding = b;
      return b;
    };
    for (const p of L.buildings) add(p.type, p.x, p.y);
    for (const [x, y] of L.walls) add('wall', x, y);
    this.totalCounted = this.structures.length;
    for (const tr of L.traps) {
      const d = DATA.traps[tr.type];
      if (!d) throw new Error(`unknown trap ${tr.type}`);
      const x = tr.x + B, y = tr.y + B;
      this.traps.push({ uid: this.traps.length, type: tr.type, x, y, w: d.size[0], cx: x + d.size[0] / 2, cy: y + d.size[1] / 2, armedAt: -1, done: false, trig: -1 });
    }
    // CC defenders queued; released when triggered
    for (const [t, c] of Object.entries(L.cc)) for (let i = 0; i < c; i++) this.ccQueue.push(t);
    this.rng.shuffle(this.ccQueue);
    // Defending heroes
    const nHeroes = this.opts.defendingHeroes ?? DATA.capacities.heroSlots;
    for (const h of L.heroes.slice(0, nHeroes)) {
      const eq = this.opts.defendingHeroEquipment?.[h.type] ?? (h.type === 'archer-queen' ? ['frozen-arrow', 'magic-mirror'] : ['spiky-ball', 'giant-gauntlet']);
      const u = this.spawnHero(h.type, eq, h.x + B + 0.5, h.y + B + 0.5, SIDE_DEF);
      u.homeX = u.x; u.homeY = u.y; u.leash = DATA.heroes[h.type].searchRadius;
    }
  }

  private outwardAngle(x: number, y: number) {
    return Math.atan2(y - N / 2, x - N / 2);
  }

  // ------------------------------------------------------------------ unit factory
  private baseUnit(type: string, side: number, x: number, y: number): Unit {
    return {
      uid: this.nextUid++, type, side, x, y, hp: 1, maxHp: 1, alive: true, air: AIR_UNITS.has(type), hero: false, housing: 0,
      speedPts: 16, range: 0.5, attackSpeed: 1, dmgPerShot: 0, damageType: 'single', canHit: 'ground', splash: 0,
      pref: PREFERENCE[type] ?? 'none', jumper: WALL_JUMPERS.has(type), ignoresUnits: IGNORES_UNITS.has(type),
      cooldown: 0, tgtB: -1, tgtU: -1, wallTarget: -1,
      rageUntil: -1, rageDmg: 0, rageSpeed: 0, eqUntil: -1, eqDmg: 0, eqSpeed: 0, eqAtkSpeed: 0,
      hasteUntil: -1, hasteSpeed: 0,
      slowUntil: -1, slowFactor: 0, frozenUntil: -1, invisibleUntil: -1, poisonUntil: -1, poisonSlow: 0, poisonAtk: 0,
      dmgReduction: 0, reductionUntil: -1, selfHeal: 0, selfHealUntil: -1, splashUntil: -1, splashBoost: 0, invisBonus: 0,
      lifeUntil: Infinity, equipment: [], abilityUsed: false, abilityHeal: 0, snakesLeft: 0, nextSnakeHp: 0,
      frozenArrow: false, monolith: 0, healPerSec: 0, healHeroPerSec: 0,
      homeX: x, homeY: y, leash: Infinity, deathDamage: 0, golemites: 0,
      spawnedAt: this.t, diedAt: -1, killedBy: '', rescan: 0, stuck: 0, idleUntil: -1,
    };
  }

  spawnTroop(def: TroopDef, side: number, x: number, y: number): Unit {
    const u = this.baseUnit(def.id, side, x, y);
    u.hp = u.maxHp = def.hp;
    u.housing = def.housing;
    u.speedPts = def.speed;
    u.range = def.range;
    u.attackSpeed = def.attackSpeed;
    u.dmgPerShot = def.damagePerShot || def.dps * def.attackSpeed;
    u.damageType = def.damageType;
    u.canHit = def.targetType;
    u.splash = T.troopSplash[def.id] ?? 0;
    u.deathDamage = def.deathDamage ?? 0;
    u.golemites = def.golemitesSpawned ?? 0;
    if (def.healingPerSecond) { u.healPerSec = def.healingPerSecond; u.healHeroPerSec = def.healingPerSecondOnHeroes ?? def.healingPerSecond * 0.55; }
    this.units.push(u);
    return u;
  }

  private spawnSimple(type: string, side: number, x: number, y: number, s: { hp: number; dps: number; speed: number; range: number; attackSpeed: number }, canHit: 'ground' | 'both' = 'ground'): Unit {
    const u = this.baseUnit(type, side, x, y);
    u.hp = u.maxHp = s.hp; u.speedPts = s.speed; u.range = s.range; u.attackSpeed = s.attackSpeed;
    u.dmgPerShot = s.dps * s.attackSpeed; u.canHit = canHit;
    this.units.push(u);
    return u;
  }

  spawnHero(id: string, equipment: string[], x: number, y: number, side: number): Unit {
    const h = DATA.heroes[id];
    const u = this.baseUnit(id, side, x, y);
    let hp = h.hp, dps = h.dps, heal = h.healthRecovery;
    for (const e of equipment) {
      const ed = DATA.equipment[e];
      if (!ed) continue;
      hp += ed.hitpointIncrease;
      heal += ed.hpRecoveryIncrease;
      dps += num(ed.stats.dpsIncrease);
      if (e === 'frozen-arrow') u.frozenArrow = true;
      if (e === 'monolith-arrow') u.monolith = num(ed.stats.extraDamage181To250) / 100;
      if (e === 'snake-bracelet') { u.snakesLeft = num(ed.stats.maxSummonedSnakes); }
      if (e === 'stick-horse') { u.eqUntil = this.t + num(ed.stats.abilityDuration, 20); u.eqSpeed = num(ed.stats.movementSpeedIncrease); u.eqAtkSpeed = num(ed.stats.attackSpeedIncrease) / 100; }
    }
    u.hero = true;
    u.hp = u.maxHp = hp;
    u.nextSnakeHp = hp * 0.9;
    u.speedPts = h.speed;
    u.range = h.range;
    u.attackSpeed = h.attackSpeed;
    u.dmgPerShot = dps * h.attackSpeed;
    u.canHit = id === 'archer-queen' ? 'both' : 'ground';
    u.abilityHeal = heal;
    u.equipment = equipment;
    this.units.push(u);
    if (side === SIDE_ATT) this.heroUnits.push(u);
    return u;
  }

  // ------------------------------------------------------------------ player inputs
  /** Nearest legal deploy point to (x, y) in world tiles. */
  legalPoint(x: number, y: number): [number, number] {
    const cx = Math.min(N - 1, Math.max(0, Math.floor(x))), cy = Math.min(N - 1, Math.max(0, Math.floor(y)));
    if (!this.noDeploy[cy * N + cx]) return [Math.min(N - 0.01, Math.max(0, x)), Math.min(N - 0.01, Math.max(0, y))];
    let best: [number, number] = [0.5, 0.5], bd = Infinity;
    for (let r = 1; r < N; r++) {
      for (let j = cy - r; j <= cy + r; j++) for (let i = cx - r; i <= cx + r; i++) {
        if (i < 0 || j < 0 || i >= N || j >= N) continue;
        if (Math.max(Math.abs(i - cx), Math.abs(j - cy)) !== r) continue;
        if (this.noDeploy[j * N + i]) continue;
        const d = dist(i + 0.5, j + 0.5, x, y);
        if (d < bd) { bd = d; best = [i + 0.5, j + 0.5]; }
      }
      if (bd < Infinity) return best;
    }
    return best;
  }

  deploy(type: string, x: number, y: number): Unit | null {
    if (!this.remaining.troops[type]) return null;
    this.remaining.troops[type]--;
    const [px, py] = this.legalPoint(x, y);
    this.deployedAny = true;
    return this.spawnTroop(DATA.troops[type], SIDE_ATT, px, py);
  }

  deployCC(x: number, y: number): Unit[] {
    const out: Unit[] = [];
    const [px, py] = this.legalPoint(x, y);
    for (const [t, c] of Object.entries(this.remaining.ccTroops)) {
      for (let i = 0; i < c; i++) out.push(this.spawnTroop(DATA.ccTroops[t], SIDE_ATT, px + this.rng.range(-0.4, 0.4), py + this.rng.range(-0.4, 0.4)));
      this.remaining.ccTroops[t] = 0;
    }
    if (out.length) this.deployedAny = true;
    return out;
  }

  deployHero(id: string, x: number, y: number): Unit | null {
    const i = this.remaining.heroes.indexOf(id);
    if (i < 0) return null;
    this.remaining.heroes.splice(i, 1);
    const [px, py] = this.legalPoint(x, y);
    const eq = this.army.heroes.find((h) => h.id === id)!.equipment;
    this.deployedAny = true;
    return this.spawnHero(id, eq, px, py, SIDE_ATT);
  }

  /** Fires every active equipment ability of an attacking hero (one tap in game). */
  activateHero(u: Unit): boolean {
    if (!u.alive || u.abilityUsed || u.side !== SIDE_ATT) return false;
    u.abilityUsed = true;
    u.hp = Math.min(u.maxHp, u.hp + u.abilityHeal);
    for (const e of u.equipment) {
      const ed = DATA.equipment[e];
      if (!ed || ed.abilityType !== 'Active') continue;
      const s = ed.stats, a = ed.ability;
      switch (e) {
        case 'rage-vial':
          u.eqUntil = this.t + num(a.abilityDuration, 10); u.eqDmg = num(s.damageIncrease) / 100; u.eqSpeed = num(s.movementSpeedIncrease);
          break;
        case 'barbarian-puppet': {
          const n = num(s.summonedBarbarians);
          for (let i = 0; i < n; i++) {
            const b = this.spawnTroop(DATA.troops.barbarian, SIDE_ATT, u.x + this.rng.range(-1, 1), u.y + this.rng.range(-1, 1));
            b.eqUntil = this.t + num(a.barbarianRageDuration, 20); b.eqDmg = num(s.barbarianDamageIncrease) / 100; b.eqSpeed = num(s.barbarianSpeedIncrease);
          }
          break;
        }
        case 'earthquake-boots': {
          // Estimate: stomp breaks walls around the King (34% x EQ wall multiplier) and hurts defending troops.
          const r = 3.5;
          const pct = num(s.buildingDamagePercent) / 100;
          for (const b of this.buildings) {
            if (!b.alive || !b.isWall || dist(b.cx, b.cy, u.x, u.y) > r) continue;
            this.damageBuilding(b, b.maxHp * pct * T.eqWallMultiplier, null);
          }
          for (const v of this.units) if (v.alive && v.side === SIDE_DEF && !v.air && dist(v.x, v.y, u.x, u.y) <= r) this.damageUnit(v, v.maxHp * num(s.troopDamagePercent) / 100, 'earthquake-boots');
          break;
        }
        case 'giant-gauntlet':
          u.reductionUntil = this.t + num(s.abilityDuration, 16); u.dmgReduction = num(s.incomingDamageReduction) / 100;
          u.selfHeal = num(s.selfHealingPerSecond); u.selfHealUntil = u.reductionUntil;
          u.splashUntil = u.reductionUntil; u.splashBoost = num(a.areaDamageRadius, 2.5);
          break;
        case 'spiky-ball': {
          const dmg = num(s.projectileDamagePerTarget), n = num(s.numberOfTargets, 1);
          const tb = u.tgtB >= 0 ? this.buildings[u.tgtB] : null;
          let cur: Building | null = tb && tb.alive && !tb.isWall ? tb : this.nearestStructure(u.x, u.y, () => true);
          const hit = new Set<number>();
          for (let i = 0; i < n && cur; i++) {
            hit.add(cur.uid);
            this.damageBuilding(cur, dmg, u);
            const from = cur;
            cur = this.nearestStructure(from.cx, from.cy, (b) => !hit.has(b.uid) && dist(b.cx, b.cy, from.cx, from.cy) < 5);
          }
          break;
        }
        case 'archer-puppet': {
          const n = num(s.summonedArchers);
          for (let i = 0; i < n; i++) {
            const ar = this.spawnTroop(DATA.troops.archer, SIDE_ATT, u.x + this.rng.range(-1, 1), u.y + this.rng.range(-1, 1));
            ar.invisibleUntil = this.t + num(s.archerInvisibilityDuration, 5);
          }
          break;
        }
        case 'invisibility-vial':
          u.invisibleUntil = this.t + num(s.abilityDuration, 6); u.invisBonus = num(s.damagePerShotIncrease);
          break;
        case 'magic-mirror': {
          const n = num(s.clones, 1);
          for (let i = 0; i < n; i++) {
            const c = this.spawnSimple('queen-clone', SIDE_ATT, u.x + 0.5, u.y + 0.5,
              { hp: num(s.cloneHealth), dps: num(s.cloneDps), speed: 24, range: 5, attackSpeed: 0.75 }, 'both');
            c.lifeUntil = this.t + num(s.cloneDuration, 25);
          }
          break;
        }
        case 'action-figure': {
          // Estimate: summons one "Giant Giant" (stats not in the data set).
          const g = this.spawnSimple('giant-giant', SIDE_ATT, u.x + 0.5, u.y + 0.5, { hp: 2800, dps: 150, speed: 12, range: 1, attackSpeed: 2 });
          g.pref = 'defense';
          u.selfHeal = num(s.selfHealingPerSecond); u.selfHealUntil = this.t + 10;
          break;
        }
      }
    }
    this.log.push(`${this.t.toFixed(1)}s ${u.type} ability`);
    return true;
  }

  cast(type: string, x: number, y: number, fromCC = false): boolean {
    const pool = fromCC ? this.remaining.ccSpells : this.remaining.spells;
    if (!pool[type]) return false;
    pool[type]--;
    const d = fromCC ? DATA.ccSpells[type] : DATA.spells[type];
    this.deployedAny = true;
    const x2 = Math.min(N, Math.max(0, x)), y2 = Math.min(N, Math.max(0, y));
    switch (type) {
      case 'lightning-spell': {
        const r = d.radius;
        for (const b of this.structures) if (b.alive && dist(b.cx, b.cy, x2, y2) <= r) this.damageBuilding(b, d.damage, null);
        for (const u of this.units) if (u.alive && u.side === SIDE_DEF && dist(u.x, u.y, x2, y2) <= r) this.damageUnit(u, d.damage, 'lightning');
        break;
      }
      case 'earthquake-spell': {
        const r = d.radius, pct = d.buildingDamagePercent / 100;
        for (const b of this.buildings) {
          if (!b.alive || dist(b.cx, b.cy, x2, y2) > r) continue;
          if (b.isWall) { b.wallEqHits++; this.damageBuilding(b, b.maxHp * pct * T.eqWallMultiplier * b.wallEqHits, null); }
          else { b.eqHits++; this.damageBuilding(b, b.maxHp * pct * EQ_DIMINISH(b.eqHits), null); }
        }
        break;
      }
      case 'skeleton-spell': {
        for (let i = 0; i < 8; i++) this.spawnSimple('skeleton', SIDE_ATT, x2 + this.rng.range(-1.5, 1.5), y2 + this.rng.range(-1.5, 1.5), SKELETON);
        break;
      }
      default: {
        const dur = d.spellDuration ?? (d.numberOfPulses && d.timeBetweenPulses ? d.numberOfPulses * d.timeBetweenPulses : 10);
        this.spells.push({ type, x: x2, y: y2, radius: d.radius ?? 4, start: this.t, until: this.t + dur, nextPulse: this.t, side: SIDE_ATT, level: d });
      }
    }
    this.log.push(`${this.t.toFixed(1)}s cast ${type}${fromCC ? ' (CC)' : ''} @${x2.toFixed(1)},${y2.toFixed(1)}`);
    return true;
  }

  // ------------------------------------------------------------------ queries
  nearestStructure(x: number, y: number, pred: (b: Building) => boolean): Building | null {
    let best: Building | null = null, bd = Infinity;
    for (const b of this.structures) {
      if (!b.alive || !pred(b)) continue;
      const d = distToRect(x, y, b.rect);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  aliveStructures(pred: (b: Building) => boolean = () => true): Building[] {
    return this.structures.filter((b) => b.alive && pred(b));
  }

  attackers(): Unit[] { return this.units.filter((u) => u.alive && u.side === SIDE_ATT); }

  get pct(): number { return (100 * this.destroyedCounted) / Math.max(1, this.totalCounted); }

  get stars(): number {
    const p = this.pct;
    return (p >= 50 ? 1 : 0) + (this.thDestroyed ? 1 : 0) + (p >= 100 - 1e-9 ? 1 : 0);
  }

  // ------------------------------------------------------------------ damage
  damageBuilding(b: Building, amount: number, src: Unit | null) {
    if (!b.alive || amount <= 0) return;
    b.hp -= amount;
    if (b.hp > 0) return;
    b.hp = 0;
    b.alive = false;
    b.destroyedAt = this.t;
    if (b.isWall) {
      const k = (b.y) * N + b.x;
      this.grid.wallHp[k] = 0;
      this.wallAt[k] = -1;
      this.destroyedWalls.push(b.uid);
    } else {
      for (let j = b.y; j < b.y + b.h; j++) for (let i = b.x; i < b.x + b.w; i++) this.grid.blocked[j * N + i] = 0;
      this.destroyedCounted++;
      if (b.type === 'town-hall') this.thDestroyed = true;
      if (b.type === 'clan-castle') this.triggerCC();
      const dd = DATA.buildings[b.type]?.deathDamage;
      if (dd) this.projectiles.push({ x: b.cx, y: b.cy, t: this.t + 1, dmg: dd, radius: T.deathRadius[b.type] ?? 2, hits: 'ground', src: b.uid });
      this.timeline.push({ t: this.t, pct: this.pct, stars: this.stars });
    }
    this.grid.version++;
  }

  damageUnit(u: Unit, amount: number, by: string) {
    if (!u.alive || amount <= 0) return;
    if (u.reductionUntil > this.t) amount *= 1 - u.dmgReduction;
    u.hp -= amount;
    if (u.hero && u.snakesLeft > 0 && u.hp < u.nextSnakeHp) {
      // Snake Bracelet (estimate): a few snakes per 10% HP lost
      const n = Math.min(4, u.snakesLeft);
      u.snakesLeft -= n;
      u.nextSnakeHp -= u.maxHp * 0.1;
      for (let i = 0; i < n; i++) this.spawnSimple('snake', u.side, u.x + this.rng.range(-1, 1), u.y + this.rng.range(-1, 1), SNAKE);
    }
    if (u.hp > 0) return;
    this.killUnit(u, by);
  }

  private killUnit(u: Unit, by: string) {
    u.hp = 0;
    u.alive = false;
    u.diedAt = this.t;
    u.killedBy = by;
    if (u.side === SIDE_ATT) {
      this.unitsLost[u.type] = (this.unitsLost[u.type] ?? 0) + 1;
      this.killedBy[by] = (this.killedBy[by] ?? 0) + 1;
    }
    if (u.deathDamage) {
      // Balloon / Golem / WB death damage hits buildings and enemy ground units below.
      const r = T.deathRadius[u.type] ?? 1.2;
      if (u.side === SIDE_ATT) for (const b of this.structures) if (b.alive && distToRect(u.x, u.y, b.rect) <= r) this.damageBuilding(b, u.deathDamage, u);
      for (const v of this.units) if (v.alive && v.side !== u.side && !v.air && dist(v.x, v.y, u.x, u.y) <= r) this.damageUnit(v, u.deathDamage, u.type);
    }
    if (u.golemites > 0 && u.type === 'golem') {
      const g = DATA.troops.golem ?? DATA.ccTroops.golem;
      for (let i = 0; i < u.golemites; i++) {
        const m = this.spawnSimple('golemite', u.side, u.x + this.rng.range(-0.8, 0.8), u.y + this.rng.range(-0.8, 0.8),
          { hp: g.hp / 5, dps: g.dps / 5, speed: g.speed, range: g.range, attackSpeed: g.attackSpeed });
        m.pref = 'defense';
        m.ignoresUnits = true;
      }
    }
  }

  // ------------------------------------------------------------------ main loop
  run(): SimResult {
    const end = MAP.battleTime;
    let idle = 0;
    while (this.t < end) {
      this.step();
      if (this.destroyedCounted >= this.totalCounted) break;
      const anyAtt = this.units.some((u) => u.alive && u.side === SIDE_ATT);
      if (this.deployedAny && !anyAtt && this.ctrl.finished(this) && this.projectiles.length === 0) {
        if (++idle > 5) break;
      } else idle = 0;
    }
    this.recordFrame(true);
    return this.result();
  }

  result(): SimResult {
    return {
      stars: this.stars, pct: Math.round(this.pct * 100) / 100, thDestroyed: this.thDestroyed, time: Math.round(this.t * 10) / 10,
      timeline: this.timeline,
      defenseStats: this.structures.filter((b) => b.attack).map((b) => ({ type: b.type, uid: b.uid, damage: Math.round(b.damageDealt), kills: b.kills, destroyedAt: b.destroyedAt })),
      unitsLost: this.unitsLost, killedBy: this.killedBy,
      frames: this.opts.record ? this.frames : undefined,
      log: this.log,
    };
  }

  step() {
    const dt = this.dt;
    this.ctrl.onTick(this);
    this.updateSpells(dt);
    this.updateCC();
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.alive) this.updateUnit(u, dt);
    }
    for (const b of this.structures) if (b.alive && b.attack) this.updateDefense(b, dt);
    this.updateProjectiles();
    this.updateTraps();
    this.t += dt;
    this.recordFrame(false);
    if (this.units.length > 400) this.units = this.units.filter((u) => u.alive || this.t - u.diedAt < 1);
  }

  private recordFrame(force: boolean) {
    if (!this.opts.record) return;
    const every = this.opts.frameEvery ?? 0.2;
    if (!force && this.t - this.lastFrame < every - 1e-9) return;
    this.lastFrame = this.t;
    this.frames.push({
      t: Math.round(this.t * 100) / 100,
      units: this.units.filter((u) => u.alive).map((u) => [u.uid, u.type, u.side, Math.round(u.x * 100) / 100, Math.round(u.y * 100) / 100, Math.round((100 * u.hp) / u.maxHp)]),
      bhp: this.structures.map((b) => Math.max(0, Math.round((100 * b.hp) / b.maxHp))),
      walls: this.destroyedWalls.slice(),
      spells: this.spells.filter((s) => s.until > this.t).map((s) => [s.type, s.x, s.y, s.radius]),
      shots: this.shots.splice(0),
    });
  }

  // ------------------------------------------------------------------ spells over time
  private updateSpells(dt: number) {
    for (const s of this.spells) {
      if (this.t > s.until) continue;
      const d = s.level;
      switch (s.type) {
        case 'rage-spell':
          for (const u of this.units) {
            if (!u.alive || u.side !== SIDE_ATT || dist(u.x, u.y, s.x, s.y) > s.radius) continue;
            u.rageUntil = this.t + (d.boostTime ?? 1);
            u.rageDmg = (d.damageIncrease / 100) * (u.hero ? T.heroRageFactor : 1);
            u.rageSpeed = d.speedIncrease;
          }
          break;
        case 'haste-spell':
          for (const u of this.units) {
            if (!u.alive || u.side !== SIDE_ATT || dist(u.x, u.y, s.x, s.y) > s.radius) continue;
            u.hasteUntil = this.t + 1; u.hasteSpeed = d.speedIncrease ?? 28;
          }
          break;
        case 'healing-spell':
          if (this.t >= s.nextPulse) {
            s.nextPulse += d.timeBetweenPulses;
            for (const u of this.units) {
              if (!u.alive || u.side !== SIDE_ATT || dist(u.x, u.y, s.x, s.y) > s.radius) continue;
              const h = u.hero ? (d.totalHealingOnHeroes / d.numberOfPulses) : d.healingPerPulse;
              u.hp = Math.min(u.maxHp, u.hp + h);
            }
          }
          break;
        case 'poison-spell': {
          const elapsed = this.t - s.start, dur = s.until - s.start;
          const ramp = Math.min(1, 0.3 + elapsed / (dur * 0.4));
          for (const u of this.units) {
            if (!u.alive || u.side !== SIDE_DEF || dist(u.x, u.y, s.x, s.y) > s.radius) continue;
            this.damageUnit(u, d.maxDamagePerSecond * ramp * dt, 'poison');
            u.poisonUntil = this.t + 0.2; u.poisonSlow = (d.speedDecrease ?? 0) / 100; u.poisonAtk = (d.attackRateDecrease ?? 0) / 100;
          }
          break;
        }
        case 'freeze-spell':
          for (const b of this.structures) if (b.alive && dist(b.cx, b.cy, s.x, s.y) <= s.radius + b.w / 2 - 0.5) b.frozenUntil = s.until;
          for (const u of this.units) if (u.alive && u.side === SIDE_DEF && dist(u.x, u.y, s.x, s.y) <= s.radius) u.frozenUntil = s.until;
          break;
        case 'invisibility-spell':
          for (const u of this.units) if (u.alive && u.side === SIDE_ATT && dist(u.x, u.y, s.x, s.y) <= s.radius) u.invisibleUntil = this.t + 0.3;
          break;
      }
    }
  }

  // ------------------------------------------------------------------ clan castle
  private triggerCC() {
    if (this.ccTriggered) return;
    this.ccTriggered = true;
    this.ccNextRelease = this.t;
    this.log.push(`${this.t.toFixed(1)}s enemy CC triggered`);
  }

  private updateCC() {
    const cc = this.ccBuilding;
    if (!cc) return;
    if (!this.ccTriggered && cc.alive) {
      const r = (DATA.buildings['clan-castle'].triggerRadius ?? 12) * T.ccTriggerScale;
      for (const u of this.units) if (u.alive && u.side === SIDE_ATT && dist(u.x, u.y, cc.cx, cc.cy) <= r) { this.triggerCC(); break; }
    }
    while (this.ccTriggered && this.ccQueue.length && this.t >= this.ccNextRelease) {
      const t = this.ccQueue.shift()!;
      const u = this.spawnTroop(DATA.ccTroops[t], SIDE_DEF, cc.cx + this.rng.range(-0.5, 0.5), cc.y + cc.h + 0.3);
      u.homeX = cc.cx; u.homeY = cc.cy;
      this.ccNextRelease += T.ccReleaseInterval;
    }
  }

  // ------------------------------------------------------------------ units
  private speed(u: Unit): number {
    let pts = u.speedPts;
    if (u.rageUntil > this.t) pts += u.rageSpeed;
    if (u.eqUntil > this.t) pts += u.eqSpeed;
    if (u.hasteUntil > this.t) pts += u.hasteSpeed;
    let v = pts / T.speedDivisor;
    if (u.slowUntil > this.t) v *= 1 - u.slowFactor;
    if (u.poisonUntil > this.t) v *= 1 - u.poisonSlow;
    return v;
  }

  private dmgMul(u: Unit): number {
    let m = 1;
    if (u.rageUntil > this.t) m += u.rageDmg;
    if (u.eqUntil > this.t) m += u.eqDmg;
    return m;
  }

  private canTarget(u: Unit, v: Unit): boolean {
    if (!v.alive || v.side === u.side) return false;
    if (v.invisibleUntil > this.t) return false;
    if (v.air) return u.canHit !== 'ground';
    return u.canHit !== 'air';
  }

  private validBuildingTarget(u: Unit, b: Building | undefined): boolean {
    if (!b || !b.alive) return false;
    if (b.hidden) return false;
    if (u.pref === 'defense' && !b.isDefense && this.hasAlive((x) => x.isDefense && !x.hidden, 'def')) return false;
    return true;
  }

  private hasAliveCache = new Map<string, { t: number; v: boolean }>();
  private hasAlive(pred: (b: Building) => boolean, key: string): boolean {
    const c = this.hasAliveCache.get(key);
    if (c && c.t === this.t) return c.v;
    const v = this.structures.some((b) => b.alive && pred(b));
    this.hasAliveCache.set(key, { t: this.t, v });
    return v;
  }

  private chooseBuilding(u: Unit): Building | null {
    if (u.pref === 'defense') {
      const d = this.nearestStructure(u.x, u.y, (b) => b.isDefense && !b.hidden);
      if (d) return d;
    } else if (u.pref === 'resource') {
      const d = this.nearestStructure(u.x, u.y, (b) => b.isResource);
      if (d) return d;
    }
    return this.nearestStructure(u.x, u.y, (b) => !b.hidden);
  }

  private field(b: Building, reach: number, jump: boolean, fromX: number, fromY: number): Float32Array {
    const key = `${b.uid}|${Math.round(reach * 4)}|${jump ? 1 : 0}`;
    const c = this.fields.get(key);
    const cell = Math.floor(fromY) * N + Math.floor(fromX);
    // Fields may lag the terrain by up to `fieldStaleness` seconds (troops react to a
    // newly opened gap with a short delay in game too); this keeps pathing cheap.
    // They are also only expanded as far as the troops using them need.
    const fresh = c && (c.v === this.grid.version || this.t - c.at < T.fieldStaleness);
    if (fresh && (c!.f[cell] !== Infinity || c!.limit === Infinity)) return c!.f;
    const need = distToRect(fromX, fromY, b.rect) * 1.6 + (jump ? 8 : 35);
    const prev = c?.limit ?? 0;
    const limit = fresh ? (prev * 2 > 120 ? Infinity : Math.max(need, prev * 2)) : Math.max(need, prev);
    const f = computeField(this.grid, b.rect, reach, jump, c?.f, limit);
    if (c) { c.v = this.grid.version; c.at = this.t; c.limit = limit; } else this.fields.set(key, { v: this.grid.version, at: this.t, f, limit });
    return f;
  }

  private moveToward(u: Unit, tx: number, ty: number, dt: number, stopAt = 0) {
    const d = dist(u.x, u.y, tx, ty);
    if (d <= stopAt + 1e-6) return;
    const step = Math.min(d - stopAt, this.speed(u) * dt);
    u.x += ((tx - u.x) / d) * step;
    u.y += ((ty - u.y) / d) * step;
  }

  private inReach(u: Unit, b: Building): boolean {
    return distToRect(u.x, u.y, b.rect) <= u.range + T.meleeReach;
  }

  private updateUnit(u: Unit, dt: number) {
    if (u.lifeUntil <= this.t) { u.alive = false; u.diedAt = this.t; return; }
    if (u.selfHealUntil > this.t) u.hp = Math.min(u.maxHp, u.hp + u.selfHeal * dt);
    if (u.frozenUntil > this.t) return;
    u.cooldown -= dt;
    if (u.type === 'healer') return this.updateHealer(u, dt);
    if (u.side === SIDE_DEF) return this.updateDefender(u, dt);
    if (u.type === 'wall-breaker') return this.updateWallBreaker(u, dt);

    // Engage defending troops that come close (non-preferred troops only).
    if (!u.ignoresUnits || (u.pref === 'defense' && !this.hasAlive((b) => b.isDefense && !b.hidden, 'def'))) {
      const cur = u.tgtU >= 0 ? this.unitByUid(u.tgtU) : null;
      if (!cur || !this.canTarget(u, cur) || dist(u.x, u.y, cur.x, cur.y) > u.range + T.aggroRadius + 2) {
        u.tgtU = -1;
        let best: Unit | null = null, bd = u.range + T.aggroRadius;
        for (const v of this.units) {
          if (v.side !== SIDE_DEF || !this.canTarget(u, v)) continue;
          const d = dist(u.x, u.y, v.x, v.y);
          if (d < bd) { bd = d; best = v; }
        }
        if (best) u.tgtU = best.uid;
      }
    }
    if (u.tgtU >= 0) {
      const v = this.unitByUid(u.tgtU)!;
      const d = dist(u.x, u.y, v.x, v.y);
      if (d <= u.range + 0.3) this.unitAttack(u, null, v);
      else this.chase(u, v.x, v.y, dt);
      return;
    }

    let b = u.tgtB >= 0 ? this.buildings[u.tgtB] : undefined;
    if (u.wallTarget >= 0) {
      const w = this.buildings[u.wallTarget];
      if (w.alive && this.inReach(u, w)) { this.unitAttack(u, w, null); return; }
      u.wallTarget = -1;
    }
    if (!this.validBuildingTarget(u, b) || b!.isWall) {
      const hadTarget = u.tgtB >= 0;
      b = this.chooseBuilding(u) ?? undefined;
      u.tgtB = b ? b.uid : -1;
      // Troops pause briefly to pick a new target after finishing one.
      if (hadTarget && b) u.idleUntil = this.t + T.retargetDelay;
    }
    if (!b || u.idleUntil > this.t) return;
    if (this.inReach(u, b)) { this.unitAttack(u, b, null); return; }
    this.moveTo(u, b, dt);
  }

  private chase(u: Unit, tx: number, ty: number, dt: number) {
    if (u.air || u.side === SIDE_DEF) { this.moveToward(u, tx, ty, dt); return; }
    const ox = u.x, oy = u.y;
    this.moveToward(u, tx, ty, dt);
    const k = Math.floor(u.y) * N + Math.floor(u.x);
    if (this.grid.blocked[k] || (this.grid.wallHp[k] > 0 && !u.jumper)) { u.x = ox; u.y = oy; u.tgtU = -1; }
  }

  private moveTo(u: Unit, b: Building, dt: number) {
    if (u.air) {
      // fly straight to the closest point of the hit box
      const px = Math.max(b.rect.x0, Math.min(u.x, b.rect.x1)), py = Math.max(b.rect.y0, Math.min(u.y, b.rect.y1));
      this.moveToward(u, px, py, dt, u.range + T.meleeReach * 0.9);
      return;
    }
    const reach = u.range + T.meleeReach;
    const f = this.field(b, reach, u.jumper, u.x, u.y);
    const cx = Math.floor(u.x), cy = Math.floor(u.y);
    const here = f[cy * N + cx];
    if (here === Infinity) {
      // unreachable (or standing on a blocked tile after a push) – walk straight
      this.moveToward(u, b.cx, b.cy, dt);
      return;
    }
    const nx = nextCell(this.grid, f, cx, cy);
    if (nx < 0) {
      const px = Math.max(b.rect.x0, Math.min(u.x, b.rect.x1)), py = Math.max(b.rect.y0, Math.min(u.y, b.rect.y1));
      this.moveToward(u, px, py, dt, u.range + T.meleeReach * 0.9);
      return;
    }
    if (!u.jumper && this.grid.wallHp[nx] > 0) {
      // Path goes through a wall: attack it.
      u.wallTarget = this.wallAt[nx];
      const w = this.buildings[u.wallTarget];
      if (this.inReach(u, w)) this.unitAttack(u, w, null);
      else this.moveToward(u, w.cx, w.cy, dt, u.range + T.meleeReach * 0.9);
      return;
    }
    this.moveToward(u, (nx % N) + 0.5, ((nx / N) | 0) + 0.5, dt);
  }

  private unitByUid(uid: number): Unit | null {
    // units array is append-only except for periodic compaction; binary search on uid
    const arr = this.units;
    let lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = arr[mid].uid;
      if (v === uid) return arr[mid];
      if (v < uid) lo = mid + 1; else hi = mid - 1;
    }
    return null;
  }

  private unitAttack(u: Unit, b: Building | null, v: Unit | null) {
    if (u.cooldown > 0) return;
    let atk = u.attackSpeed;
    if (u.eqUntil > this.t && u.eqAtkSpeed) atk /= 1 + u.eqAtkSpeed;
    if (u.poisonUntil > this.t) atk /= Math.max(0.1, 1 - u.poisonAtk);
    u.cooldown += atk;
    if (u.cooldown < 0) u.cooldown = 0;
    let dmg = u.dmgPerShot * this.dmgMul(u);
    if (u.invisibleUntil > this.t && u.invisBonus) dmg += u.invisBonus;
    if (u.monolith) dmg *= 1 + u.monolith;
    const tx = b ? Math.max(b.rect.x0, Math.min(u.x, b.rect.x1)) : v!.x;
    const ty = b ? Math.max(b.rect.y0, Math.min(u.y, b.rect.y1)) : v!.y;
    if (this.opts.record) this.shots.push([u.x, u.y, tx, ty]);
    const gauntlet = u.splashUntil > this.t;
    const splash = gauntlet ? u.splashBoost : u.splash;
    if (b) {
      let bd = dmg;
      if (u.pref === 'resource' && b.isResource) bd *= T.goblinResourceMultiplier;
      this.damageBuilding(b, bd, u);
    }
    if (v) {
      this.damageUnit(v, dmg, u.type);
      if (u.frozenArrow) { v.slowUntil = this.t + 1.75; v.slowFactor = 0.45; }
    }
    if (splash > 0) {
      const cx = u.type === 'valkyrie' || gauntlet ? u.x : tx, cy = u.type === 'valkyrie' || gauntlet ? u.y : ty;
      for (const o of this.buildings) {
        if (!o.alive || o === b) continue;
        if (Math.abs(o.cx - cx) > splash + 3 || Math.abs(o.cy - cy) > splash + 3) continue;
        if (distToRect(cx, cy, o.rect) <= splash) this.damageBuilding(o, dmg, u);
      }
      for (const o of this.units) {
        if (o === v || !o.alive || o.side === u.side) continue;
        if (o.air ? u.canHit === 'ground' : u.canHit === 'air') continue;
        if (dist(o.x, o.y, cx, cy) <= splash) this.damageUnit(o, dmg, u.type);
      }
    }
  }

  private updateWallBreaker(u: Unit, dt: number) {
    // Target: the first wall on the route to the nearest building; else nearest wall; else buildings.
    let w = u.wallTarget >= 0 ? this.buildings[u.wallTarget] : undefined;
    if (!w || !w.alive) {
      u.wallTarget = -1;
      const b = this.nearestStructure(u.x, u.y, (x) => !x.hidden);
      if (b) {
        const f = this.field(b, 0.5 + T.meleeReach, false, u.x, u.y);
        let cx = Math.floor(u.x), cy = Math.floor(u.y);
        for (let i = 0; i < 80; i++) {
          const nx = nextCell(this.grid, f, cx, cy);
          if (nx < 0) break;
          if (this.grid.wallHp[nx] > 0) { u.wallTarget = this.wallAt[nx]; break; }
          cx = nx % N; cy = (nx / N) | 0;
        }
      }
      if (u.wallTarget < 0) {
        let bd = 8;
        for (const o of this.buildings) {
          if (!o.alive || !o.isWall) continue;
          const d = dist(o.cx, o.cy, u.x, u.y);
          if (d < bd) { bd = d; u.wallTarget = o.uid; }
        }
      }
      w = u.wallTarget >= 0 ? this.buildings[u.wallTarget] : undefined;
    }
    if (!w) {
      // No walls around: behaves like a weak melee troop on the nearest building.
      const b = this.nearestStructure(u.x, u.y, (x) => !x.hidden);
      if (!b) return;
      if (this.inReach(u, b)) this.explodeWallBreaker(u, b.cx, b.cy);
      else this.moveTo(u, b, dt);
      return;
    }
    if (distToRect(u.x, u.y, w.rect) <= u.range * 0.5 + 0.3) { this.explodeWallBreaker(u, w.cx, w.cy); return; }
    // walk the path toward the wall (walls are the goal)
    const f = this.field(w, 0.3, true, u.x, u.y);
    const cx = Math.floor(u.x), cy = Math.floor(u.y);
    const nx = nextCell(this.grid, f, cx, cy);
    if (nx < 0) this.moveToward(u, w.cx, w.cy, dt);
    else if (this.grid.wallHp[nx] > 0 && nx !== w.y * N + w.x) { this.explodeWallBreaker(u, (nx % N) + 0.5, ((nx / N) | 0) + 0.5); }
    else this.moveToward(u, (nx % N) + 0.5, ((nx / N) | 0) + 0.5, dt);
  }

  private explodeWallBreaker(u: Unit, x: number, y: number) {
    const r = T.wallBreakerRadius;
    const base = u.dmgPerShot * this.dmgMul(u);
    for (const o of this.buildings) {
      if (!o.alive) continue;
      if (Math.abs(o.cx - x) > r + 2 || Math.abs(o.cy - y) > r + 2) continue;
      if (distToRect(x, y, o.rect) <= r) this.damageBuilding(o, o.isWall ? base * T.wallBreakerWallMultiplier : base, u);
    }
    u.deathDamage = 0;
    u.alive = false;
    u.hp = 0;
    u.diedAt = this.t;
  }

  private updateHealer(u: Unit, dt: number) {
    if (u.side !== SIDE_ATT) return;
    let tgt = u.tgtU >= 0 ? this.unitByUid(u.tgtU) : null;
    if (!tgt || !tgt.alive || tgt.air || (u.rescan -= dt) <= 0) {
      u.rescan = 1;
      let best: Unit | null = null, bs = Infinity;
      for (const v of this.units) {
        if (!v.alive || v.side !== SIDE_ATT || v.air) continue;
        const s = dist(u.x, u.y, v.x, v.y) + (v.hp / v.maxHp) * 6 + (v.hero ? 2 : 0);
        if (s < bs) { bs = s; best = v; }
      }
      tgt = best;
      u.tgtU = best ? best.uid : -1;
    }
    if (!tgt) return;
    const d = dist(u.x, u.y, tgt.x, tgt.y);
    if (d > u.range) { this.moveToward(u, tgt.x, tgt.y, dt, u.range * 0.8); return; }
    if (u.cooldown > 0) return;
    u.cooldown += u.attackSpeed;
    for (const v of this.units) {
      if (!v.alive || v.side !== SIDE_ATT || v.air || dist(v.x, v.y, tgt.x, tgt.y) > 2) continue;
      v.hp = Math.min(v.maxHp, v.hp + (v.hero ? u.healHeroPerSec : u.healPerSec) * u.attackSpeed);
    }
  }

  private updateDefender(u: Unit, dt: number) {
    let tgt = u.tgtU >= 0 ? this.unitByUid(u.tgtU) : null;
    const leashOk = (v: Unit) => u.leash === Infinity || dist(v.x, v.y, u.homeX, u.homeY) <= u.leash;
    if (!tgt || !this.canTarget(u, tgt) || !leashOk(tgt) || (u.rescan -= dt) <= 0) {
      u.rescan = 0.5;
      let best: Unit | null = null, bd = Infinity;
      for (const v of this.units) {
        if (v.side !== SIDE_ATT || !this.canTarget(u, v) || !leashOk(v)) continue;
        const d = dist(u.x, u.y, v.x, v.y);
        if (d < bd) { bd = d; best = v; }
      }
      tgt = best;
      u.tgtU = best ? best.uid : -1;
    }
    if (!tgt) {
      if (u.hero) this.moveToward(u, u.homeX, u.homeY, dt);
      return;
    }
    const d = dist(u.x, u.y, tgt.x, tgt.y);
    if (d <= u.range + 0.3) this.unitAttack(u, null, tgt);
    else this.moveToward(u, tgt.x, tgt.y, dt, u.range * 0.9);
  }

  // ------------------------------------------------------------------ defenses
  private updateDefense(b: Building, dt: number) {
    const a = b.attack!;
    if (b.hidden) {
      const tr = a.triggerRange ?? 6;
      for (const u of this.units) if (u.alive && u.side === SIDE_ATT && dist(u.x, u.y, b.cx, b.cy) <= tr) { b.hidden = false; break; }
      if (b.hidden) return;
    }
    if (b.frozenUntil > this.t) return;
    b.cooldown -= dt;
    if (b.type === 'air-sweeper') return this.updateSweeper(b);
    const hitsAir = a.targetType !== 'ground', hitsGround = a.targetType !== 'air';
    const ok = (u: Unit) => u.alive && u.side === SIDE_ATT && u.invisibleUntil <= this.t && (u.air ? hitsAir : hitsGround);
    let tgt = b.target >= 0 ? this.unitByUid(b.target) : null;
    if (tgt) {
      const d = dist(tgt.x, tgt.y, b.cx, b.cy);
      if (!ok(tgt) || d > a.range || d < b.minRange) tgt = null;
    }
    if (!tgt) {
      let bd = Infinity;
      for (const u of this.units) {
        if (!ok(u)) continue;
        const d = dist(u.x, u.y, b.cx, b.cy);
        if (d > a.range || d < b.minRange) continue;
        if (d < bd) { bd = d; tgt = u; }
      }
      b.target = tgt ? tgt.uid : -1;
      if (!tgt) { if (b.cooldown < 0) b.cooldown = 0; return; }
    }
    if (b.cooldown > 0) return;
    b.cooldown += a.attackSpeed;
    if (b.cooldown < 0) b.cooldown = 0;
    if (this.opts.record) this.shots.push([b.cx, b.cy, tgt.x, tgt.y]);
    const dmg = a.damagePerShot;
    if (b.type === 'mortar' || b.type === 'bomb-tower') {
      const ft = b.type === 'mortar' ? T.mortarFlightTime : T.bombTowerFlightTime;
      this.projectiles.push({ x: tgt.x, y: tgt.y, t: this.t + ft, dmg, radius: a.splashRadius, hits: 'ground', src: b.uid });
    } else if (a.damageType === 'splash') {
      for (const u of this.units) {
        if (!ok(u)) continue;
        if (dist(u.x, u.y, tgt.x, tgt.y) <= a.splashRadius) this.hitUnit(b, u, dmg);
      }
    } else this.hitUnit(b, tgt, dmg);
  }

  private hitUnit(b: Building, u: Unit, dmg: number) {
    const before = u.hp;
    this.damageUnit(u, dmg, b.type);
    b.damageDealt += Math.min(before, dmg);
    if (!u.alive) b.kills++;
  }

  private updateSweeper(b: Building) {
    const a = b.attack!;
    if (b.cooldown > 0) return;
    const inCone = (u: Unit) => {
      if (!u.alive || u.side !== SIDE_ATT || !u.air) return false;
      const d = dist(u.x, u.y, b.cx, b.cy);
      if (d > a.range || d < b.minRange) return false;
      let ang = Math.atan2(u.y - b.cy, u.x - b.cx) - b.facing;
      ang = Math.atan2(Math.sin(ang), Math.cos(ang));
      return Math.abs(ang) <= AIR_SWEEPER_HALF_ANGLE;
    };
    const targets = this.units.filter(inCone);
    if (!targets.length) { if (b.cooldown < 0) b.cooldown = 0; return; }
    b.cooldown += a.attackSpeed;
    const push = a.pushStrength ?? 2;
    for (const u of targets) {
      const d = Math.max(0.5, dist(u.x, u.y, b.cx, b.cy));
      u.x = Math.min(N, Math.max(0, u.x + ((u.x - b.cx) / d) * push));
      u.y = Math.min(N, Math.max(0, u.y + ((u.y - b.cy) / d) * push));
    }
    if (this.opts.record) this.shots.push([b.cx, b.cy, b.cx + Math.cos(b.facing) * 4, b.cy + Math.sin(b.facing) * 4]);
  }

  private updateProjectiles() {
    if (!this.projectiles.length) return;
    const keep: Projectile[] = [];
    for (const p of this.projectiles) {
      if (p.t > this.t) { keep.push(p); continue; }
      const src = this.buildings[p.src];
      for (const u of this.units) {
        if (!u.alive || u.side !== SIDE_ATT) continue;
        if (u.air ? p.hits === 'ground' : p.hits === 'air') continue;
        if (dist(u.x, u.y, p.x, p.y) <= p.radius) {
          if (src && !src.isWall) this.hitUnit(src, u, p.dmg); else this.damageUnit(u, p.dmg, 'projectile');
        }
      }
    }
    this.projectiles = keep;
  }

  // ------------------------------------------------------------------ traps
  private updateTraps() {
    for (const tr of this.traps) {
      if (tr.done) continue;
      const d = DATA.traps[tr.type];
      const hits = (u: Unit) => u.alive && u.side === SIDE_ATT && (d.targetType === 'both' || (d.targetType === 'air') === u.air);
      if (tr.armedAt < 0) {
        for (const u of this.units) {
          if (!hits(u)) continue;
          if (dist(u.x, u.y, tr.cx, tr.cy) <= d.triggerRadius) {
            tr.armedAt = this.t;
            tr.trig = u.uid;
            break;
          }
        }
        if (tr.armedAt < 0) continue;
      }
      if (this.t - tr.armedAt < T.trapDelay && tr.type !== 'spring-trap') continue;
      tr.done = true;
      this.log.push(`${this.t.toFixed(1)}s ${tr.type} triggered`);
      switch (tr.type) {
        case 'spring-trap': {
          let cap = d.springCapacity ?? 0;
          for (const u of this.units) {
            if (!hits(u) || u.hero || u.air || dist(u.x, u.y, tr.cx, tr.cy) > 1.2) continue;
            if (u.housing <= 0 || u.housing > cap) continue;
            cap -= u.housing;
            this.killUnit(u, 'spring-trap');
          }
          break;
        }
        case 'seeking-air-mine': {
          let tgt = this.unitByUid(tr.trig);
          if (!tgt || !tgt.alive) tgt = this.units.find((u) => hits(u) && dist(u.x, u.y, tr.cx, tr.cy) <= d.triggerRadius) ?? null;
          if (tgt) this.damageUnit(tgt, d.damage, 'seeking-air-mine');
          break;
        }
        case 'skeleton-trap': {
          for (let i = 0; i < (d.spawnedUnits ?? 2); i++) this.spawnSimple('skeleton', SIDE_DEF, tr.cx + this.rng.range(-0.5, 0.5), tr.cy + this.rng.range(-0.5, 0.5), SKELETON);
          break;
        }
        default:
          for (const u of this.units) if (hits(u) && dist(u.x, u.y, tr.cx, tr.cy) <= d.damageRadius) this.damageUnit(u, d.damage, tr.type);
      }
    }
  }
}
