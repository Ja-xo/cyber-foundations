// Builds data/th8.json from the clash-of-clans-data package (MIT, community-maintained
// game data, https://github.com/chiefpansancolt/clash-of-clans-data).
//
// Usage: node tools/extract-th8.ts [path-to-package-root]
// Default package root: node_modules/clash-of-clans-data
//
// Everything is taken at the maximum level a Town Hall 8 player can reach:
//   Laboratory 6, Hero Hall 2, Blacksmith 1, Spell Factory 3, Dark Spell Factory 2.
// Clan Castle troops/spells are capped at the CC's lab cap (donor levels), not at TH8.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TH = 8;
const LAB = 6;
const HERO_HALL = 2;
const BLACKSMITH = 1;
const SPELL_FACTORY = 3;
const DARK_SPELL_FACTORY = 2;

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = process.argv[2] ?? join(here, '..', 'node_modules', 'clash-of-clans-data');
const dataRoot = join(pkgRoot, 'data', 'home');
const pkgVersion = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version;

type Json = any;
const load = (cat: string, id: string): Json => JSON.parse(readFileSync(join(dataRoot, cat, id + '.json'), 'utf8'));
const listIds = (cat: string): string[] => readdirSync(join(dataRoot, cat)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));

function countAtTh(d: Json): number {
  const row = (d.availablePerTownHall ?? []).find((a: Json) => a.townHallLevel === TH);
  return row ? row.count : 0;
}

function maxLevel(d: Json, ok: (l: Json) => boolean): Json | undefined {
  const levels = (d.levels ?? []).filter(ok);
  return levels[levels.length - 1];
}

const thOk = (l: Json) => (l.townHallRequired ?? 0) <= TH;
const labOk = (cap: number) => (l: Json) => (l.laboratoryRequired ?? 0) <= cap;
const parseSize = (s: string): [number, number] => s.split('x').map(Number) as [number, number];

// ---------------------------------------------------------------- buildings
const BUILDING_KIND: Record<string, string> = {
  'cannon': 'defense', 'archer-tower': 'defense', 'mortar': 'defense', 'wizard-tower': 'defense',
  'air-defense': 'defense', 'hidden-tesla': 'defense', 'bomb-tower': 'defense', 'air-sweeper': 'defense',
  'builders-hut': 'other',
  'gold-mine': 'resource', 'elixir-collector': 'resource', 'gold-storage': 'resource',
  'elixir-storage': 'resource', 'dark-elixir-storage': 'resource', 'dark-elixir-drill': 'resource',
  'clan-castle': 'clancastle',
  'army-camp': 'army', 'barracks': 'army', 'dark-barracks': 'army', 'laboratory': 'army',
  'spell-factory': 'army', 'dark-spell-factory': 'army', 'hero-hall': 'army', 'blacksmith': 'army',
};
const BUILDING_CAT: Record<string, string> = {};
for (const cat of ['defenses', 'resource-buildings', 'army-buildings']) for (const id of listIds(cat)) BUILDING_CAT[id] = cat;

const buildings: Record<string, Json> = {};
for (const [id, kind] of Object.entries(BUILDING_KIND)) {
  const d = load(BUILDING_CAT[id], id);
  const lvl = maxLevel(d, thOk);
  const count = countAtTh(d);
  if (!lvl || !count) throw new Error(`no TH${TH} data for ${id}`);
  const mode = d.modes?.normal;
  const stats = lvl.stats?.normal ?? {};
  buildings[id] = {
    id, name: d.name, kind, count, level: lvl.level, size: parseSize(d.size), hp: lvl.hitpoints,
    ...(mode && stats.dps !== undefined || stats.pushStrength !== undefined ? {
      attack: {
        targetType: d.targetType, range: mode.range, attackSpeed: mode.attackSpeed,
        damageType: mode.damageType, splashRadius: mode.splashRadius ?? 0,
        dps: stats.dps ?? 0, damagePerShot: stats.damagePerShot ?? 0,
        triggerRange: mode.triggerRange, pushStrength: stats.pushStrength,
      },
    } : {}),
    ...(lvl.deathDamage ? { deathDamage: lvl.deathDamage } : {}),
    ...(id === 'clan-castle' ? { troopCapacity: lvl.troopCapacity, spellCapacity: lvl.spellCapacity, labLevelCap: lvl.labLevelCap, triggerRadius: d.triggerRadius } : {}),
  };
}
{
  const th = load('town-hall', 'town-hall');
  const lvl = th.levels.find((l: Json) => l.level === TH);
  buildings['town-hall'] = { id: 'town-hall', name: 'Town Hall', kind: 'townhall', count: 1, level: TH, size: parseSize(th.size), hp: lvl.hitpoints, weapon: lvl.weapon, maxBuildings: lvl.maxBuildings, maxTraps: lvl.maxTraps };
}
let wall: Json;
{
  const d = load('walls', 'wall');
  const lvl = maxLevel(d, thOk);
  wall = { id: 'wall', count: countAtTh(d), level: lvl.level, hp: lvl.hitpoints };
}

