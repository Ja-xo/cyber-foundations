import raw from '../../data/th8.json' with { type: 'json' };

export interface AttackStats {
  targetType: 'ground' | 'air' | 'both';
  range: number;
  attackSpeed: number;
  damageType: 'single' | 'splash' | 'none';
  splashRadius: number;
  dps: number;
  damagePerShot: number;
  triggerRange?: number;
  pushStrength?: number;
}

export interface BuildingDef {
  id: string;
  name: string;
  kind: 'defense' | 'resource' | 'army' | 'clancastle' | 'townhall' | 'other';
  count: number;
  level: number;
  size: [number, number];
  hp: number;
  attack?: AttackStats;
  deathDamage?: number;
  troopCapacity?: number;
  spellCapacity?: number;
  triggerRadius?: number;
}

export interface TrapDef {
  id: string; name: string; count: number; level: number; size: [number, number];
  triggerRadius: number; damageRadius: number; damageType: string;
  targetType: 'ground' | 'air' | 'both'; damage: number;
  springCapacity?: number; spawnedUnits?: number;
}

export interface TroopDef {
  id: string; name: string; level: number; hp: number; housing: number;
  speed: number; range: number; attackSpeed: number;
  damageType: 'single' | 'splash' | 'none'; targetType: 'ground' | 'air' | 'both';
  dps: number; damagePerShot: number;
  deathDamage?: number; golemitesSpawned?: number;
  healingPerSecond?: number; healingPerSecondOnHeroes?: number;
}

export interface HeroDef {
  id: string; name: string; level: number; hp: number; dps: number; damagePerShot: number;
  healthRecovery: number; speed: number; attackSpeed: number; range: number; searchRadius: number;
}

export interface EquipmentDef {
  id: string; name: string; hero: string; rarity: string; abilityType: 'Active' | 'Passive';
  level: number; ability: Record<string, any>; hitpointIncrease: number; hpRecoveryIncrease: number;
  stats: Record<string, any>;
}

export interface GameData {
  meta: Record<string, any>;
  capacities: { army: number; spells: number; darkSpells: number; ccTroops: number; ccSpells: number; heroSlots: number };
  buildings: Record<string, BuildingDef>;
  wall: { id: string; count: number; level: number; hp: number };
  traps: Record<string, TrapDef>;
  troops: Record<string, TroopDef>;
  ccTroops: Record<string, TroopDef>;
  spells: Record<string, any>;
  ccSpells: Record<string, any>;
  heroes: Record<string, HeroDef>;
  equipment: Record<string, EquipmentDef>;
}

export const DATA = raw as unknown as GameData;

/** Parses '+140%', '34%', '6.0s', 45 → number (percent strings become plain numbers, e.g. 140). */
export function num(v: unknown, fallback = 0): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const m = v.match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : fallback;
  }
  return fallback;
}
