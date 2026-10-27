// Detailed single attack: node tools/debug.ts <strategy> <archetype> [angle] [seed]
import { decode, archetype } from '../src/bases/generator.ts';
import { strategyById } from '../src/strategies/meta.ts';
import { runAttack } from '../src/run.ts';

const [sid = 'mass-dragon', bid = 'ring-core', ang = '0', seed = '7'] = process.argv.slice(2);
const layout = decode(archetype(bid as any), bid);
const r = runAttack(layout, strategyById(sid), { angle: Number(ang) }, { seed: Number(seed), record: true, frameEvery: 5 });
console.log(`${sid} vs ${bid}: ${r.stars}★ ${r.pct}% in ${r.time}s, TH ${r.thDestroyed}`);
console.log('lost:', r.unitsLost, '\nkilled by:', r.killedBy);
console.log('log:\n ' + r.log.join('\n '));
console.log('defenses (type dmg kills destroyedAt):');
for (const d of r.defenseStats.sort((a, b) => b.damage - a.damage)) console.log(`  ${d.type.padEnd(14)} ${String(d.damage).padStart(6)} ${String(d.kills).padStart(3)} ${d.destroyedAt.toFixed(1)}`);
for (const f of r.frames!) {
  const att = f.units.filter((u) => u[2] === 0);
  const byType: Record<string, number> = {};
  for (const u of att) byType[u[1]] = (byType[u[1]] ?? 0) + 1;
  const pctDestroyed = f.bhp.filter((h) => h === 0).length;
  console.log(`t=${f.t}s attackers=${JSON.stringify(byType)} destroyed=${pctDestroyed}/${f.bhp.length}`);
}
