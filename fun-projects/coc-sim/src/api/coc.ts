// Official Clash of Clans API (https://developer.clashofclans.com).
// Needs COC_API_TOKEN: create a key there and whitelist the public IP of the machine you
// run this on (keys are IP-locked, so run it from your own computer).
//
//   node src/cli.ts player --tag '#ABC123'      your levels vs TH8 max
//   node src/cli.ts warstats --clan '#CLAN'     real TH8-vs-TH8 star rates from current war / CWL
import { DATA } from '../engine/data.ts';

const API = 'https://api.clashofclans.com/v1';

async function get(path: string): Promise<any> {
  const token = process.env.COC_API_TOKEN;
  if (!token) throw new Error('Set COC_API_TOKEN (developer.clashofclans.com key whitelisted for this machine\'s IP).');
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const enc = (tag: string) => encodeURIComponent(tag.startsWith('#') ? tag : '#' + tag);
const slug = (name: string) => name.toLowerCase().replace(/\./g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export async function playerReport(tag: string) {
  const p = await get(`/players/${enc(tag)}`);
  console.log(`${p.name} (${p.tag}) · TH${p.townHallLevel} · war stars ${p.warStars}`);
  const rows: [string, number, number][] = [];
  const cmp = (list: any[], table: Record<string, { level: number }>, kind: string) => {
    for (const x of list ?? []) {
      if (x.village && x.village !== 'home') continue;
      const def = table[slug(x.name)];
      if (def) rows.push([`${kind} ${x.name}`, x.level, def.level]);
    }
  };
  cmp(p.troops, DATA.troops, 'troop');
  cmp(p.spells, DATA.spells, 'spell');
  cmp(p.heroes, DATA.heroes, 'hero');
  cmp(p.heroEquipment, DATA.equipment, 'equipment');
  for (const [name, have, max] of rows) console.log(`${name.padEnd(34)} ${String(have).padStart(3)} / ${max}${have < max ? '   ← upgrade' : ''}`);
}

/** Real-world benchmark: star outcomes of TH8 attacking TH8 in a clan's current war and CWL rounds. */
export async function warStats(clanTag: string) {
  const wars: any[] = [];
  try { const w = await get(`/clans/${enc(clanTag)}/currentwar`); if (w.state && w.state !== 'notInWar') wars.push(w); } catch (e) { console.log(String(e)); }
  try {
    const g = await get(`/clans/${enc(clanTag)}/currentwar/leaguegroup`);
    for (const r of g.rounds ?? []) for (const t of r.warTags ?? []) if (t && t !== '#0') wars.push(await get(`/clanwarleagues/wars/${enc(t)}`));
  } catch { /* not in CWL */ }
  const dist = [0, 0, 0, 0];
  let pct = 0;
  for (const w of wars) {
    const members = [...(w.clan?.members ?? []), ...(w.opponent?.members ?? [])];
    const th = new Map(members.map((m: any) => [m.tag, m.townhallLevel]));
    for (const m of members) for (const a of m.attacks ?? []) {
      if (m.townhallLevel === 8 && th.get(a.defenderTag) === 8) { dist[a.stars]++; pct += a.destructionPercentage; }
    }
  }
  const n = dist.reduce((a, b) => a + b, 0);
  console.log(`${wars.length} wars scanned, ${n} TH8→TH8 attacks`);
  if (n) console.log(`3★ ${(100 * dist[3] / n).toFixed(0)}% · 2★ ${(100 * dist[2] / n).toFixed(0)}% · 1★ ${(100 * dist[1] / n).toFixed(0)}% · 0★ ${(100 * dist[0] / n).toFixed(0)}% · avg ${(pct / n).toFixed(0)}%`);
  return { dist, n, avgPct: n ? pct / n : 0 };
}
