// Game mechanics that are NOT in the stat tables (data/th8.json).
//
// Every constant carries a confidence tag:
//   'documented'  – stated on the fan wiki / Supercell notes and widely agreed on
//   'community'   – community-measured or widely repeated, not official
//   'estimate'    – my best estimate; these are the knobs calibration should tune
//
// The calibration script (src/calibrate.ts) can override any numeric value in
// TUNABLES from a JSON file, so real replays can correct the estimates.

export const MAP = {
  buildSize: 44,      // documented: 44x44 buildable tiles
  border: 3,          // documented-ish: deployable grass ring around the build area
  size: 50,           // buildSize + 2*border
  battleTime: 180,    // documented: 3:00 attack timer
  scoutTime: 30,      // documented: not simulated (attack starts on first deploy)
};

export type Confidence = 'documented' | 'community' | 'estimate';

export interface Tunables {
  speedDivisor: number;        // wiki speed units -> tiles/second (tiles/s = speed / speedDivisor)
  wallPathCost: number;        // extra path cost (in tiles) for routing through an intact wall
  wallPathCostPerHp: number;   // additional cost per wall HP
  aggroRadius: number;         // extra radius at which attackers engage defending troops
  meleeReach: number;          // contact slack added to every range check (tiles)
  noDeployMargin: number;      // red-zone margin around buildings (tiles)
  ccTriggerScale: number;      // multiplies CC trigger radius from data
  ccReleaseInterval: number;   // seconds between CC troops leaving the castle
  trapDelay: number;           // seconds between trap trigger and explosion
  mortarFlightTime: number;    // seconds a mortar shell is in the air
  bombTowerFlightTime: number; // seconds a bomb tower bomb is in the air
  wallBreakerWallMultiplier: number;
  wallBreakerRadius: number;
  goblinResourceMultiplier: number;
  eqWallMultiplier: number;    // EQ spell damage multiplier vs walls
  heroRageFactor: number;      // heroes receive this share of Rage's damage boost
  healHeroFactor: number;      // heroes receive this share of Heal spell healing (data has explicit value too)
  fieldStaleness: number;      // seconds a path field may lag behind broken walls/buildings
  retargetDelay: number;       // seconds a troop pauses after its target is destroyed
  reactionTime: number;        // seconds between a player deciding to cast a spell and the spell landing
  troopSplash: Record<string, number>;
  deathRadius: Record<string, number>;
}

export const TUNABLES: Tunables = {
  speedDivisor: 8,             // community (wiki "Troop Movement Speed"): internal/100 tiles/s, 8 in-game units ≈ 1 tile/s
  wallPathCost: 9,             // estimate: troops detour up to ~9 tiles to avoid a wall
  wallPathCostPerHp: 0.0005,   // estimate: L8 wall (3000hp) adds +1.5 tiles
  aggroRadius: 3,              // estimate
  meleeReach: 0.5,             // estimate: troops attack from the building's edge
  noDeployMargin: 1,           // documented: 1 tile red border around buildings
  ccTriggerScale: 1,           // data value used as-is
  ccReleaseInterval: 0.3,      // estimate
  trapDelay: 0.5,              // community
  mortarFlightTime: 1.6,       // community: shells can miss fast troops
  bombTowerFlightTime: 0.6,    // estimate
  wallBreakerWallMultiplier: 40, // documented (wiki): 40x damage vs walls
  wallBreakerRadius: 2,        // community
  goblinResourceMultiplier: 2, // documented
  eqWallMultiplier: 4,         // community: EQ hits walls 4x, increasing with repeats
  heroRageFactor: 0.5,         // documented (wiki): rage boost halved on heroes
  healHeroFactor: 0.55,        // data: totalHealingOnHeroes / totalHealing
  fieldStaleness: 0.4,         // estimate (engine knob)
  retargetDelay: 0.5,          // estimate: visible pause in game when troops pick a new target
  reactionTime: 0.8,           // estimate: human reaction for reactive spells
  troopSplash: {               // estimate: splash radius of troop attacks (tiles)
    wizard: 0.3, dragon: 0.5, 'baby-dragon': 0.3, balloon: 1.2, valkyrie: 1.0,
  },
  deathRadius: {               // estimate
    balloon: 1.2, golem: 1.2, 'wall-breaker': 2, 'bomb-tower': 2.75,
  },
};

