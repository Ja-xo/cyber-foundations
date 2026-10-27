// Browser app: base editor + attack runner + replay viewer. Runs the same engine as the CLI.
import { DATA } from '../src/engine/data.ts';
import { MAP } from '../src/engine/mechanics.ts';
import { decode, archetype, ARCHETYPES } from '../src/bases/generator.ts';
import { validateLayout, sizeOf, type Layout } from '../src/bases/layout.ts';
import { STRATEGIES, strategyById } from '../src/strategies/meta.ts';
import { HERO_EQUIPMENT } from '../src/strategies/common.ts';
import { runAttack } from '../src/run.ts';
import type { SimResult, Frame } from '../src/engine/sim.ts';

declare const BAKED_BASES: Record<string, Layout> | undefined;
declare const BAKED_STYLES: { strategy: string; params: Record<string, any> }[] | undefined;
const tunedStyle = (id: string) => (typeof BAKED_STYLES !== 'undefined' ? BAKED_STYLES.find((s) => s.strategy === id) : undefined);

const TILE = 14;
const B = MAP.border;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const COLORS: Record<string, string> = {
  'town-hall': '#c08a3e', 'clan-castle': '#8a4fbf', 'air-defense': '#d9534f', 'wizard-tower': '#5b6ee1', mortar: '#7a6a55',
  'hidden-tesla': '#3fb6c9', 'bomb-tower': '#b5651d', 'air-sweeper': '#9bb7d4', 'archer-tower': '#4f9a4f', cannon: '#555',
  'gold-mine': '#e8c547', 'elixir-collector': '#c94fc9', 'gold-storage': '#f0d264', 'elixir-storage': '#d77fd7',
  'dark-elixir-storage': '#3b2b4a', 'dark-elixir-drill': '#4a3b5a', 'army-camp': '#a3906b', barracks: '#8d6e4f',
  'dark-barracks': '#5a4a3a', laboratory: '#6f8fa8', 'spell-factory': '#9f7fb8', 'dark-spell-factory': '#6a5a7a',
  'hero-hall': '#b89b5e', blacksmith: '#777', 'builders-hut': '#a88',
};
const UNIT_COLORS: Record<string, string> = {
  golem: '#8b7d6b', golemite: '#a89a85', pekka: '#2c3e70', wizard: '#e67e22', archer: '#e84393', 'wall-breaker': '#f1c40f',
  'hog-rider': '#7b4b2a', valkyrie: '#e74c3c', giant: '#d4a373', dragon: '#c0392b', balloon: '#555', minion: '#34495e',
  healer: '#f5e6b3', barbarian: '#f39c12', goblin: '#27ae60', 'barbarian-king': '#f1c40f', 'archer-queen': '#9b59b6',
  skeleton: '#ddd', snake: '#2ecc71', 'queen-clone': '#d2a8e6', 'giant-giant': '#d4a373', 'baby-dragon': '#2ecc71',
};
const ABBR: Record<string, string> = {
  'town-hall': 'TH', 'clan-castle': 'CC', 'air-defense': 'AD', 'wizard-tower': 'WT', mortar: 'MO', 'hidden-tesla': 'HT',
  'bomb-tower': 'BT', 'air-sweeper': 'AS', 'archer-tower': 'AT', cannon: 'CN', 'gold-mine': 'GM', 'elixir-collector': 'EC',
  'gold-storage': 'GS', 'elixir-storage': 'ES', 'dark-elixir-storage': 'DE', 'dark-elixir-drill': 'DD', 'army-camp': 'AC',
  barracks: 'BR', 'dark-barracks': 'DB', laboratory: 'LB', 'spell-factory': 'SF', 'dark-spell-factory': 'DS',
  'hero-hall': 'HH', blacksmith: 'BS', 'builders-hut': 'BH',
};

let layout: Layout = decode(archetype('ring-core'), 'ring-core');
let result: SimResult | null = null;
let frameIdx = 0;
let playing = false;
let mode: 'replay' | 'edit' = 'edit';
let tool = 'cannon';

