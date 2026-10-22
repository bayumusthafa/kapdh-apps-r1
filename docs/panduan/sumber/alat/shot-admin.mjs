// Pemakaian: node shot-admin.mjs <rute> <nama-berkas> [--steps '<json>'] [--el '<selector>'] [--full] [--w 1440] [--h 900] [--nologin]
// Masuk ke web admin MODE MOCK (http://localhost:5199) dengan akun uji proyek, buka <rute>, jalankan langkah opsional,
// lalu simpan tangkapan layar ke docs/panduan/sumber/gambar/admin/<nama>.png (DPR 1.5).
// steps: [{"click":"text=Detail"},{"fill":["input[name=q]","Ahmad"]},{"press":"Enter"},{"wait":800},{"scroll":"text=..."}]
import { launch, outPath, parseFlags, runSteps, normRoute } from './common.mjs';
const BASE = 'http://localhost:5199';
const { pos, flags } = parseFlags(process.argv.slice(2));
const [rawRoute, name] = pos; const route = normRoute(rawRoute);
if (!name) { console.error('pakai: <rute> <nama>'); process.exit(2); }
const b = await launch();
const p = await b.newPage({ viewport: { width: Number(flags.w || 1440), height: Number(flags.h || 900) }, deviceScaleFactor: 1.5 });
if (!flags.nologin) {
  await p.goto(BASE + '/login'); await p.waitForTimeout(800);
  await p.fill('input[name=email]', 'admin@kapdh.test');
  await p.fill('input[name=password]', 'Kapdh#2026');
  await p.click('button:has-text("Masuk")'); await p.waitForURL(/mfa/, { timeout: 8000 });
  await p.fill('input[name=code]', '123456'); await p.click('button[type=submit]');
  await p.waitForURL(u => !/login/.test(u.toString()), { timeout: 8000 }); await p.waitForTimeout(600);
  // navigasi di dalam SPA agar sesi tiruan (di memori) tidak hilang
  if (route !== '/') { await p.evaluate(r => { history.pushState({}, '', r); dispatchEvent(new PopStateEvent('popstate')); }, route); }
} else { await p.goto(BASE + route); }
await p.waitForTimeout(1200);
await runSteps(p, flags.steps ? JSON.parse(flags.steps) : []);
const out = outPath('admin', name);
if (flags.el) { await p.locator(flags.el).first().screenshot({ path: out, animations: 'disabled' }); }
else await p.screenshot({ path: out, fullPage: !!flags.full, animations: 'disabled' });
console.log(`OK ${out} url=${p.url()}`);
await b.close();
