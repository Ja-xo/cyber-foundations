# Calibrating the simulator with real attacks

The simulator's stat tables come from game data, but some mechanics are estimates
(`npm run sim -- mechanics` lists every knob and how sure we are about it). Real attacks
fix those estimates. Here is what to record and how.

## What to collect

Aim for **15–30 TH8 vs TH8 attacks**, mixed strategies (some dragons, some hogs, some
GoWiPe/GoVaHo). Your own war attacks are best, because you know the exact army. Clan
mates' replays and YouTube attacks also work.

For each attack you need four things.

### 1. The base

Rebuild the defending base in the web app's editor (`npm run web`, open
`web/dist/index.html`, press **Empty base**, place buildings, **Export JSON**).

- Pause the replay before the first deploy and take a screenshot.
- The build area is 44×44 tiles. Count tiles from the nearest edge or from a big building:
  each 3×3 building is 3 tiles, walls are 1 tile.
- ±1 tile is fine for buildings. Get walls right where they form compartments, and get
  traps right when the replay shows them going off.
- Note the defensive Clan Castle troops when they come out, e.g. 1 Dragon, 1 Wizard, 1 Archer.

Save it as `calibration/bases/<name>.json`.

You can also send me screenshots in chat and I'll transcribe the layout into JSON.

### 2. The army

Troop counts, spells, CC troops + spell, hero and its two equipment pieces. If anything
is not max TH8 level, write it in `notes`.

### 3. The deploy timeline

Watch the replay and write down every deploy. The replay clock counts down from 3:00, so
`t = 180 − clock`, measured from the first drop.

| field | meaning |
|---|---|
| `t` | seconds since the first deploy |
| `kind` | `troop`, `spell`, `cc`, `cc-spell`, `hero`, `ability` |
| `type` | troop/spell/hero id, e.g. `hog-rider`, `healing-spell`, `archer-queen` |
| `x`, `y` | tile on the 44×44 grid (0,0 = top-left corner of the build area; the grass border is −3…−1 and 44…46) |
| `count` | how many troops at that spot (default 1) |
| `spread` | if they were dragged in a line, how many tiles wide |

Rough is fine: ±1 s and ±1–2 tiles. Write groups, not single taps
("12 hogs at 3,20 spread 4 at t=18").

### 4. The result

Stars, destruction %, and seconds used. Optional but valuable: the time each Air Defense
fell and the time the Town Hall fell.

## File format

`calibration/replays.json` is a list of attacks. See `calibration/example-replays.json`
for the format:

```json
[{
  "name": "Mass dragons vs Ville's base",
  "base": "calibration/bases/ville.json",
  "army": { "troops": { "dragon": 10 }, "spells": { "lightning-spell": 4, "rage-spell": 1, "earthquake-spell": 1 },
            "cc": { "troops": { "dragon": 1, "balloon": 1 }, "spells": { "lightning-spell": 1 } },
            "heroes": [{ "id": "archer-queen", "equipment": ["invisibility-vial", "frozen-arrow"] }] },
  "events": [
    { "t": 0, "kind": "spell", "type": "lightning-spell", "x": 30, "y": 12 },
    { "t": 3, "kind": "troop", "type": "dragon", "x": 46, "y": 8, "count": 8, "spread": 14 }
  ],
  "actual": { "stars": 3, "pct": 100, "time": 151 }
}]
```

## Running it

```bash
npm run sim -- calibrate --file calibration/replays.json        # compare sim vs real
npm run sim -- calibrate --file calibration/replays.json --fit  # fit the estimated knobs
```

`--fit` writes `calibration/tunables.json`. The CLI, optimizers and studies load it
automatically. Re-run `npm run study` afterwards so the rankings use the calibrated engine.

## A cheaper, bulk sanity check: real war star rates

With an API key from developer.clashofclans.com (whitelist your home IP), this command
pulls every TH8-vs-TH8 hit from a clan's current war and CWL rounds:

```bash
COC_API_TOKEN=... npm run sim -- warstats --clan '#YOURCLAN'
```

That gives a real 3★/2★/1★ split to compare against the study's numbers. It can't fit
individual knobs, but it shows whether the simulator is too generous or too harsh overall.
