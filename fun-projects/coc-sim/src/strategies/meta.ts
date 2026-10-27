// TH8 meta attack strategies (war), encoded as deployment plans.
//
// Sources for the compositions/sequencing: 2025-2026 TH8 guides (GoVaHo, GoHo, Mass
// Dragons + Lightning ranked top-3 in Oct-2025 lists; GoWiPe still the most common TH8
// war attack per 2026 base guides), adapted to the current TH8 caps in data/th8.json:
// 200 housing, 6 spell space + 1 dark, CC 25 + 1 spell, ONE hero slot.
// Each plan aims at the base via `p.angle`; the optimizer searches angle/spread/timing.
import type { Building, Sim } from '../engine/sim.ts';
import {
  type Strategy, type StrategyParams, type ScriptController, type Geometry,
  drop, jt, jit, healRule, rageRule, poisonRule, heroAbilityRule, heroSpec, attackersOf, cluster,
} from './common.ts';

const deg = (d: number) => d / 360;

function heroAt(s: ScriptController, sim: Sim, p: StrategyParams, t: number, pt: [number, number]) {
  s.at(jt(sim, p, t), (sm) => { const [x, y] = jit(sm, p, pt); sm.deployHero(p.hero, x, y); });
}

function ccAt(s: ScriptController, sim: Sim, p: StrategyParams, t: number, pt: [number, number]) {
  s.at(jt(sim, p, t), (sm) => { const [x, y] = jit(sm, p, pt); sm.deployCC(x, y); });
}

/** Which Air Defense to zap: the one closest to the attack's entry (default) or the most central. */
function zapTarget(geo: Geometry, p: StrategyParams): Building | undefined {
  const ads = geo.structures('air-defense');
  if (!ads.length) return undefined;
  const [ex, ey] = geo.edge(p.angle);
  if (p.extra?.zap === 'central') return geo.byDistance(ads, geo.cx, geo.cy)[0];
  if (p.extra?.zap === 'far') return geo.byDistance(ads, ex, ey).at(-1);
  return geo.byDistance(ads, ex, ey)[0];
}

function zap(s: ScriptController, sim: Sim, geo: Geometry, p: StrategyParams, count: number, withEq: boolean, ccSpell: boolean) {
  const ad = zapTarget(geo, p);
  if (!ad) return;
  for (let i = 0; i < count; i++) s.at(0.2 + i * 0.25, (sm) => sm.cast('lightning-spell', ad.cx, ad.cy));
  if (withEq) s.at(0.1, (sm) => sm.cast('earthquake-spell', ad.cx, ad.cy));
  if (ccSpell) s.at(0.2 + count * 0.25, (sm) => { if (ad.alive) sm.cast('lightning-spell', ad.cx, ad.cy, true); });
}