// ---------------------------------------------------------------- traps
const traps: Record<string, Json> = {};
for (const id of listIds('traps')) {
  const d = load('traps', id);
  const count = countAtTh(d);
  const lvl = maxLevel(d, thOk);
  if (!count || !lvl) continue;
  traps[id] = {
    id, name: d.name, count, level: lvl.level, size: parseSize(d.size),
    triggerRadius: d.triggerRadius, damageRadius: lvl.damageRadius ?? d.damageRadius ?? 0,
    damageType: d.damageType, targetType: d.targetType, damage: lvl.damage ?? 0,
    ...(lvl.springCapacity ? { springCapacity: lvl.springCapacity } : {}),
    ...(lvl.spawnedUnits ? { spawnedUnits: lvl.spawnedUnits, skeletonLevel: lvl.skeletonLevel } : {}),
  };
}

// ---------------------------------------------------------------- troops
function troopEntry(d: Json, lvl: Json): Json {
  const s = lvl.stats?.normal ?? {};
  return {
    id: d.id, name: d.name, level: lvl.level, hp: lvl.hitpoints, housing: d.housingSpace,
    speed: d.movementSpeed, range: d.range, attackSpeed: d.attackSpeed,
    damageType: d.damageType, targetType: d.targetType,
    dps: s.dps ?? 0, damagePerShot: s.damagePerShot ?? 0,
    ...(s.deathDamage ? { deathDamage: s.deathDamage } : {}),
    ...(lvl.golemitesSpawned ? { golemitesSpawned: lvl.golemitesSpawned } : {}),
    ...(s.healingPerSecond ? { healingPerSecond: s.healingPerSecond, healingPerSecondOnHeroes: s.healingPerSecondOnHeroes } : {}),
  };
}
const troops: Record<string, Json> = {};
const ccTroops: Record<string, Json> = {};
let ccLabCap = 0;
{
  const cc = buildings['clan-castle'];
  ccLabCap = cc.labLevelCap;
}
for (const id of listIds('troops')) {
  const d = load('troops', id);
  const lvl = maxLevel(d, (l) => thOk(l) && labOk(LAB)(l));
  // A troop is usable by a TH8 attacker if its level-1 row needs <= TH8.
  if (lvl && (d.levels[0].townHallRequired ?? 99) <= TH) troops[id] = troopEntry(d, lvl);
  const cl = maxLevel(d, labOk(ccLabCap));
  if (cl) ccTroops[id] = troopEntry(d, cl);
}

// ---------------------------------------------------------------- spells
function spellEntry(d: Json, lvl: Json): Json {
  const { images, researchCost, researchCostResource, researchTime, ...rest } = lvl;
  const { levels, images: _i, description, base, category, dataId, ...top } = d;
  return { ...top, ...rest };
}
const spells: Record<string, Json> = {};
const ccSpells: Record<string, Json> = {};
for (const id of listIds('spells')) {
  const d = load('spells', id);
  const factoryOk = d.spellType === 'dark' ? (d.spellFactoryLevelRequired ?? 99) <= DARK_SPELL_FACTORY : (d.spellFactoryLevelRequired ?? 99) <= SPELL_FACTORY;
  const lvl = maxLevel(d, (l) => thOk(l) && labOk(LAB)(l));
  if (factoryOk && lvl) spells[id] = spellEntry(d, lvl);
  const cl = maxLevel(d, labOk(ccLabCap));
  if (cl && d.housingSpace <= buildings['clan-castle'].spellCapacity) ccSpells[id] = spellEntry(d, cl);
}