export const CONFIDENCE: Record<keyof Tunables, Confidence> = {
  speedDivisor: 'community', wallPathCost: 'estimate', wallPathCostPerHp: 'estimate',
  aggroRadius: 'estimate', meleeReach: 'estimate', noDeployMargin: 'documented',
  ccTriggerScale: 'documented', ccReleaseInterval: 'estimate', trapDelay: 'community',
  mortarFlightTime: 'community', bombTowerFlightTime: 'estimate', wallBreakerWallMultiplier: 'documented',
  wallBreakerRadius: 'community', goblinResourceMultiplier: 'documented', eqWallMultiplier: 'community',
  heroRageFactor: 'documented', healHeroFactor: 'documented', troopSplash: 'estimate', deathRadius: 'estimate',
  fieldStaleness: 'estimate', retargetDelay: 'estimate', reactionTime: 'estimate',
};

export function applyTunables(overrides: Partial<Tunables>): void {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) continue;
    const key = k as keyof Tunables;
    if (typeof v === 'object' && v !== null) Object.assign(TUNABLES[key] as object, v);
    else (TUNABLES as any)[key] = v;
  }
}

// ---------------------------------------------------------------- targeting rules
// documented (wiki troop pages): preferred targets. 'none' = nearest building.
export type Preference = 'none' | 'defense' | 'resource' | 'wall' | 'heal';
export const PREFERENCE: Record<string, Preference> = {
  barbarian: 'none', archer: 'none', giant: 'defense', goblin: 'resource', 'wall-breaker': 'wall',
  balloon: 'defense', wizard: 'none', healer: 'heal', dragon: 'none', pekka: 'none',
  minion: 'none', 'hog-rider': 'defense', valkyrie: 'none', golem: 'defense', golemite: 'defense',
  'baby-dragon': 'none', skeleton: 'none', 'barbarian-king': 'none', 'archer-queen': 'none',
  'queen-clone': 'none', 'giant-giant': 'defense', snake: 'none',
};

// documented: flying units
export const AIR_UNITS = new Set(['balloon', 'healer', 'dragon', 'minion', 'baby-dragon']);
// documented: hog riders hop over walls
export const WALL_JUMPERS = new Set(['hog-rider']);
// community: these ignore defending troops until their preferred targets are gone
export const IGNORES_UNITS = new Set(['giant', 'hog-rider', 'balloon', 'golem', 'golemite', 'wall-breaker', 'goblin', 'giant-giant', 'healer']);

// documented: Mortar has a 4-tile blind spot; Air Sweeper ~1
export const MIN_RANGE: Record<string, number> = { mortar: 4, 'air-sweeper': 1 };

// Air Sweeper cone half-angle (documented: 120° arc)
export const AIR_SWEEPER_HALF_ANGLE = Math.PI / 3;

// documented: a spring trap only launches troops that fit its capacity; heroes are immune
// Skeleton (from Skeleton Trap / Skeleton Spell L1) – community stats
export const SKELETON = { hp: 30, dps: 25, speed: 24, range: 0.4, attackSpeed: 1 };
// Snake from Snake Bracelet – estimate
export const SNAKE = { hp: 150, dps: 40, speed: 28, range: 0.5, attackSpeed: 1 };

// documented: buildings that count for destruction % (everything except walls)
// Hero Banner is decorative for scoring purposes and not simulated.

// Earthquake: documented diminishing returns on the same building: 1, 1/3, 1/5, 1/7
export const EQ_DIMINISH = (n: number) => 1 / (2 * n - 1);