// ------------------------------------------------------------------ GoWiPe
export const GoWiPe: Strategy = {
  id: 'gowipe', name: 'GoWiPe (Golem/Wizard/PEKKA)', kind: 'ground',
  description: '2 Golems tank one side, Wall Breakers open the core, PEKKAs + Wizards smash through behind them; wizards funnel the flanks.',
  army: (p) => ({
    troops: { golem: 2, pekka: 2, wizard: 14, 'wall-breaker': 8, archer: 18 },
    spells: { 'rage-spell': 2, 'healing-spell': 1, 'poison-spell': 1 },
    cc: { troops: { pekka: 1 }, spells: { 'freeze-spell': 1 } },
    heroes: heroSpec(p),
  }),
  plan(s, sim, geo, p) {
    const a = p.angle, w = 4 * p.spread;
    const E = geo.edge(a);
    drop(s, sim, p, 'golem', 2, [geo.edge(a, -1.5), geo.edge(a, 1.5)], 0, 0.4);
    // funnel: wizards + archers clear the outer buildings either side of the entry
    drop(s, sim, p, 'wizard', 4, [geo.edge(a + deg(38) * p.spread), geo.edge(a - deg(38) * p.spread)], 2);
    drop(s, sim, p, 'archer', 8, [geo.edge(a + deg(38) * p.spread), geo.edge(a - deg(38) * p.spread)], 2.5);
    drop(s, sim, p, 'wall-breaker', 4, [E], 6, 0.15);
    drop(s, sim, p, 'wall-breaker', 4, [E], 10, 0.15);
    drop(s, sim, p, 'pekka', 2, geo.line(a, 2, w), 8, 0.5);
    heroAt(s, sim, p, 8.5, E);
    ccAt(s, sim, p, 9, E);
    drop(s, sim, p, 'wizard', 10, geo.line(a, 5, w * 1.5), 11, 0.2);
    drop(s, sim, p, 'archer', 10, geo.line(a, 5, w * 2), 13, 0.15);
    poisonRule(s);
    rageRule(s, ['wizard', 'pekka', 'barbarian-king', 'archer-queen'], 5, 6, 12);
    healRule(s, ['wizard', 'pekka', 'golem'], 5, 0.55);
    heroAbilityRule(s);
    s.rule((sm) => {
      if (!sm.remaining.ccSpells['freeze-spell']) return true;
      const th = geo.th();
      const c = cluster(attackersOf(sm, ['pekka', 'wizard']), 4);
      if (th && th.alive && c && c[2] >= 4 && Math.hypot(c[0] - th.cx, c[1] - th.cy) < 7) {
        const def = sm.structures.filter((b) => b.alive && b.isDefense && Math.hypot(b.cx - c[0], b.cy - c[1]) < 7);
        if (def.length >= 2) { sm.cast('freeze-spell', def[0].cx, def[0].cy, true); return true; }
      }
    });
  },
};

// ------------------------------------------------------------------ GoHo
export const GoHo: Strategy = {
  id: 'goho', name: 'GoHo (Golem + Hog Riders)', kind: 'ground',
  description: 'Golem + Wizards + hero kill squad takes the CC side and kills CC troops (poison), then two hog waves clear the defenses with reactive heals.',
  army: (p) => ({
    troops: { golem: 1, 'hog-rider': 26, wizard: 6, 'wall-breaker': 4, archer: 8 },
    spells: { 'healing-spell': 3, 'poison-spell': 1 },
    cc: { troops: { 'hog-rider': 5 }, spells: { 'poison-spell': 1 } },
    heroes: heroSpec(p),
  }),
  plan(s, sim, geo, p) {
    const cc = geo.cc();
    const a = p.extra?.followCC === false || !cc ? p.angle : geo.angleOf(cc.cx, cc.cy) + (p.angle % 0.125) - 0.0625;
    const E = geo.edge(a);
    drop(s, sim, p, 'golem', 1, [E], 0);
    drop(s, sim, p, 'wall-breaker', 4, [E], 3, 0.15);
    drop(s, sim, p, 'wizard', 6, geo.line(a, 3, 4 * p.spread), 4, 0.2);
    drop(s, sim, p, 'archer', 8, geo.line(a, 4, 6 * p.spread), 5, 0.1);
    heroAt(s, sim, p, 4.5, E);
    poisonRule(s);
    s.rule((sm) => {
      if (!sm.remaining.ccSpells['poison-spell']) return true;
      const d = sm.units.filter((u) => u.alive && u.side === 1 && !u.hero);
      if (sm.ccTriggered && d.length >= 2 && !sm.remaining.spells['poison-spell']) {
        const c = cluster(d, 3);
        if (c) { sm.cast('poison-spell', c[0], c[1], true); return true; }
      }
    });
    // Hogs go in once CC is dealt with (or after a timeout), from both sides of the kill squad.
    let sent = false;
    s.rule((sm) => {
      if (sent) return true;
      const dLeft = sm.units.filter((u) => u.alive && u.side === 1 && !u.hero).length;
      if ((sm.ccTriggered && dLeft === 0 && sm.t > 12) || sm.t > 26 * p.timing) {
        sent = true;
        const g1 = geo.line(a + deg(70) * p.spread, 3, 3), g2 = geo.line(a - deg(70) * p.spread, 3, 3);
        for (let i = 0; i < 13; i++) {
          s.at(sm.t + 0.1 * i, (x) => { const [px, py] = jit(x, p, g1[i % 3]); x.deploy('hog-rider', px, py); });
          s.at(sm.t + 1.2 + 0.1 * i, (x) => { const [px, py] = jit(x, p, g2[i % 3]); x.deploy('hog-rider', px, py); });
        }
        s.at(sm.t + 2.8, (x) => { const [px, py] = jit(x, p, g2[1]); x.deployCC(px, py); });
        return true;
      }
    });
    s.at(60, () => {}); // keep the script alive until the hog trigger has fired
    healRule(s, ['hog-rider'], 5, 0.7, 3);
    heroAbilityRule(s);
  },
};

