// Mechanics regression tests: small hand-built scenarios with known outcomes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, type Army, type Controller } from '../src/engine/sim.ts';
import { DATA } from '../src/engine/data.ts';
import type { Layout } from '../src/bases/layout.ts';
import { decode, archetype, ARCHETYPES, TEMPLATES, templateWalls, randomGenome } from '../src/bases/generator.ts';
import { validateLayout } from '../src/bases/layout.ts';
import { STRATEGIES } from '../src/strategies/meta.ts';
import { runAttack } from '../src/run.ts';
import { Rng } from '../src/engine/rng.ts';

const empty = (over: Partial<Layout> = {}): Layout => ({ name: 't', buildings: [], walls: [], traps: [], heroes: [], cc: {}, ...over });
const army = (troops: Record<string, number>, spells: Record<string, number> = {}): Army => ({ troops, spells, cc: { troops: {}, spells: {} }, heroes: [] });

class Script implements Controller {
  steps: [number, (s: Sim) => void][];
  constructor(steps: [number, (s: Sim) => void][]) { this.steps = steps; }
  onTick(s: Sim) { while (this.steps.length && this.steps[0][0] <= s.t) this.steps.shift()![1](s); }
  finished() { return this.steps.length === 0; }
}

test('4 max Lightning Spells destroy a max TH8 Air Defense', () => {
  const l = empty({ buildings: [{ type: 'air-defense', x: 20, y: 20 }, { type: 'cannon', x: 2, y: 2 }] });
  const sim = new Sim(l, army({}, { 'lightning-spell': 4 }), new Script([[0, (s) => { for (let i = 0; i < 4; i++) s.cast('lightning-spell', 21.5 + 3, 21.5 + 3); }]]));
  sim.step();
  const ad = sim.structures.find((b) => b.type === 'air-defense')!;
  assert.equal(DATA.spells['lightning-spell'].damage * 4 >= DATA.buildings['air-defense'].hp, true);
  assert.equal(ad.alive, false);
});

test('Earthquake damage diminishes on repeat casts (1, 1/3, 1/5)', () => {
  const l = empty({ buildings: [{ type: 'town-hall', x: 20, y: 20 }] });
  const sim = new Sim(l, army({}, { 'earthquake-spell': 1 }), new Script([]));
  const th = sim.structures[0];
  sim.remaining.spells['earthquake-spell'] = 3;
  const pct = DATA.spells['earthquake-spell'].buildingDamagePercent / 100;
  sim.cast('earthquake-spell', th.cx, th.cy);
  assert.ok(Math.abs(th.maxHp - th.hp - th.maxHp * pct) < 1e-6);
  sim.cast('earthquake-spell', th.cx, th.cy);
  assert.ok(Math.abs(th.maxHp - th.hp - th.maxHp * pct * (1 + 1 / 3)) < 1e-6);
});

test('two Wall Breakers open a max TH8 wall; one does not', () => {
  const one = 40 * DATA.troops['wall-breaker'].damagePerShot;
  assert.ok(one < DATA.wall.hp && 2 * one >= DATA.wall.hp);
});

test('Hog Riders jump walls, Giants have to break them', () => {
  const walls: [number, number][] = [];
  for (let i = 15; i <= 27; i++) { walls.push([i, 15], [i, 27], [15, i], [27, i]); }
  const l = empty({ buildings: [{ type: 'cannon', x: 20, y: 20 }], walls });
  const hog = new Sim(l, army({ 'hog-rider': 4 }), new Script([[0, (s) => { for (let i = 0; i < 4; i++) s.deploy('hog-rider', 2, 23); }]]), { seed: 1 }).run();
  assert.equal(hog.pct, 100);
  const giant = new Sim(l, army({ giant: 4 }), new Script([[0, (s) => { for (let i = 0; i < 4; i++) s.deploy('giant', 2, 23); }]]), { seed: 1 });
  const g = giant.run();
  const wallsDown = giant.buildings.filter((b) => b.isWall && !b.alive).length;
  assert.ok(wallsDown >= 1, 'giant should have broken a wall');
  assert.ok(g.time > hog.time, 'breaking the wall costs time');
});

test('Mortar cannot hit troops inside its blind spot', () => {
  const l = empty({ buildings: [{ type: 'mortar', x: 20, y: 20 }] });
  const sim = new Sim(l, army({ giant: 1 }), new Script([[0, (s) => { s.deploy('giant', 24.5, 22); }]]));
  for (let i = 0; i < 50; i++) sim.step();
  const g = sim.units.find((u) => u.type === 'giant')!;
  assert.equal(g.hp, g.maxHp);
});

test('Giant Bomb hits ground troops and leaves air alone', () => {
  const l = empty({ buildings: [{ type: 'cannon', x: 30, y: 21 }], traps: [{ type: 'giant-bomb', x: 15, y: 21 }] });
  const sim = new Sim(l, army({ 'hog-rider': 1, balloon: 1 }), new Script([[0, (s) => { s.deploy('hog-rider', 2, 22.5); s.deploy('balloon', 2, 22.5); }]]));
  for (let i = 0; i < 120; i++) sim.step();
  const hog = sim.units.find((u) => u.type === 'hog-rider')!;
  const loon = sim.units.find((u) => u.type === 'balloon')!;
  assert.ok(hog.hp <= hog.maxHp - DATA.traps['giant-bomb'].damage + 1e-6);
  assert.equal(loon.hp, loon.maxHp);
});

test('stars: 50%, Town Hall and 100% each give one', () => {
  const l = empty({ buildings: [{ type: 'town-hall', x: 20, y: 20 }, { type: 'gold-mine', x: 2, y: 2 }] });
  const sim = new Sim(l, army({}), new Script([]));
  assert.equal(sim.stars, 0);
  sim.damageBuilding(sim.structures[0], 1e9, null);
  assert.equal(sim.stars, 2); // 50% + TH
  sim.damageBuilding(sim.structures[1], 1e9, null);
  assert.equal(sim.stars, 3);
});

test('army validation enforces TH8 caps (200 housing, 1 hero slot)', () => {
  assert.throws(() => new Sim(empty(), army({ dragon: 11 }), new Script([])), /housing/);
  assert.throws(() => new Sim(empty(), { ...army({}), heroes: [{ id: 'barbarian-king', equipment: [] }, { id: 'archer-queen', equipment: [] }] }, new Script([])), /hero slot/);
});

test('every template fits the wall budget and every archetype is a legal layout', () => {
  for (const t of TEMPLATES) assert.ok(templateWalls(t).length <= DATA.wall.count, t.id);
  for (const a of ARCHETYPES) {
    const errs = validateLayout(decode(archetype(a))).filter((i) => i.level === 'error');
    assert.deepEqual(errs, [], a);
  }
  const rng = new Rng(3);
  for (let i = 0; i < 5; i++) {
    const errs = validateLayout(decode(randomGenome(rng))).filter((x) => x.level === 'error');
    assert.deepEqual(errs, []);
  }
});

test('all strategies run deterministically from a seed', () => {
  const l = decode(archetype('ring-core'));
  for (const s of STRATEGIES) {
    const a = runAttack(l, s, { angle: 0.3 }, { seed: 5 });
    const b = runAttack(l, s, { angle: 0.3 }, { seed: 5 });
    assert.deepEqual([a.stars, a.pct, a.time], [b.stars, b.pct, b.time], s.id);
  }
});
