// The full "what is actually best at TH8" study: an attacker/defender arms race.
//
//  round r:
//    1. tune every meta strategy (hero, equipment, spread, timing, army swaps, zap target)
//       against the current base pool, each attack picking its best direction per base
//    2. evolve a base against the tuned attack set (GA over wall templates + placements)
//    3. add the evolved base to the pool
//  final: evaluate tuned attacks × all bases with more seeds; write docs/RESULTS.md,
//  out/study.json and bases/best-*.json (also baked into the web app).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, archetype, ARCHETYPES, type Genome } from './bases/generator.ts';
import type { Layout } from './bases/layout.ts';
import { STRATEGIES, strategyById } from './strategies/meta.ts';
import { DEFAULT_PARAMS, HERO_EQUIPMENT } from './strategies/common.ts';
import { Pool } from './optimize/pool.ts';
import { Rng } from './engine/rng.ts';
import { optimizeAttack, optimizeBase, evalStyle, attackPressure, describeStyle, type Style } from './optimize/search.ts';
import { DATA } from './engine/data.ts';
import { TUNABLES, CONFIDENCE } from './engine/mechanics.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface StudyOptions { iters: number; pop: number; gens: number; angles: number; seeds: number; finalSeeds: number; rounds: number }

export async function study(o: StudyOptions) {
  const t0 = Date.now();
  const pool = new Pool();
  const rng = new Rng(2026);
  mkdirSync(join(root, 'out'), { recursive: true });
  mkdirSync(join(root, 'bases'), { recursive: true });
  const ev = { angles: o.angles, seeds: o.seeds };
  const bases: Layout[] = ARCHETYPES.map((a) => decode(archetype(a), `Archetype: ${a}`));
  const evolved: { layout: Layout; genome: Genome; value: number; round: number }[] = [];
  let styles: Style[] = [];
  const log = (s: string) => console.log(`[${((Date.now() - t0) / 60000).toFixed(1)}m] ${s}`);

  // Start from the meta plans as written (Queen for air armies, King for ground).
  styles = STRATEGIES.map((s) => {
    const hero = s.kind === 'air' ? 'archer-queen' : 'barbarian-king';
    return { strategy: s.id, params: { ...DEFAULT_PARAMS, hero, equipment: HERO_EQUIPMENT[hero] } };
  });
  for (let round = 1; round <= o.rounds; round++) {
    // Defense first: the archetypes fall to every meta attack, so evolve a base that doesn't.
    log(`ROUND ${round}: evolving a base vs ${styles.length} attacks`);
    const res = await optimizeBase(pool, styles, { pop: o.pop, gens: o.gens, seed: 100 + round, eval: { angles: Math.min(6, o.angles), seeds: 1 }, seedGenomes: evolved.map((e) => e.genome) }, (m) => log(m));
    res.layout.name = `Evolved base (round ${round})`;
    evolved.push({ layout: res.layout, genome: res.genome, value: res.value, round });
    bases.push(res.layout);
    writeFileSync(join(root, 'out', `evolved-${round}.json`), JSON.stringify({ genome: res.genome, value: res.value, history: res.history }));
    // Then the attackers adapt to the stronger bases.
    const tuneOn = bases.filter((b) => !b.name.startsWith('Archetype')).concat(bases.filter((b) => b.name.startsWith('Archetype')).slice(0, 1));
    log(`ROUND ${round}: tuning ${STRATEGIES.length} attacks vs ${tuneOn.length} bases`);
    styles = [];
    for (const s of STRATEGIES) {
      const r = await optimizeAttack(pool, tuneOn, s.id, o.iters, ev, rng, (m) => log(m));
      styles.push(r.style);
    }
    writeFileSync(join(root, 'out', 'styles.json'), JSON.stringify(styles, null, 1));
  }

  log('FINAL: evaluation matrix');
  const fe = { angles: o.angles, seeds: o.finalSeeds };
  const matrix: { strategy: string; style: string; perBase: { base: string; threeStar: number; avgStars: number; avgPct: number; angle: number }[]; overall: { threeStar: number; avgStars: number; avgPct: number; score: number } }[] = [];
  for (const st of styles) {
    const e = await evalStyle(pool, bases, st, fe);
    matrix.push({
      strategy: st.strategy, style: describeStyle(st),
      perBase: e.perBase.map((p, i) => ({ base: bases[i].name, threeStar: p.summary.threeStarRate, avgStars: p.summary.avgStars, avgPct: p.summary.avgPct, angle: p.angle })),
      overall: { threeStar: e.summary.threeStarRate, avgStars: e.summary.avgStars, avgPct: e.summary.avgPct, score: e.score },
    });
  }
  const baseRank = [];
  for (const b of bases) {
    const p = await attackPressure(pool, b, styles, fe);
    baseRank.push({ base: b.name, pressure: p.value, worst: p.per.sort((x, y) => y.score - x.score)[0] });
  }
  baseRank.sort((a, b) => a.pressure - b.pressure);
  await pool.close();

  const best = evolved.sort((a, b) => a.value - b.value);
  best.forEach((e, i) => {
    e.layout.name = i === 0 ? 'Best evolved TH8 war base' : `Evolved TH8 war base #${i + 1}`;
    writeFileSync(join(root, 'bases', `best-${i + 1}.json`), JSON.stringify(e.layout));
  });
  writeFileSync(join(root, 'out', 'study.json'), JSON.stringify({ options: o, styles, matrix, baseRank, minutes: (Date.now() - t0) / 60000 }, null, 1));
  writeFileSync(join(root, 'docs', 'RESULTS.md'), report(o, matrix, baseRank, (Date.now() - t0) / 60000));
  log('done → docs/RESULTS.md, bases/best-*.json, out/study.json');
}