// ------------------------------------------------------------------ GoVaHo
export const GoVaHo: Strategy = {
  id: 'govaho', name: 'GoVaHo (Golem/Valkyrie/Hog)', kind: 'ground',
  description: 'Golem tanks while Valkyries + Wizards smash the core behind Wall Breakers; Hogs take the outer defenses on the opposite flank.',
  army: (p) => ({
    troops: { golem: 1, valkyrie: 6, 'hog-rider': 14, wizard: 6, 'wall-breaker': 6, archer: 16 },
    spells: { 'rage-spell': 1, 'healing-spell': 2, 'poison-spell': 1 },
    cc: { troops: { valkyrie: 3, archer: 1 }, spells: { 'freeze-spell': 1 } },
    heroes: heroSpec(p),
  }),
  plan(s, sim, geo, p) {
    const a = p.angle;
    const E = geo.edge(a);
    drop(s, sim, p, 'golem', 1, [E], 0);
    drop(s, sim, p, 'wizard', 2, [geo.edge(a + deg(35) * p.spread), geo.edge(a - deg(35) * p.spread)], 1.5);
    drop(s, sim, p, 'archer', 8, [geo.edge(a + deg(35) * p.spread), geo.edge(a - deg(35) * p.spread)], 2);
    drop(s, sim, p, 'wall-breaker', 3, [E], 5, 0.15);
    drop(s, sim, p, 'wall-breaker', 3, [E], 8, 0.15);
    drop(s, sim, p, 'valkyrie', 6, geo.line(a, 3, 3 * p.spread), 7, 0.2);
    ccAt(s, sim, p, 7.5, E);
    heroAt(s, sim, p, 8, E);
    drop(s, sim, p, 'wizard', 4, geo.line(a, 4, 5 * p.spread), 9, 0.2);
    drop(s, sim, p, 'archer', 8, geo.line(a, 4, 6 * p.spread), 10, 0.1);
    drop(s, sim, p, 'hog-rider', 14, geo.line(a + 0.5 + deg(20), 3, 4 * p.spread), 16, 0.1);
    poisonRule(s);
    rageRule(s, ['valkyrie', 'wizard'], 4, 6, 10);
    healRule(s, ['hog-rider'], 5, 0.65, 3);
    healRule(s, ['valkyrie'], 4, 0.5, 5);
    heroAbilityRule(s);
    s.rule((sm) => {
      if (!sm.remaining.ccSpells['freeze-spell']) return true;
      const c = cluster(attackersOf(sm, ['valkyrie']), 3);
      if (c && c[2] >= 3) {
        const d = sm.structures.filter((b) => b.alive && b.isDefense && b.attack?.damageType === 'splash' && Math.hypot(b.cx - c[0], b.cy - c[1]) < 7);
        if (d.length) { sm.cast('freeze-spell', d[0].cx, d[0].cy, true); return true; }
      }
    });
  },
};

