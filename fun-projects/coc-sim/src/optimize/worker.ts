import { parentPort, workerData } from 'node:worker_threads';
import { applyTunables } from '../engine/mechanics.ts';
import { strategyById } from '../strategies/meta.ts';
import { runAttack } from '../run.ts';
import type { Job, JobResult } from './pool.ts';
import { loadCalibration } from './calibration-file.ts';

loadCalibration();
if (workerData?.tunables) applyTunables(workerData.tunables);

parentPort!.on('message', (job: Job) => {
  let out: JobResult;
  try {
    const r = runAttack(job.layout, strategyById(job.strategy), job.params, { seed: job.seed });
    out = { stars: r.stars, pct: r.pct, time: r.time, th: r.thDestroyed };
  } catch (e) {
    out = { stars: 0, pct: 0, time: 0, th: false, error: String((e as Error)?.stack ?? e) };
  }
  parentPort!.postMessage(out);
});
