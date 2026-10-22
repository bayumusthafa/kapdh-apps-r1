// Pemakaian: node shot-mobile.mjs <grup/halaman.html> <nomor-frame> <nama-berkas> [opsi]
// <nomor-frame> = nomor urut dari list-frames.mjs (1, 2, ...). Menyimpan tangkapan layar perangkat (.device) mockup
// aplikasi ke docs/panduan/sumber/gambar/mobile/<nama>.png (DPR 2).
// Opsi:
//   --fix '<json>'       ganti teks di dalam frame sebelum dipotret agar sama dengan teks aplikasi terbaru:
//                        [["teks mockup", "teks aplikasi"], ["dari", "ke", nth]]  (nth opsional: kemunculan ke-n, mulai 0)
//   --fix-file <path>    sama, dari berkas JSON
//   --scroll <px>        gulir isi layar sejauh <px> (header, navigasi bawah, dan status bar tetap)
//   --sbfill             warnai status bar hijau (dipakai bila header hijau ikut tergulir)
//   --theme dark         pratinjau tema gelap
import fs from 'node:fs';
import { launch, MOCKUP, outPath, parseFlags } from './common.mjs';
import { pathToFileURL } from 'node:url';
const { pos, flags } = parseFlags(process.argv.slice(2));
const [page, frame, name] = pos;
if (!name) { console.error('pakai: <halaman> <nomor-frame> <nama> [--fix json] [--fix-file f] [--scroll px]'); process.exit(2); }
let fixes = [];
if (flags['fix-file']) fixes = fixes.concat(JSON.parse(fs.readFileSync(String(flags['fix-file']), 'utf8')));
if (flags.fix) fixes = fixes.concat(JSON.parse(String(flags.fix)));
const b = await launch(); const p = await b.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
let url = pathToFileURL(MOCKUP + '/' + page).href; if (flags.theme) url += '?theme=' + flags.theme;
await p.goto(url); await p.waitForTimeout(600);
const idx = Number(String(frame).replace(/^frame-/, '')) - 1;
const figs = await p.$$('figure.frame');
const el = figs[idx] ? await figs[idx].$('.device') : null;
if (!el) { console.error('frame tidak ditemukan: ' + frame + ' (ada ' + figs.length + ')'); await b.close(); process.exit(1); }
const res = await el.evaluate((d, { px, fixes, sbfill }) => {
  if (sbfill) { const sb = d.querySelector('.statusbar'); if (sb) sb.style.background = '#1A4B17'; }
  const walker = document.createTreeWalker(d, NodeFilter.SHOW_TEXT);
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  const seen = fixes.map(() => 0), hit = fixes.map(() => 0);
  for (const node of nodes) fixes.forEach(([from, to, nth], i) => {
    if (!node.nodeValue.includes(from)) return;
    const k = seen[i]++; if (nth !== undefined && nth !== null && nth !== k) return;
    node.nodeValue = node.nodeValue.split(from).join(to); hit[i]++;
  });
  // label aksesibilitas ikut disamakan (tidak terlihat, tetapi menjaga konsistensi)
  for (const a of d.querySelectorAll('[aria-label]')) for (const [from, to] of fixes) if (a.getAttribute('aria-label').includes(from)) a.setAttribute('aria-label', a.getAttribute('aria-label').split(from).join(to));
  let scrolled = null;
  if (px) {
    d.classList.remove('device--tall');
    const body = d.querySelector('.scroll-viewport') || d.querySelector('.screen__body');
    if (body) { body.style.overflow = 'hidden'; const inner = body.firstElementChild; if (inner) inner.style.marginTop = `-${px}px`; scrolled = px; }
  }
  return { hit, scrolled };
}, { px: flags.scroll ? Number(flags.scroll) : 0, fixes, sbfill: !!flags.sbfill });
await p.waitForTimeout(200);
const out = outPath('mobile', name);
await el.screenshot({ path: out, animations: 'disabled' });
const bb = await el.boundingBox();
const miss = fixes.filter((_, i) => !res.hit[i]).map(f => f[0]);
console.log(`OK ${out} (${Math.round(bb.width)}x${Math.round(bb.height)} css px; teks diganti ${res.hit.reduce((a, c) => a + c, 0)}${res.scrolled ? '; gulir ' + res.scrolled : ''})`);
if (miss.length) console.log('PERINGATAN teks tidak ditemukan di frame: ' + JSON.stringify(miss));
await b.close();
