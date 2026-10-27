// Convenience wrappers: run one attack, or a batch of attacks with variation.
import { Sim, type Army, type SimOptions, type SimResult } from './engine/sim.ts';
import { DATA } from './engine/data.ts';
import { ScriptController, DEFAULT_PARAMS, applySwaps, type Strategy, type StrategyParams } from './strategies/common.ts';
import type { Layout } from './bases/layout.ts';

export function armyFor(strategy: Strategy, p: StrategyParams): Army {
  return applySwaps(strategy.army(p), p.extra?.swaps, (t) => DATA.troops[t]?.housing ?? 0);
}

export function runAttack(layout: Layout, strategy: Strategy, params: Partial<StrategyParams> = {}, opts: SimOptions = {}): SimResult {
  const p: StrategyParams = { ...DEFAULT_PARAMS, ...params };
  const ctrl = new ScriptController(strategy, p);
  const sim = new Sim(layout, armyFor(strategy, p), ctrl, opts);
  return sim.run();
}

export interface Summary {
  n: number;
  avgStars: number;
  avgPct: number;
  threeStarRate: number;
  twoPlusRate: number;
  avgTime: number;
  starDist: [number, number, number, number];
}

export function summarize(results: { stars: number; pct: number; time: number }[]): Summary {
  const n = results.length || 1;
  const dist: [number, number, number, number] = [0, 0, 0, 0];
  let s = 0, pc = 0, t = 0;
  for (const r of results) { s += r.stars; pc += r.pct; t += r.time; dist[r.stars]++; }
  return {
    n: results.length, avgStars: s / n, avgPct: pc / n, threeStarRate: dist[3] / n, twoPlusRate: (dist[2] + dist[3]) / n,
    avgTime: t / n, starDist: dist,
  };
}

/**
 * War value of one attack from the attacker's side. Stars dominate; a 3-star gets a
 * bonus because in war it fully clears the base; destruction % breaks ties.
 */
export function warScore(r: { stars: number; pct: number; time?: number }): number {
  // Time left only breaks ties between 3-star attacks (faster = more margin for error).
  const spare = r.stars === 3 && r.time !== undefined ? Math.max(0, 180 - r.time) / 1800 : 0;
  return r.stars + (r.stars === 3 ? 0.5 : 0) + r.pct / 200 + spare;
}