// ------------------------------------------------------------------ Mass Dragons
export const MassDragon: Strategy = {
  id: 'mass-dragon', name: 'Mass Dragons + Lightning', kind: 'air',
  description: '4 Lightning + Earthquake + CC Lightning delete one Air Defense, then 10 Dragons in a wide line with flank dragons funnelling; Rage on the core.',
  army: (p) => ({
    troops: { dragon: 10 },
    spells: { 'lightning-spell': 4, 'rage-spell': 1, 'earthquake-spell': 1 },
    cc: { troops: { dragon: 1, balloon: 1 }, spells: { 'lightning-spell': 1 } },
    heroes: heroSpec({ ...p, hero: p.hero }),
  }),
  plan(s, sim, geo, p) {
    const a = p.angle;
    zap(s, sim, geo, p, 4, true, true);
    drop(s, sim, p, 'dragon', 1, [geo.edge(a + deg(40) * p.spread)], 2);
    drop(s, sim, p, 'dragon', 1, [geo.edge(a - deg(40) * p.spread)], 2.2);
    drop(s, sim, p, 'dragon', 8, geo.line(a, 8, 14 * p.spread), 4, 0.2);
    ccAt(s, sim, p, 5, geo.edge(a));
    heroAt(s, sim, p, 6, geo.edge(a));
    rageRule(s, ['dragon'], 4, 8, 8);
    heroAbilityRule(s);
  },
};

// ------------------------------------------------------------------ DragLoon
export const DragLoon: Strategy = {
  id: 'dragloon', name: 'DragLoon (Dragons + Balloons)', kind: 'air',
  description: 'Lightning + EQ remove an Air Defense; Dragons lead in a line, Balloons follow behind to pop defenses; Minions clean up.',
  army: (p) => ({
    troops: { dragon: 7, balloon: 10, minion: 5 },
    spells: { 'lightning-spell': 2, 'rage-spell': 2, 'earthquake-spell': 1 },
    cc: { troops: { balloon: 5 }, spells: { 'lightning-spell': 1 } },
    heroes: heroSpec(p),
  }),
  plan(s, sim, geo, p) {
    const a = p.angle;
    // 2 LS + EQ + CC LS: not enough alone for a max AD, so dragons finish it
    zap(s, sim, geo, p, 2, true, true);
    drop(s, sim, p, 'dragon', 7, geo.line(a, 7, 12 * p.spread), 1.5, 0.25);
    drop(s, sim, p, 'balloon', 10, geo.line(a, 5, 8 * p.spread), 7, 0.15);
    ccAt(s, sim, p, 8, geo.edge(a));
    heroAt(s, sim, p, 6, geo.edge(a));
    drop(s, sim, p, 'minion', 5, geo.line(a, 5, 10 * p.spread), 25, 0.1);
    rageRule(s, ['balloon', 'dragon'], 4, 6, 9);
    heroAbilityRule(s);
  },
};

// ------------------------------------------------------------------ Mass Hogs
export const MassHog: Strategy = {
  id: 'mass-hog', name: 'Mass Hogs + Heal', kind: 'ground',
  description: 'One hog lures the CC, wizards + poison kill it, then hogs go in two groups with heals timed on bomb hits.',
  army: (p) => ({
    troops: { 'hog-rider': 36, wizard: 5 },
    spells: { 'healing-spell': 3, 'poison-spell': 1 },
    cc: { troops: { 'hog-rider': 5 }, spells: { 'poison-spell': 1 } },
    heroes: heroSpec(p),
  }),
  plan(s, sim, geo, p) {
    const a = p.angle;
    const cc = geo.cc();
    const lure = cc ? geo.edge(geo.angleOf(cc.cx, cc.cy)) : geo.edge(a);
    drop(s, sim, p, 'hog-rider', 1, [lure], 0);
    drop(s, sim, p, 'wizard', 5, [lure], 6, 0.2);
    heroAt(s, sim, p, 6.5, lure);
    s.rule((sm) => {
      if (!sm.remaining.ccSpells['poison-spell']) return true;
      const d = sm.units.filter((u) => u.alive && u.side === 1 && !u.hero);
      if (sm.ccTriggered && d.length >= 2 && !sm.remaining.spells['poison-spell']) {
        const c = cluster(d, 3);
        if (c) { sm.cast('poison-spell', c[0], c[1], true); return true; }
      }
    });
    poisonRule(s);
    drop(s, sim, p, 'hog-rider', 18, geo.line(a, 3, 5 * p.spread), 18, 0.1);
    drop(s, sim, p, 'hog-rider', 17, geo.line(a + deg(90) * p.spread, 3, 5 * p.spread), 20, 0.1);
    ccAt(s, sim, p, 21, geo.edge(a + deg(90) * p.spread));
    healRule(s, ['hog-rider'], 5, 0.7, 3);
    heroAbilityRule(s);
  },
};

