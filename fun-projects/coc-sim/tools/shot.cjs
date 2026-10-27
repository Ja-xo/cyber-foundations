// Screenshot replay frames of the web app (dev aid).
// node tools/shot.cjs <strategy> <base-archetype> <angleDeg> <times comma list> <outprefix>
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const [sid = 'mass-dragon', base = 'ring-core', ang = '0', times = '5,20,40', out = '/tmp/shot'] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto('file://' + path.resolve(__dirname, '../web/dist/index.html'));
  await page.selectOption('#base', 'arch:' + base);
  await page.selectOption('#strategy', sid);
  await page.evaluate((a) => { const el = document.getElementById('angle'); el.value = a; el.dispatchEvent(new Event('input')); }, ang);
  await page.click('#run');
  console.log(await page.textContent('#result'));
  for (const t of times.split(',')) {
    await page.evaluate((t) => { const r = window.__coc.result; const i = r.frames.findIndex((f) => f.t >= Number(t)); window.__coc.setFrame(i < 0 ? r.frames.length - 1 : i); }, t);
    await page.locator('#board').screenshot({ path: `${out}-${t}.png` });
  }
  await browser.close();
})();
