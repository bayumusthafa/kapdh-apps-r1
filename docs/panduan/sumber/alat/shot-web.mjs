// Pemakaian: node shot-web.mjs <path> <nama-berkas> [--mobile] [--full] [--steps '<json>'] [--el '<selector>']
// Situs publik (Astro dev, http://localhost:4399) -> docs/panduan/sumber/gambar/web/<nama>.png
import { launch, outPath, parseFlags, runSteps, normRoute } from './common.mjs';
const BASE = 'http://localhost:4399';
const { pos, flags } = parseFlags(process.argv.slice(2));
const [rawRoute, name] = pos; const route = normRoute(rawRoute);
const b = await launch();
const p = await b.newPage(flags.mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true } : { viewport: { width: 1366, height: 860 }, deviceScaleFactor: 1.5 });
await p.goto(BASE + route); await p.waitForTimeout(1500);
await runSteps(p, flags.steps ? JSON.parse(flags.steps) : []);
const out = outPath('web', name);
if (flags.el) await p.locator(flags.el).first().screenshot({ path: out });
else await p.screenshot({ path: out, fullPage: !!flags.full });
console.log(`OK ${out} url=${p.url()}`);
await b.close();
