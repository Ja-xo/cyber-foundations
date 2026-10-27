// Runs many simulations in parallel on worker threads.
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import type { Layout } from '../bases/layout.ts';
import type { StrategyParams } from '../strategies/common.ts';
import type { Tunables } from '../engine/mechanics.ts';

export interface Job {
  layout: Layout;
  strategy: string;
  params: Partial<StrategyParams>;
  seed: number;
}

export interface JobResult {
  stars: number;
  pct: number;
  time: number;
  th: boolean;
  error?: string;
}

export class Pool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { job: Job; resolve: (r: JobResult) => void }[] = [];
  private pending = new Map<Worker, (r: JobResult) => void>();

  constructor(n = Math.max(1, availableParallelism()), tunables?: Partial<Tunables>) {
    const url = new URL('./worker.ts', import.meta.url);
    for (let i = 0; i < n; i++) {
      const w = new Worker(url, { workerData: { tunables } });
      w.on('message', (r: JobResult) => {
        const cb = this.pending.get(w);
        this.pending.delete(w);
        this.idle.push(w);
        cb?.(r);
        this.pump();
      });
      w.on('error', (e) => {
        const cb = this.pending.get(w);
        this.pending.delete(w);
        cb?.({ stars: 0, pct: 0, time: 0, th: false, error: String(e) });
      });
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  private pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const { job, resolve } = this.queue.shift()!;
      this.pending.set(w, resolve);
      w.postMessage(job);
    }
  }

  run(job: Job): Promise<JobResult> {
    return new Promise((resolve) => {
      this.queue.push({ job, resolve });
      this.pump();
    });
  }

  runAll(jobs: Job[]): Promise<JobResult[]> {
    return Promise.all(jobs.map((j) => this.run(j)));
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
