# Research notes: data, mechanics and TH8 meta

Research snapshot from 27 Oct 2026. What the simulator is built on, where each piece came
from, and how sure we are.

## 1. Game data ("data mining, then wiki level")

**Used:** [`clash-of-clans-data`](https://github.com/chiefpansancolt/clash-of-clans-data)
v0.19.0 (npm, MIT, updated 23 Oct 2026). It is a community-maintained, typed JSON dump of
every building, troop, spell, hero, equipment piece and trap per level, at roughly
datamine/wiki fidelity. `tools/extract-th8.ts` reduces it to `data/th8.json`, keeping only
what a **max TH8** has:

| Cap | Value | Effect |
|---|---|---|
| Laboratory | 6 | troop/spell levels |
| Hero Hall | 2 | Barbarian King lvl 20, Archer Queen lvl 10, **1 hero slot** in attack |
| Blacksmith | 1 | equipment: common ≤ 9, epic ≤ 12. Giant Arrow, Vampstache and Healer Puppet need Blacksmith 2+, so they're out |
| Spell Factory 3 / Dark SF 2 | 6 + 1 spell space | Lightning, Heal, Rage / Poison, EQ (Freeze and Jump need SF4) |
| Army camps | 4 × 50 = 200 housing | |
| Clan Castle | lvl 4: 25 troops + 1 spell | donated troops capped at **lab 8** levels (a CC Dragon is lvl 5, stronger than your own lvl 3) |
| Walls | 225 × lvl 8 (3000 HP) | |

Raw datamining (decompressing the game's own CSVs from the APK) was not possible from this
environment: the app stores weren't reachable. The extractor is a single script, so if you
get CSVs (e.g. from the Statscell "Clash of Clans CSV files" repo), adding a CSV source is a
contained change.

**Important consequence:** at TH8 you bring **either** the King **or** the Queen, not both.
Every strategy is tested with both, and the optimizer picks.

## 2. Mechanics not in the stat tables

Every constant lives in `src/engine/mechanics.ts` with a confidence tag. Highlights:

| Mechanic | Value | Source / confidence |
|---|---|---|
| Speed → tiles/s | speed / 8 | Fan wiki *Troop Movement Speed* (internal ÷ 12.5 = in-game; internal/100 = tiles/s) · community |
| Preferred targets | Giant/Hog/Balloon/Golem → defenses, Goblin → resources (2×), WB → walls (40×) | wiki · documented |
| Hog Riders jump walls | yes | wiki · documented |
| Rage damage boost | additive (+170% at lvl 5), halved on heroes | Hungarian fan wiki tests · documented |
| EQ | 1, 1/3, 1/5, 1/7 on repeat; walls take increasing damage | wiki · community |
| Mortar blind spot | 4 tiles | wiki · documented |
| Destruction % | by building count, walls excluded | documented |
| Pathing around walls vs through | wall = +9 tiles of path cost | **estimate** |
| Troop aggro radius vs CC troops | range + 3 | **estimate** |
| Retarget pause | 0.5 s | **estimate** |
| Player reaction time on spells | 0.8 s | **estimate** |
| Earthquake Boots effect | breaks walls in 3.5 tiles | **estimate** (wording of data is ambiguous) |
| Action Figure / Snake Bracelet summons | simplified | **estimate** |

The **estimate** rows are what calibration tunes (see CALIBRATION.md).

## 3. TH8 meta (2025–2026)

What the guides agree on:

- **Attacks, top tier:** GoVaHo (Golem + Valkyries + Hogs), GoHo (Golem + Hogs) and
  **Mass Dragons + Lightning** are the top three TH8 war attacks in the October 2025
  rankings. Dragons are called "the most reliable 3-star army" at TH8 because TH8 air
  defense can't stop a full flock once one Air Defense is zapped.
  ([newforestsafari](https://www.newforestsafari.com/town-hall-8-attack-strategies/),
  [TrophyCoach](https://trophycoach.com/clash-of-clans/guides/best-armies-by-town-hall))
- **GoWiPe** is still the most common TH8 war attack per 2026 base guides, but players
  describe it as hard at TH8 because of camp space.
- **DragLoon, Mass Hogs, GiWi, Balloon+Minion** are the classic alternatives.
- **Bases:** centralized TH + CC, Air Defenses spread so one Lightning snipe doesn't open
  the base, Wizard Towers covering ADs, Teslas near the core, Giant Bombs in pairs on hog
  paths, Seeking Air Mines/Air Bombs on dragon/balloon lines, compartments against GoWiPe
  funnels; common CC: Dragon + Wizard + Archer.
  ([AllClash](https://www.allclash.com/th8-war-base-farming-base-layouts/),
  [coc-baselayouts](https://coc-baselayouts.com/th8-anti-3-star-war-base-layout-with-central/))

These are encoded as deployment plans in `src/strategies/meta.ts`, but the optimizers
don't trust them. They search hero, equipment, deploy width, timing, army swaps and
spell targets, and evolve bases from scratch against the tuned attacks.

## 4. What about videos?

This environment can't watch video. Video is still the best ground truth, though, and there
are two ways to use it:

1. **Screenshots in chat.** Pause a replay at scout time and send me the screenshot. I can
   read images and turn the base into layout JSON.
2. **Write the timeline down** while watching (CALIBRATION.md explains how; ~5 minutes
   per attack). Fifteen or more of these let `calibrate --fit` tune the estimated knobs
   against reality.
