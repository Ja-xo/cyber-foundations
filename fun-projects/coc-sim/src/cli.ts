// CLI: node src/cli.ts <command> [--flags]
//   attack     --strategy gowipe --base ring-core|path.json [--angle 90] [--seed 1] [--hero archer-queen] [--log]
//   matrix     [--angles 8] [--seeds 2] [--bases a,b,...]          strategies × bases table
//   opt-attack --strategy gowipe [--iters 20]                        tune a strategy vs the bases
//   opt-base   [--pop 16] [--gens 10] [--styles out/styles.json]     evolve a base vs the attack set
//   study      [--iters 12] [--pop 16] [--gens 8]                    full arms race → docs/RESULTS.md
//   validate   path.json                                             check a layout file
//   export     write archetype bases to bases/*.json
//   calibrate  [--file calibration/replays.json]                     compare sim vs real replays
//   player     --tag '#ABC123'                                        CoC API: your levels vs TH8 max
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, archetype, ARCHETYPES } from './bases/generator.ts';
import { validateLayout, type Layout } from './bases/layout.ts';
import { STRATEGIES, strategyById } from './strategies/meta.ts';
import { DEFAULT_PARAMS, HERO_EQUIPMENT } from './strategies/common.ts';
import { runAttack } from './run.ts';
import { Pool } from './optimize/pool.ts';
import { Rng } from './engine/rng.ts';
import { optimizeAttack, optimizeBase, evalStyle, describeStyle, type Style } from './optimize/search.ts';
import { TUNABLES, CONFIDENCE } from './engine/mechanics.ts';
import { DATA } from './engine/data.ts';
import { loadCalibration } from './optimize/calibration-file.ts';

loadCalibration();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string, def?: string) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const has = (name: string) => args.includes('--' + name);

export function loadBase(ref: string): Layout {
  if ((ARCHETYPES as readonly string[]).includes(ref)) return decode(archetype(ref as any), ref);
  const p = existsSync(ref) ? ref : join(root, 'bases', ref.endsWith('.json') ? ref : ref + '.json');
  return JSON.parse(readFileSync(p, 'utf8'));
}

function allBases(): Layout[] {
  const list = flag('bases');
  if (list) return list.split(',').map(loadBase);
  return ARCHETYPES.map((a) => decode(archetype(a), a));
}

function pct(x: number) { return (100 * x).toFixed(0) + '%'; }

async function main() {
  switch (cmd) {
    case 'attack': {
      const layout = loadBase(flag('base', 'ring-core')!);
      const s = strategyById(flag('strategy', 'gowipe')!);
      const hero = (flag('hero', 'barbarian-king') as any);
      const r = runAttack(layout, s, { angle: Number(flag('angle', '0')) / 360, hero, equipment: HERO_EQUIPMENT[hero], spread: Number(flag('spread', '1')) }, { seed: Number(flag('seed', '1')), record: has('record') });
      console.log(`${s.name} vs ${layout.name}: ${r.stars}★ ${r.pct}% in ${r.time}s${r.thDestroyed ? ' (TH destroyed)' : ''}`);
      console.log('troops lost:', r.unitsLost);
      console.log('killed by:', r.killedBy);
      if (has('log')) console.log(r.log.join('\n'));
      if (has('record')) { mkdirSync(join(root, 'out'), { recursive: true }); writeFileSync(join(root, 'out', 'replay.json'), JSON.stringify({ layout, result: r })); }
      break;
    }
    case 'matrix': {
      const bases = allBases();
      const angles = Number(flag('angles', '8')), seeds = Number(flag('seeds', '2'));
      const pool = new Pool();
      console.log(`Each cell: best direction of ${angles}, ${seeds} seeds → 3★ rate / avg stars / avg %`);
      console.log('strategy'.padEnd(14) + bases.map((b) => b.name.slice(0, 18).padEnd(20)).join(''));
      for (const s of STRATEGIES) {
        const e = await evalStyle(pool, bases, { strategy: s.id, params: { ...DEFAULT_PARAMS } }, { angles, seeds });
        console.log(s.id.padEnd(14) + e.perBase.map((p) => `${pct(p.summary.threeStarRate)} ${p.summary.avgStars.toFixed(1)}★ ${p.summary.avgPct.toFixed(0)}%`.padEnd(20)).join(''));
      }
      await pool.close();
      break;
    }
    case 'opt-attack': {
      const pool = new Pool();
      const bases = allBases();
      const res = await optimizeAttack(pool, bases, flag('strategy', 'gowipe')!, Number(flag('iters', '20')), { angles: Number(flag('angles', '8')), seeds: Number(flag('seeds', '2')) }, new Rng(Number(flag('seed', '1'))));
      console.log('best:', describeStyle(res.style), 'score', res.eval.score.toFixed(3), '3★', pct(res.eval.summary.threeStarRate));
      await pool.close();
      break;
    }
    case 'opt-base': {
      const pool = new Pool();
      const stylesFile = flag('styles', join(root, 'out', 'styles.json'))!;
      const attacks: Style[] = existsSync(stylesFile) ? JSON.parse(readFileSync(stylesFile, 'utf8')) : STRATEGIES.map((s) => ({ strategy: s.id, params: { ...DEFAULT_PARAMS } }));
      const res = await optimizeBase(pool, attacks, { pop: Number(flag('pop', '16')), gens: Number(flag('gens', '10')), seed: Number(flag('seed', '1')), eval: { angles: Number(flag('angles', '6')), seeds: 1 } });
      mkdirSync(join(root, 'bases'), { recursive: true });
      res.layout.name = flag('name', 'optimized')!;
      writeFileSync(join(root, 'bases', res.layout.name + '.json'), JSON.stringify(res.layout));
      console.log('saved bases/' + res.layout.name + '.json, attacker pressure', res.value.toFixed(3));
      await pool.close();
      break;
    }
    case 'study': {
      const { study } = await import('./study.ts');
      await study({
        iters: Number(flag('iters', '12')), pop: Number(flag('pop', '16')), gens: Number(flag('gens', '8')),
        angles: Number(flag('angles', '8')), seeds: Number(flag('seeds', '2')), finalSeeds: Number(flag('final-seeds', '4')),
        rounds: Number(flag('rounds', '2')),
      });
      break;
    }
    case 'validate': {
      const l = loadBase(args[1]);
      const issues = validateLayout(l);
      for (const i of issues) console.log(`${i.level}: ${i.msg}`);
      if (!issues.some((i) => i.level === 'error')) console.log('OK');
      break;
    }
    case 'export': {
      mkdirSync(join(root, 'bases'), { recursive: true });
      for (const a of ARCHETYPES) writeFileSync(join(root, 'bases', `archetype-${a}.json`), JSON.stringify(decode(archetype(a), `Archetype: ${a}`)));
      console.log('wrote', ARCHETYPES.length, 'bases');
      break;
    }
    case 'calibrate': {
      const { calibrate } = await import('./calibrate.ts');
      await calibrate(flag('file', join(root, 'calibration', 'replays.json'))!, has('fit'));
      break;
    }
    case 'player': {
      const { playerReport } = await import('./api/coc.ts');
      await playerReport(flag('tag')!);
      break;
    }
    case 'warstats': {
      const { warStats } = await import('./api/coc.ts');
      await warStats(flag('clan')!);
      break;
    }
    case 'mechanics': {
      for (const [k, v] of Object.entries(TUNABLES)) console.log(`${k.padEnd(26)} ${JSON.stringify(v).padEnd(40)} ${(CONFIDENCE as any)[k]}`);
      console.log('\nData:', DATA.meta);
      break;
    }
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 12).join('\n'));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