function pc(x: number) { return `${(100 * x).toFixed(0)}%`; }

function report(o: StudyOptions, matrix: any[], baseRank: any[], minutes: number): string {
  const ranked = [...matrix].sort((a, b) => b.overall.score - a.overall.score);
  const bases: string[] = matrix[0].perBase.map((p: any) => p.base);
  const lines: string[] = [];
  lines.push('# TH8 war study: results', '');
  lines.push(`Generated by \`npm run sim -- study\` on ${new Date().toISOString().slice(0, 10)} (${minutes.toFixed(0)} min, ${o.rounds} arms-race rounds).`);
  lines.push(`Data: ${DATA.meta.source} v${DATA.meta.sourceVersion}. Everything at TH8 max (Lab ${DATA.meta.laboratory}, Hero Hall ${DATA.meta.heroHall} → one hero slot, Blacksmith ${DATA.meta.blacksmith}).`, '');
  lines.push('**Read this first.** These numbers come from a simulator whose mechanics are partly estimated (see the confidence table at the end).');
  lines.push('Rankings (which attack beats which base) are more trustworthy than exact percentages. Calibrate with real replays (docs/CALIBRATION.md) to tighten them.', '');
  lines.push('Each attack scouts every base and attacks from its best of ' + o.angles + ' directions; results use ' + o.finalSeeds + ' runs per direction with human-like deploy imprecision.', '');
  lines.push('## Attack ranking (all bases)', '');
  lines.push('| # | Strategy | 3★ rate | Avg stars | Avg % | Best setup found |', '|---|---|---|---|---|---|');
  ranked.forEach((m, i) => lines.push(`| ${i + 1} | ${strategyById(m.strategy).name} | ${pc(m.overall.threeStar)} | ${m.overall.avgStars.toFixed(2)} | ${m.overall.avgPct.toFixed(0)}% | ${m.style} |`));
  lines.push('', '## Attack × base (3★ rate · avg stars)', '');
  lines.push('| Strategy | ' + bases.join(' | ') + ' |', '|---|' + bases.map(() => '---').join('|') + '|');
  for (const m of ranked) lines.push(`| ${m.strategy} | ` + m.perBase.map((p: any) => `${pc(p.threeStar)} · ${p.avgStars.toFixed(1)}★`).join(' | ') + ' |');
  lines.push('', '## Base ranking (lower attacker pressure = stronger base)', '');
  lines.push('| # | Base | Attacker pressure | Most dangerous attack | its 3★ rate |', '|---|---|---|---|---|');
  baseRank.forEach((b, i) => lines.push(`| ${i + 1} | ${b.base} | ${b.pressure.toFixed(2)} | ${b.worst.strategy} | ${pc(b.worst.summary.threeStarRate)} |`));
  lines.push('', 'Pressure = ½·(best attack score) + ½·(mean attack score), where score = stars + 0.5 bonus for a 3★ + %/200.', '');
  lines.push('## Mechanics confidence', '', '| Knob | Value | Confidence |', '|---|---|---|');
  for (const [k, v] of Object.entries(TUNABLES)) lines.push(`| ${k} | \`${JSON.stringify(v)}\` | ${(CONFIDENCE as any)[k]} |`);
  lines.push('');
  return lines.join('\n');
}
