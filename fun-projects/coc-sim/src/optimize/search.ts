// Attack and base optimizers.
//
// Attack side: a "style" = hero + equipment + spread + timing + army swaps (+ zap
// target). For each base the attacker scouts and picks the best direction, exactly as
// a war attacker would. A style's value = mean over bases of its best-direction score.
//
// Defense side: a genetic algorithm over base genomes (see bases/generator.ts). A base's
// value = how badly the meta attack set does against it, again letting each attack pick
// its best direction. Lower attacker score = better base.
import type { Layout } from '../bases/layout.ts';
import { decode, mutate, crossover, randomGenome, archetype, ARCHETYPES, TEMPLATES, type Genome } from '../bases/generator.ts';
import { Rng } from '../engine/rng.ts';
import { DATA } from '../engine/data.ts';
import { strategyById } from '../strategies/meta.ts';
import { DEFAULT_PARAMS, HERO_EQUIPMENT, type StrategyParams, type Swap } from '../strategies/common.ts';
import { summarize, warScore, type Summary } from '../run.ts';
import type { Pool, JobResult } from './pool.ts';

export interface Style {
  strategy: string;
  params: Partial<StrategyParams>;
}

export const EQUIPMENT_SETS: Record<string, string[][]> = {
  'barbarian-king': [
    ['spiky-ball', 'giant-gauntlet'], ['earthquake-boots', 'giant-gauntlet'], ['rage-vial', 'giant-gauntlet'],
    ['barbarian-puppet', 'spiky-ball'], ['snake-bracelet', 'spiky-ball'], ['stick-horse', 'spiky-ball'], ['earthquake-boots', 'spiky-ball'],
  ],
  'archer-queen': [
    ['invisibility-vial', 'frozen-arrow'], ['invisibility-vial', 'magic-mirror'], ['magic-mirror', 'frozen-arrow'],
    ['archer-puppet', 'frozen-arrow'], ['action-figure', 'frozen-arrow'], ['invisibility-vial', 'monolith-arrow'],
  ],
};

/** Plausible composition swaps per strategy (housing moved from -> to). */
export const SWAPS: Record<string, Swap[]> = {
  gowipe: [['archer', 'wall-breaker', 6], ['archer', 'wizard', 8], ['wizard', 'archer', 8], ['pekka', 'wizard', 25], ['archer', 'valkyrie', 16], ['golem', 'wizard', 30]],
  goho: [['archer', 'hog-rider', 5], ['wizard', 'hog-rider', 8], ['archer', 'wall-breaker', 4], ['hog-rider', 'valkyrie', 16], ['golem', 'hog-rider', 30]],
  govaho: [['archer', 'valkyrie', 16], ['archer', 'hog-rider', 15], ['hog-rider', 'valkyrie', 16], ['wizard', 'valkyrie', 8], ['archer', 'wall-breaker', 6]],
  'mass-dragon': [['dragon', 'balloon', 20], ['dragon', 'minion', 20], ['dragon', 'healer', 14]],
  dragloon: [['minion', 'balloon', 10], ['dragon', 'balloon', 20], ['balloon', 'dragon', 20], ['minion', 'dragon', 10]],
  'mass-hog': [['hog-rider', 'wizard', 10], ['wizard', 'hog-rider', 10], ['hog-rider', 'valkyrie', 16], ['hog-rider', 'healer', 14]],
  balloonion: [['minion', 'balloon', 10], ['balloon', 'minion', 10], ['minion', 'dragon', 20], ['balloon', 'dragon', 20]],
  giwi: [['archer', 'wizard', 8], ['archer', 'giant', 10], ['giant', 'wizard', 10], ['archer', 'wall-breaker', 6], ['archer', 'healer', 14]],
};

export interface EvalOptions { angles: number; seeds: number }

