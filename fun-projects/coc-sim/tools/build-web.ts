// Bundles web/app.ts (engine + data + UI) and inlines it into web/dist/index.html,
// producing one self-contained file you can open directly in a browser.
// Optional: bases/*.json are baked in so they appear in the base picker.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bases: Record<string, unknown> = {};
const bdir = join(root, 'bases');
if (existsSync(bdir)) for (const f of readdirSync(bdir).filter((f) => f.endsWith('.json'))) bases[f.slice(0, -5)] = JSON.parse(readFileSync(join(bdir, f), 'utf8'));

const out = await build({
  entryPoints: [join(root, 'web', 'app.ts')],
  bundle: true, format: 'esm', minify: true, write: false, target: 'es2022',
  define: { BAKED_BASES: JSON.stringify(bases) },
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync(join(root, 'web', 'index.html'), 'utf8').replace('/*APP*/', () => js);
mkdirSync(join(root, 'web', 'dist'), { recursive: true });
// artifact.html: page body only (the publisher adds the document skeleton)
writeFileSync(join(root, 'web', 'dist', 'artifact.html'), html);
// index.html: standalone document for opening locally
writeFileSync(join(root, 'web', 'dist', 'index.html'),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>\n${html}\n</body></html>\n`);
console.log(`web/dist/index.html ${(html.length / 1024).toFixed(0)} KB, ${Object.keys(bases).length} baked bases`);
