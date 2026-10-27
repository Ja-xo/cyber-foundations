import { decode, archetype } from '../src/bases/generator.ts';
import { strategyById } from '../src/strategies/meta.ts';
import { runAttack } from '../src/run.ts';
const layout = decode(archetype('ring-core'), 'x');
const t0 = performance.now();
for (let i = 0; i < 5; i++) runAttack(layout, strategyById(process.argv[2] ?? 'gowipe'), { angle: i / 5 }, { seed: i });
console.log(((performance.now() - t0) / 5).toFixed(0), 'ms/sim');
