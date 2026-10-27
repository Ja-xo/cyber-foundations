// Loads calibration/tunables.json (written by `calibrate --fit`) into the engine.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTunables, type Tunables } from '../engine/mechanics.ts';

export const CALIBRATION_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'calibration', 'tunables.json');

export function loadCalibration(): Partial<Tunables> | undefined {
  if (!existsSync(CALIBRATION_FILE)) return undefined;
  const t = JSON.parse(readFileSync(CALIBRATION_FILE, 'utf8'));
  applyTunables(t);
  return t;
}
