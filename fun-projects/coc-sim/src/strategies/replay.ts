// Re-enacts a real attack from a written-down timeline (see docs/CALIBRATION.md).
import { MAP } from '../engine/mechanics.ts';
import type { Army, Controller, Sim } from '../engine/sim.ts';

export interface ReplayEvent {
  t: number;                 // seconds since the first deploy
  kind: 'troop' | 'spell' | 'cc' | 'cc-spell' | 'hero' | 'ability';
  type?: string;             // troop / spell / hero id
  x?: number; y?: number;    // build-grid tiles (0..43); the grass border is -3..-1 and 44..46
  count?: number;            // troops dropped at this point (default 1)
  spread?: number;           // tiles the drops are spread along (default 0)
}

export interface RecordedAttack {
  name: string;
  base: string | object;       // bases/<file>.json or an inline layout
  army: Army;
  events: ReplayEvent[];
  actual: { stars: number; pct: number; time?: number };
  notes?: string;
}

export class ReplayController implements Controller {
  private events: ReplayEvent[];
  private i = 0;
  constructor(events: ReplayEvent[]) {
    this.events = [...events].sort((a, b) => a.t - b.t);
  }
  onTick(sim: Sim) {
    const B = MAP.border;
    while (this.i < this.events.length && this.events[this.i].t <= sim.t) {
      const e = this.events[this.i++];
      const x = (e.x ?? 0) + B, y = (e.y ?? 0) + B;
      switch (e.kind) {
        case 'troop': {
          const n = e.count ?? 1, s = e.spread ?? 0;
          for (let k = 0; k < n; k++) {
            const off = n === 1 ? 0 : -s / 2 + (s * k) / (n - 1);
            sim.deploy(e.type!, x + off, y + sim.rng.gauss(0.2));
          }
          break;
        }
        case 'spell': sim.cast(e.type!, x, y); break;
        case 'cc-spell': sim.cast(e.type!, x, y, true); break;
        case 'cc': sim.deployCC(x, y); break;
        case 'hero': sim.deployHero(e.type!, x, y); break;
        case 'ability': { const h = sim.heroUnits.find((u) => u.alive); if (h) sim.activateHero(h); break; }
      }
    }
  }
  finished() { return this.i >= this.events.length; }
}
