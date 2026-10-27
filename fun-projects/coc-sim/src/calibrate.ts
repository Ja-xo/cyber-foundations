// Compares simulated outcomes with real recorded attacks and (with --fit) searches the
// 'estimate' mechanics knobs for the values that best reproduce them.
// Writes calibration/tunables.json, which the CLI and worker pool load automatically.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Sim } from './engine/sim.ts';
import { TUNABLES, applyTunables, type Tunables } from './engine/mechanics.ts';
import { ReplayController, type RecordedAttack } from './strategies/replay.ts';
import type { Layout } from './bases/layout.ts';

const SEEDS = [1, 2, 3, 4, 5];

function loadLayout(ref: string | object, dir: string): Layout {
  if (typeof ref !== 'string') return ref as Layout;
  const p = existsSync(ref) ? ref : join(dir, '..', ref);
  return JSON.parse(readFileSync(p, 'utf8'));
}

function simulate(rec: RecordedAttack, layout: Layout) {
  const out = SEEDS.map((seed) => new Sim(layout, rec.army, new ReplayController(rec.events), { seed }).run());
  return {
    stars: out.reduce((a, r) => a + r.stars, 0) / out.length,
    pct: out.reduce((a, r) => a + r.pct, 0) / out.length,
  };
}

function error(recs: RecordedAttack[], layouts: Layout[]) {
  let e = 0;
  const rows = recs.map((r, i) => {
    const s = simulate(r, layouts[i]);
    const d = (s.pct - r.actual.pct) / 10 + (s.stars - r.actual.stars);
    e += d * d;
    return { name: r.name, sim: s, actual: r.actual };
  });
  return { e: e / Math.max(1, recs.length), rows };
}

// Knobs worth fitting (all tagged 'estimate' in mechanics.ts) with candidate values.
const GRID: Partial<Record<keyof Tunables, number[]>> = {
  wallPathCost: [5, 9, 14],
  aggroRadius: [2, 3, 4.5],
  meleeReach: [0.3, 0.5, 0.8],
  ccReleaseInterval: [0.2, 0.3, 0.6],
  mortarFlightTime: [1.2, 1.6, 2.0],
};

export async function calibrate(file: string, fit: boolean) {
  if (!existsSync(file)) {
    console.log(`No replay file at ${file}. See docs/CALIBRATION.md and calibration/example-replays.json.`);
    return;
  }
  const recs: RecordedAttack[] = JSON.parse(readFileSync(file, 'utf8'));
  const layouts = recs.map((r) => loadLayout(r.base, dirname(file)));
  const tunFile = join(dirname(file), 'tunables.json');
  if (existsSync(tunFile)) applyTunables(JSON.parse(readFileSync(tunFile, 'utf8')));
  const base = error(recs, layouts);
  console.log('Replay                          sim ★   real ★   sim %   real %');
  for (const r of base.rows) console.log(`${r.name.slice(0, 30).padEnd(32)}${r.sim.stars.toFixed(1).padStart(5)}${String(r.actual.stars).padStart(9)}${r.sim.pct.toFixed(0).padStart(8)}${String(r.actual.pct).padStart(9)}`);
  console.log(`mean squared error (10% = 1 unit, 1★ = 1 unit): ${base.e.toFixed(3)}`);
  if (!fit) return;
  // Coordinate descent over the grid (cheap and robust with few replays).
  let best = base.e;
  const chosen: Partial<Tunables> = {};
  for (let pass = 0; pass < 2; pass++) {
    for (const [k, values] of Object.entries(GRID) as [keyof Tunables, number[]][]) {
      const orig = TUNABLES[k] as number;
      let bestV = orig;
      for (const v of values) {
        applyTunables({ [k]: v } as Partial<Tunables>);
        const e = error(recs, layouts).e;
        if (e < best - 1e-6) { best = e; bestV = v; }
      }
      applyTunables({ [k]: bestV } as Partial<Tunables>);
      if (bestV !== orig) { (chosen as any)[k] = bestV; console.log(`  ${k}: ${orig} → ${bestV} (error ${best.toFixed(3)})`); }
    }
  }
  writeFileSync(tunFile, JSON.stringify({ ...(existsSync(tunFile) ? JSON.parse(readFileSync(tunFile, 'utf8')) : {}), ...chosen }, null, 1));
  console.log(`fitted error ${best.toFixed(3)} (was ${base.e.toFixed(3)}) → ${tunFile}`);
}