/** Best-direction evaluation of one style on one base. */
export async function evalStyleOnBase(pool: Pool, layout: Layout, s: Style, o: EvalOptions): Promise<{ best: number; bestAngle: number; results: JobResult[] }> {
  const jobs = [];
  for (let a = 0; a < o.angles; a++) for (let seed = 1; seed <= o.seeds; seed++) {
    jobs.push({ layout, strategy: s.strategy, params: { ...s.params, angle: (s.params.angle ?? 0) + a / o.angles }, seed: seed * 7919 + a });
  }
  const res = await pool.runAll(jobs);
  const errs = res.filter((r) => r.error);
  if (errs.length) throw new Error(errs[0].error);
  let best = -1, bestAngle = 0, bestRes: JobResult[] = [];
  for (let a = 0; a < o.angles; a++) {
    const rs = res.slice(a * o.seeds, (a + 1) * o.seeds);
    const v = rs.reduce((x, r) => x + warScore(r), 0) / rs.length;
    if (v > best) { best = v; bestAngle = (s.params.angle ?? 0) + a / o.angles; bestRes = rs; }
  }
  return { best, bestAngle, results: bestRes };
}

export async function evalStyle(pool: Pool, bases: Layout[], s: Style, o: EvalOptions) {
  const per = await Promise.all(bases.map((b) => evalStyleOnBase(pool, b, s, o)));
  const score = per.reduce((x, p) => x + p.best, 0) / per.length;
  const summary = summarize(per.flatMap((p) => p.results));
  return { score, summary, perBase: per.map((p) => ({ score: p.best, angle: p.bestAngle, summary: summarize(p.results) })) };
}

function mutateStyle(s: Style, rng: Rng): Style {
  const p: Partial<StrategyParams> = { ...s.params, extra: { ...(s.params.extra ?? {}) } };
  const k = rng.int(0, 5);
  const strat = strategyById(s.strategy);
  if (k === 0) {
    p.hero = p.hero === 'archer-queen' ? 'barbarian-king' : 'archer-queen';
    p.equipment = rng.pick(EQUIPMENT_SETS[p.hero]);
  } else if (k === 1) p.equipment = rng.pick(EQUIPMENT_SETS[p.hero ?? 'barbarian-king']);
  else if (k === 2) p.spread = Math.max(0.5, Math.min(1.8, (p.spread ?? 1) + rng.gauss(0.2)));
  else if (k === 3) p.timing = Math.max(0.6, Math.min(1.5, (p.timing ?? 1) + rng.gauss(0.15)));
  else if (k === 4) {
    const opts = SWAPS[s.strategy] ?? [];
    const cur: Swap[] = [...(p.extra!.swaps ?? [])];
    if (cur.length && rng.next() < 0.4) cur.splice(rng.int(0, cur.length - 1), 1);
    else if (opts.length) cur.push(rng.pick(opts));
    p.extra!.swaps = cur.slice(-3);
  } else if (strat.kind !== 'ground') p.extra!.zap = rng.pick(['near', 'central', 'far']);
  else p.spread = Math.max(0.5, Math.min(1.8, (p.spread ?? 1) * (rng.next() < 0.5 ? 0.85 : 1.15)));
  return { strategy: s.strategy, params: p };
}

/** Hill-climbing search over styles for one strategy. */
export async function optimizeAttack(pool: Pool, bases: Layout[], strategy: string, iters: number, o: EvalOptions, rng: Rng, log = console.log) {
  const startHeroes: ('barbarian-king' | 'archer-queen')[] = ['barbarian-king', 'archer-queen'];
  let best: Style | null = null;
  let bestEval: Awaited<ReturnType<typeof evalStyle>> | null = null;
  for (const hero of startHeroes) {
    const s: Style = { strategy, params: { ...DEFAULT_PARAMS, hero, equipment: HERO_EQUIPMENT[hero] } };
    const e = await evalStyle(pool, bases, s, o);
    if (!bestEval || e.score > bestEval.score) { best = s; bestEval = e; }
  }
  log(`  ${strategy}: start ${bestEval!.score.toFixed(3)} (${best!.params.hero})`);
  for (let i = 0; i < iters; i++) {
    const cand = mutateStyle(best!, rng);
    const e = await evalStyle(pool, bases, cand, o);
    if (e.score > bestEval!.score) {
      best = cand; bestEval = e;
      log(`  ${strategy}: iter ${i + 1} → ${e.score.toFixed(3)} 3★ ${(100 * e.summary.threeStarRate).toFixed(0)}% ${describeStyle(cand)}`);
    }
  }
  return { style: best!, eval: bestEval! };
}