// ---------------------------------------------------------------- heroes & equipment
const heroHall = load('army-buildings', 'hero-hall').levels.find((l: Json) => l.level === HERO_HALL);
const heroes: Record<string, Json> = {};
for (const id of ['barbarian-king', 'archer-queen']) {
  const d = load('heroes', id);
  const lvl = maxLevel(d, (l) => (l.heroHallLevelRequired ?? 99) <= HERO_HALL);
  heroes[id] = {
    id, name: d.name, level: lvl.level, hp: lvl.hitpoints, dps: lvl.damagePerSecond, damagePerShot: lvl.damagePerHit,
    healthRecovery: lvl.healthRecovery, speed: d.movementSpeed, attackSpeed: d.attackSpeed, range: d.range,
    searchRadius: d.searchRadius, attackType: d.attackType,
  };
}
const blacksmith = load('army-buildings', 'blacksmith').levels.find((l: Json) => l.level === BLACKSMITH);
const equipment: Record<string, Json> = {};
for (const id of listIds('hero-equipment')) {
  const d = load('hero-equipment', id);
  if (!heroes[d.hero]) continue;
  const cap = d.rarity === 'Epic' ? blacksmith.maxEquipmentLevel.epic : blacksmith.maxEquipmentLevel.common;
  const lvl = maxLevel(d, (l) => l.level <= cap && (l.blacksmithLevelRequired ?? 99) <= BLACKSMITH);
  if (!lvl) continue;
  const unlockedAtTh8 = (d.unlockRequirement ?? []).some((r: string) => r === 'Available by default' || r.startsWith('Buy in') || r.startsWith('Purchasable') || r === `Blacksmith level ${BLACKSMITH}`);
  if (!unlockedAtTh8) continue;
  equipment[id] = {
    id, name: d.name, hero: d.hero, rarity: d.rarity, abilityType: d.abilityType, level: lvl.level,
    ability: d.ability ?? {}, hitpointIncrease: lvl.hitpointIncrease ?? 0, hpRecoveryIncrease: lvl.hpRecoveryIncrease ?? 0,
    stats: lvl.stats ?? {},
  };
}

// ---------------------------------------------------------------- capacities
const camp = load('army-buildings', 'army-camp');
const campLvl = maxLevel(camp, thOk);
const sf = maxLevel(load('army-buildings', 'spell-factory'), (l) => l.level <= SPELL_FACTORY);
const dsf = maxLevel(load('army-buildings', 'dark-spell-factory'), (l) => l.level <= DARK_SPELL_FACTORY);

const out = {
  meta: {
    source: 'clash-of-clans-data (npm, MIT) — community-maintained game data',
    sourceVersion: pkgVersion,
    generatedAt: new Date().toISOString().slice(0, 10),
    townHall: TH, laboratory: LAB, heroHall: HERO_HALL, blacksmith: BLACKSMITH,
    spellFactory: SPELL_FACTORY, darkSpellFactory: DARK_SPELL_FACTORY, ccLabCap,
  },
  capacities: {
    army: campLvl.housingSpace * countAtTh(camp),
    spells: sf.spellStorageCapacity,
    darkSpells: dsf.spellStorageCapacity,
    ccTroops: buildings['clan-castle'].troopCapacity,
    ccSpells: buildings['clan-castle'].spellCapacity,
    heroSlots: heroHall.heroSlots,
  },
  buildings, wall, traps, troops, ccTroops, spells, ccSpells, heroes, equipment,
};
const target = join(here, '..', 'data', 'th8.json');
writeFileSync(target, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${target}: ${Object.keys(buildings).length} buildings, ${Object.keys(traps).length} traps, ${Object.keys(troops).length} troops, ${Object.keys(spells).length} spells, ${Object.keys(equipment).length} equipment`);