const canvas = $<HTMLCanvasElement>('board');
const ctx = canvas.getContext('2d')!;

function cssVar(name: string) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function drawBase(f: Frame | null) {
  const W = MAP.size * TILE;
  canvas.width = W; canvas.height = W;
  ctx.fillStyle = cssVar('--grass');
  ctx.fillRect(0, 0, W, W);
  ctx.fillStyle = cssVar('--build');
  ctx.fillRect(B * TILE, B * TILE, MAP.buildSize * TILE, MAP.buildSize * TILE);
  const destroyedWalls = new Set(f?.walls ?? []);
  // walls: uids follow buildings in layout order
  const nb = layout.buildings.length;
  layout.walls.forEach(([x, y], i) => {
    if (destroyedWalls.has(nb + i)) return;
    ctx.fillStyle = cssVar('--wall');
    ctx.fillRect((x + B) * TILE + 1, (y + B) * TILE + 1, TILE - 2, TILE - 2);
  });
  if (mode === 'edit' || !f) {
    for (const t of layout.traps) {
      ctx.strokeStyle = t.type.includes('air') ? '#6cf' : '#f66';
      const [w] = sizeOf(t.type);
      ctx.strokeRect((t.x + B) * TILE + 3, (t.y + B) * TILE + 3, w * TILE - 6, w * TILE - 6);
    }
    for (const h of layout.heroes) {
      ctx.fillStyle = UNIT_COLORS[h.type];
      ctx.beginPath(); ctx.arc((h.x + B + 0.5) * TILE, (h.y + B + 0.5) * TILE, TILE * 0.45, 0, 7); ctx.fill();
    }
  }
  layout.buildings.forEach((b, i) => {
    const [w, h] = sizeOf(b.type);
    const hp = f ? f.bhp[i] : 100;
    const x = (b.x + B) * TILE, y = (b.y + B) * TILE;
    ctx.globalAlpha = hp === 0 ? 0.18 : 1;
    ctx.fillStyle = COLORS[b.type] ?? '#888';
    ctx.fillRect(x + 1, y + 1, w * TILE - 2, h * TILE - 2);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.max(8, TILE * 0.7)}px system-ui`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(ABBR[b.type] ?? '?', x + (w * TILE) / 2, y + (h * TILE) / 2);
    if (f && hp > 0 && hp < 100) {
      ctx.fillStyle = '#000'; ctx.fillRect(x + 2, y + 2, w * TILE - 4, 3);
      ctx.fillStyle = '#4caf50'; ctx.fillRect(x + 2, y + 2, ((w * TILE - 4) * hp) / 100, 3);
    }
    ctx.globalAlpha = 1;
  });
  if (!f) return;
  for (const [type, x, y, r] of f.spells) {
    ctx.fillStyle = type.includes('rage') ? 'rgba(160,0,200,.18)' : type.includes('heal') ? 'rgba(255,220,0,.2)' : type.includes('poison') ? 'rgba(60,0,80,.25)' : 'rgba(120,200,255,.25)';
    ctx.beginPath(); ctx.arc(x * TILE, y * TILE, r * TILE, 0, 7); ctx.fill();
  }
  ctx.strokeStyle = 'rgba(255,255,255,.35)';
  ctx.lineWidth = 1;
  for (const [x0, y0, x1, y1] of f.shots) { ctx.beginPath(); ctx.moveTo(x0 * TILE, y0 * TILE); ctx.lineTo(x1 * TILE, y1 * TILE); ctx.stroke(); }
  for (const [, type, side, x, y, hp] of f.units) {
    const big = ['golem', 'pekka', 'dragon', 'giant', 'barbarian-king', 'archer-queen', 'balloon', 'healer', 'valkyrie', 'hog-rider'].includes(type);
    const r = TILE * (big ? 0.42 : 0.25);
    ctx.fillStyle = UNIT_COLORS[type] ?? '#fff';
    ctx.strokeStyle = side === 0 ? '#fff' : '#f00';
    ctx.lineWidth = side === 0 ? 1 : 2;
    ctx.beginPath(); ctx.arc(x * TILE, y * TILE, r, 0, 7); ctx.fill(); ctx.stroke();
    if (hp < 100) { ctx.fillStyle = '#000'; ctx.fillRect(x * TILE - r, y * TILE - r - 4, 2 * r, 2); ctx.fillStyle = '#4caf50'; ctx.fillRect(x * TILE - r, y * TILE - r - 4, (2 * r * hp) / 100, 2); }
  }
}

function render() {
  const f = mode === 'replay' && result?.frames ? result.frames[frameIdx] : null;
  drawBase(f);
  if (f && result) {
    const destroyed = f.bhp.filter((h) => h === 0).length;
    $('clock').textContent = `${f.t.toFixed(1)}s · ${((100 * destroyed) / f.bhp.length).toFixed(0)}%`;
    ($('scrub') as HTMLInputElement).value = String(frameIdx);
  }
}

function tickPlayback() {
  if (playing && result?.frames) {
    const speed = Number(($('speed') as HTMLSelectElement).value);
    frameIdx = Math.min(result.frames.length - 1, frameIdx + speed);
    if (frameIdx >= result.frames.length - 1) playing = false;
    render();
  }
  requestAnimationFrame(tickPlayback);
}

function currentParams() {
  const hero = ($('hero') as HTMLSelectElement).value as 'barbarian-king' | 'archer-queen';
  const tuned = ($('tuned') as HTMLInputElement).checked ? tunedStyle(($('strategy') as HTMLSelectElement).value) : undefined;
  const tp = tuned?.params ?? {};
  return {
    timing: 1,
    ...tp,
    angle: Number(($('angle') as HTMLInputElement).value) / 360,
    spread: Number(($('spread') as HTMLInputElement).value),
    hero, equipment: tp.hero === hero && tp.equipment ? tp.equipment : HERO_EQUIPMENT[hero],
    jitter: Number(($('jitter') as HTMLInputElement).value),
  };
}

/** When a tuned setup exists for the chosen strategy, show its hero and spread in the controls. */
function syncTuned() {
  const t = ($('tuned') as HTMLInputElement).checked ? tunedStyle(($('strategy') as HTMLSelectElement).value) : undefined;
  const note = $('tunedNote');
  if (!t) { note.textContent = typeof BAKED_STYLES !== 'undefined' && BAKED_STYLES.length ? 'Using the plan as written.' : 'No tuned setups baked in yet.'; return; }
  const p = t.params;
  ($('hero') as HTMLSelectElement).value = p.hero ?? 'barbarian-king';
  const sp = $('spread') as HTMLInputElement;
  sp.value = String(Math.round((p.spread ?? 1) * 10) / 10); sp.dispatchEvent(new Event('input'));
  const swaps = (p.extra?.swaps ?? []).map((s: [string, string, number]) => `${s[2]} space ${s[0]} → ${s[1]}`).join(', ');
  note.textContent = `Tuned: ${(p.equipment ?? []).join(' + ')}${swaps ? ' · swaps: ' + swaps : ''}${p.extra?.zap ? ' · zap ' + p.extra.zap + ' AD' : ''} · timing ×${(p.timing ?? 1).toFixed(2)}`;
}

function runOne() {
  const s = strategyById(($('strategy') as HTMLSelectElement).value);
  const seed = Number(($('seed') as HTMLInputElement).value);
  const t0 = performance.now();
  try {
    result = runAttack(layout, s, currentParams(), { seed, record: true, frameEvery: 0.1 });
  } catch (e) {
    $('result').textContent = String(e);
    return;
  }
  const ms = performance.now() - t0;
  mode = 'replay'; frameIdx = 0; playing = true;
  const scrub = $('scrub') as HTMLInputElement;
  scrub.max = String(result.frames!.length - 1);
  const stars = '★'.repeat(result.stars) + '☆'.repeat(3 - result.stars);
  const lost = Object.entries(result.unitsLost).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
  const killers = Object.entries(result.killedBy).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || '—';
  $('result').innerHTML = `<div class="stars">${stars}</div><div><b>${result.pct.toFixed(0)}%</b> in ${result.time}s ${result.thDestroyed ? '· TH down' : ''}</div>
    <div class="muted">Lost: ${lost}</div><div class="muted">Top killers: ${killers}</div><div class="muted">${ms.toFixed(0)} ms</div>`;
  updateModeButtons();
}

function runMany() {
  const s = strategyById(($('strategy') as HTMLSelectElement).value);
  const p = currentParams();
  const rows: string[] = [];
  const dist = [0, 0, 0, 0];
  let pct = 0, n = 0;
  for (let a = 0; a < 8; a++) for (let seed = 1; seed <= 3; seed++) {
    const r = runAttack(layout, s, { ...p, angle: a / 8 }, { seed });
    dist[r.stars]++; pct += r.pct; n++;
    if (seed === 1) rows.push(`${a * 45}°: ${r.stars}★ ${r.pct.toFixed(0)}%`);
  }
  $('result').innerHTML = `<b>${s.name}</b> · 8 directions × 3 seeds<br>3★ ${(100 * dist[3] / n).toFixed(0)}% · 2★+ ${(100 * (dist[2] + dist[3]) / n).toFixed(0)}% · avg ${(pct / n).toFixed(0)}%<div class="muted">${rows.join('<br>')}</div>`;
}

// ---------------------------------------------------------------- editor
function placedCounts() {
  const c: Record<string, number> = {};
  for (const b of layout.buildings) c[b.type] = (c[b.type] ?? 0) + 1;
  for (const t of layout.traps) c[t.type] = (c[t.type] ?? 0) + 1;
  c.wall = layout.walls.length;
  return c;
}

function buildPalette() {
  const pal = $('palette');
  pal.innerHTML = '';
  const c = placedCounts();
  const items: [string, number][] = [
    ['town-hall', 1], ...Object.values(DATA.buildings).filter((b) => b.id !== 'town-hall').map((b) => [b.id, b.count] as [string, number]),
    ['wall', DATA.wall.count], ...Object.values(DATA.traps).map((t) => [t.id, t.count] as [string, number]),
    ['erase', 0],
  ];
  for (const [id, max] of items) {
    const btn = document.createElement('button');
    btn.className = 'pal' + (tool === id ? ' on' : '');
    btn.textContent = id === 'erase' ? 'erase' : `${ABBR[id] ?? id} ${c[id] ?? 0}/${max}`;
    btn.title = id;
    btn.onclick = () => { tool = id; buildPalette(); };
    pal.appendChild(btn);
  }
  const issues = validateLayout(layout);
  $('issues').textContent = issues.filter((i) => i.level === 'error').map((i) => i.msg).join(' · ') || 'Layout valid';
}

function cellAt(ev: MouseEvent): [number, number] {
  const r = canvas.getBoundingClientRect();
  const sx = canvas.width / r.width;
  return [Math.floor(((ev.clientX - r.left) * sx) / TILE) - B, Math.floor(((ev.clientY - r.top) * sx) / TILE) - B];
}

function eraseAt(x: number, y: number) {
  const hit = (px: number, py: number, t: string) => { const [w, h] = sizeOf(t); return x >= px && y >= py && x < px + w && y < py + h; };
  layout.buildings = layout.buildings.filter((b) => !hit(b.x, b.y, b.type));
  layout.traps = layout.traps.filter((b) => !hit(b.x, b.y, b.type));
  layout.walls = layout.walls.filter(([wx, wy]) => wx !== x || wy !== y);
}

let dragging = false;
function editAt(ev: MouseEvent) {
  if (mode !== 'edit') return;
  const [x, y] = cellAt(ev);
  if (x < 0 || y < 0 || x >= MAP.buildSize || y >= MAP.buildSize) return;
  if (tool === 'erase' || ev.buttons === 2) eraseAt(x, y);
  else if (tool === 'wall') { if (!layout.walls.some(([a, b]) => a === x && b === y)) { eraseAt(x, y); layout.walls.push([x, y]); } }
  else if (!dragging || ev.type === 'mousedown') {
    const [w, h] = sizeOf(tool);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) eraseAt(x + i, y + j);
    (DATA.traps[tool] ? layout.traps : layout.buildings).push({ type: tool, x, y });
  }
  buildPalette();
  render();
}

function updateModeButtons() {
  $('modeEdit').classList.toggle('on', mode === 'edit');
  $('modeReplay').classList.toggle('on', mode === 'replay');
}

function loadBase(id: string) {
  if (id.startsWith('arch:')) layout = decode(archetype(id.slice(5) as any), id.slice(5));
  else if (typeof BAKED_BASES !== 'undefined' && BAKED_BASES[id]) layout = JSON.parse(JSON.stringify(BAKED_BASES[id]));
  result = null; mode = 'edit';
  updateModeButtons(); buildPalette(); render();
}

function init() {
  const strat = $('strategy') as HTMLSelectElement;
  for (const s of STRATEGIES) strat.add(new Option(s.name, s.id));
  strat.onchange = syncTuned;
  ($('tuned') as HTMLInputElement).onchange = syncTuned;
  const baseSel = $('base') as HTMLSelectElement;
  const baked = typeof BAKED_BASES !== 'undefined' ? Object.keys(BAKED_BASES).filter((k) => !k.startsWith('archetype-')).sort() : [];
  for (const k of baked) baseSel.add(new Option(BAKED_BASES![k].name, k));
  for (const a of ARCHETYPES) baseSel.add(new Option(`Archetype: ${a}`, 'arch:' + a));
  baseSel.onchange = () => loadBase(baseSel.value);
  if (baked.length) { layout = JSON.parse(JSON.stringify(BAKED_BASES![baked[0]])); }
  $('run').onclick = runOne;
  $('runMany').onclick = runMany;
  $('play').onclick = () => { if (result) { mode = 'replay'; playing = !playing; updateModeButtons(); } };
  $('scrub').oninput = (e) => { frameIdx = Number((e.target as HTMLInputElement).value); playing = false; mode = 'replay'; render(); };
  $('modeEdit').onclick = () => { mode = 'edit'; playing = false; updateModeButtons(); render(); };
  $('modeReplay').onclick = () => { if (result) { mode = 'replay'; updateModeButtons(); render(); } };
  $('export').onclick = () => { ($('json') as HTMLTextAreaElement).value = JSON.stringify(layout); };
  $('import').onclick = () => {
    try { layout = JSON.parse(($('json') as HTMLTextAreaElement).value); mode = 'edit'; buildPalette(); render(); }
    catch (e) { $('issues').textContent = 'Bad JSON: ' + e; }
  };
  $('clear').onclick = () => { layout = { name: 'custom', buildings: [], walls: [], traps: [], heroes: [], cc: { dragon: 1, wizard: 1, archer: 1 } }; buildPalette(); render(); };
  for (const id of ['angle', 'spread', 'jitter']) {
    const el = $(id) as HTMLInputElement;
    const out = $(id + 'Val');
    const upd = () => { out.textContent = el.value + (id === 'angle' ? '°' : ''); };
    el.oninput = upd; upd();
  }
  canvas.addEventListener('mousedown', (e) => { dragging = true; editAt(e); });
  canvas.addEventListener('mousemove', (e) => { if (dragging && (tool === 'wall' || tool === 'erase' || e.buttons === 2)) editAt(e); });
  window.addEventListener('mouseup', () => { dragging = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
  buildPalette();
  updateModeButtons();
  syncTuned();
  render();
  tickPlayback();
}

init();
(window as any).__coc = { runAttack, get layout() { return layout; }, set layout(l: Layout) { layout = l; render(); }, render, strategyById, get result() { return result; }, setFrame(i: number) { frameIdx = i; mode = 'replay'; playing = false; render(); } };
