// Quick sanity run: every strategy vs every archetype base from 4 directions.
import { decode, archetype, ARCHETYPES } from '../src/bases/generator.ts';
import { validateLayout } from '../src/bases/layout.ts';
import { STRATEGIES } from '../src/strategies/meta.ts';
import { runAttack } from '../src/run.ts';

const only = process.argv[2];
for (const id of ARCHETYPES) {
  const layout = decode(archetype(id), id);
  const issues = validateLayout(layout).filter((i) => i.level === 'error' || process.env.VERBOSE);
  console.log(`\n== ${id}: ${layout.buildings.length} buildings, ${layout.walls.length} walls, ${layout.traps.length} traps`, issues.map((i) => i.msg).join('; '));
  for (const s of STRATEGIES) {
    if (only && s.id !== only) continue;
    const t0 = performance.now();
    const rows: string[] = [];
    for (const angle of [0, 0.25, 0.5, 0.75]) {
      const r = runAttack(layout, s, { angle }, { seed: 7 });
      rows.push(`${r.stars}★ ${r.pct.toFixed(0)}% ${r.time}s`);
    }
    console.log(`${s.id.padEnd(12)} ${rows.join(' | ')}  (${((performance.now() - t0) / 4).toFixed(0)} ms/sim)`);
  }
}