// ------------------------------------------------------------------ Balloon + Minion
export const Balloonion: Strategy = {
  id: 'balloonion', name: 'Balloons + Minions', kind: 'air',
  description: 'Balloons in two waves behind an AD snipe, Minions clean the outside; Rage on balloons near the core.',
  army: (p) => ({
    troops: { balloon: 30, minion: 25 },
    spells: { 'lightning-spell': 2, 'rage-spell': 2, 'earthquake-spell': 1 },
    cc: { troops: { balloon: 5 }, spells: { 'lightning-spell': 1 } },
    heroes: heroSpec({ ...p }),
  }),
  plan(s, sim, geo, p) {
    const a = p.angle;
    zap(s, sim, geo, p, 2, true, true);
    drop(s, sim, p, 'balloon', 15, geo.line(a, 5, 10 * p.spread), 1, 0.1);
    drop(s, sim, p, 'balloon', 15, geo.line(a + deg(45) * p.spread, 5, 10 * p.spread), 5, 0.1);
    ccAt(s, sim, p, 5, geo.edge(a));
    heroAt(s, sim, p, 6, geo.edge(a));
    drop(s, sim, p, 'minion', 25, geo.line(a - deg(30), 6, 16 * p.spread), 12, 0.1);
    rageRule(s, ['balloon'], 5, 6, 4);
    heroAbilityRule(s);
  },
};

// ------------------------------------------------------------------ GiWi (baseline)
export const GiWi: Strategy = {
  id: 'giwi', name: 'GiWi (Giants + Wizards)', kind: 'ground',
  description: 'Classic TH8 baseline: Giants tank defenses, Wall Breakers open walls, Wizards follow; heal + rage.',
  army: (p) => ({
    troops: { giant: 14, wizard: 20, 'wall-breaker': 8, archer: 34 },
    spells: { 'rage-spell': 2, 'healing-spell': 1, 'poison-spell': 1 },
    cc: { troops: { valkyrie: 3, archer: 1 }, spells: { 'freeze-spell': 1 } },
    heroes: heroSpec(p),
  }),
  plan(s, sim, geo, p) {
    const a = p.angle;
    drop(s, sim, p, 'giant', 14, geo.line(a, 5, 6 * p.spread), 0, 0.1);
    drop(s, sim, p, 'wall-breaker', 4, [geo.edge(a)], 5, 0.15);
    drop(s, sim, p, 'wall-breaker', 4, [geo.edge(a)], 9, 0.15);
    drop(s, sim, p, 'wizard', 20, geo.line(a, 6, 9 * p.spread), 7, 0.15);
    heroAt(s, sim, p, 7, geo.edge(a));
    ccAt(s, sim, p, 8, geo.edge(a));
    drop(s, sim, p, 'archer', 34, geo.line(a, 8, 14 * p.spread), 10, 0.05);
    poisonRule(s);
    rageRule(s, ['wizard', 'giant'], 6, 6, 10);
    healRule(s, ['giant'], 5, 0.5);
    heroAbilityRule(s);
  },
};

export const STRATEGIES: Strategy[] = [GoWiPe, GoHo, GoVaHo, MassDragon, DragLoon, MassHog, Balloonion, GiWi];
export const strategyById = (id: string) => {
  const s = STRATEGIES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown strategy ${id}; known: ${STRATEGIES.map((x) => x.id).join(', ')}`);
  return s;
};