export function describeStyle(s: Style): string {
  const p = s.params;
  const sw = (p.extra?.swaps ?? []).map((x: Swap) => `${x[2]}sp ${x[0]}→${x[1]}`).join(', ');
  return `${p.hero === 'archer-queen' ? 'AQ' : 'BK'}[${(p.equipment ?? []).join('+')}] spread ${(p.spread ?? 1).toFixed(2)} timing ${(p.timing ?? 1).toFixed(2)}${p.extra?.zap ? ' zap ' + p.extra.zap : ''}${sw ? ' swaps: ' + sw : ''}`;
}

// ---------------------------------------------------------------- base optimizer
/** Attacker value against a base (higher = worse base). Mix of the single best attack and the average. */
export async function attackPressure(pool: Pool, layout: Layout, attacks: Style[], o: EvalOptions) {
  const per = await Promise.all(attacks.map((s) => evalStyleOnBase(pool, layout, s, o)));
  const scores = per.map((p) => p.best);
  const max = Math.max(...scores), mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return { value: 0.5 * max + 0.5 * mean, per: per.map((p, i) => ({ strategy: attacks[i].strategy, score: p.best, summary: summarize(p.results) })) };
}

export interface BaseSearchResult { genome: Genome; layout: Layout; value: number; history: number[] }

export async function optimizeBase(pool: Pool, attacks: Style[], opts: { pop: number; gens: number; seed: number; eval: EvalOptions; seedGenomes?: Genome[] }, log = console.log): Promise<BaseSearchResult> {
  const rng = new Rng(opts.seed);
  let popl: Genome[] = [...(opts.seedGenomes ?? []), ...ARCHETYPES.map((a) => archetype(a))];
  while (popl.length < opts.pop) popl.push(rng.next() < 0.5 ? mutate(archetype(rng.pick(ARCHETYPES)), rng, 0.3) : randomGenome(rng, rng.pick(TEMPLATES).id));
  popl = popl.slice(0, opts.pop);
  const fitness = async (g: Genome) => (await attackPressure(pool, decode(g), attacks, opts.eval)).value;
  let scored = await Promise.all(popl.map(async (g) => ({ g, v: await fitness(g) })));
  const history: number[] = [];
  for (let gen = 0; gen < opts.gens; gen++) {
    scored.sort((a, b) => a.v - b.v);
    history.push(scored[0].v);
    log(`  gen ${gen}: best ${scored[0].v.toFixed(3)} (${scored[0].g.template}) median ${scored[Math.floor(scored.length / 2)].v.toFixed(3)}`);
    const elite = scored.slice(0, 2);
    const pick = () => { const a = rng.pick(scored), b = rng.pick(scored); return a.v < b.v ? a.g : b.g; };
    const children: Genome[] = [];
    while (children.length < opts.pop - elite.length) {
      const child = rng.next() < 0.5 ? crossover(pick(), pick(), rng) : pick();
      children.push(mutate(child, rng, 0.06 + 0.1 * rng.next()));
    }
    const evald = await Promise.all(children.map(async (g) => ({ g, v: await fitness(g) })));
    // Re-evaluate elites with fresh angles offset to avoid keeping lucky ones forever.
    scored = [...elite, ...evald];
  }
  scored.sort((a, b) => a.v - b.v);
  history.push(scored[0].v);
  return { genome: scored[0].g, layout: decode(scored[0].g, 'optimized'), value: scored[0].v, history };
}

export { DATA };
export type { Summary };
