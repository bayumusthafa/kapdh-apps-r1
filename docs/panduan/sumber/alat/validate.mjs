// Pemakaian: node validate.mjs <berkas.json>
// Memeriksa bab panduan (<id>.json) atau presentasi (presentasi.json) terhadap PEDOMAN-KONTEN.md: struktur, batas panjang teks,
// gambar ada di disk, ikon tersedia, dan kata terlarang. Keluar 1 bila ada galat.
import fs from 'node:fs';
import path from 'node:path';
import { ASSETS, MOCKUP } from './common.mjs';

const file = process.argv[2];
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const errors = [], warns = [];
const icons = new Set([...fs.readFileSync(MOCKUP + '/css/icons-phosphor.css', 'utf8').matchAll(/\.(ph-[a-z0-9-]+)\{/g)].map(m => m[1]));
const BANNED = /\b(endpoint|coolify|docker|vps|PRD|ADR-\d|F-\d\d|N-\d\d)\b|\.dart\b|\.tsx?\b/i;

function str(v, max, where, { required = true } = {}) {
  if (v === undefined || v === null || v === '') { if (required) errors.push(`${where}: wajib diisi`); return; }
  if (typeof v !== 'string') { errors.push(`${where}: harus string`); return; }
  if (v.length > max) errors.push(`${where}: ${v.length} karakter, maks ${max}`);
  if (/\n/.test(v)) errors.push(`${where}: berisi baris baru`);
  if (BANNED.test(v)) errors.push(`${where}: berisi istilah terlarang (${v.match(BANNED)[0]})`);
  const stars = (v.match(/\*\*/g) || []).length; if (stars % 2) errors.push(`${where}: penanda ** tidak berpasangan`);
  if (/[\u{1F300}-\u{1FAFF}]/u.test(v)) errors.push(`${where}: berisi emoji`);
}
function img(rel, where, kinds) {
  if (typeof rel !== 'string') { errors.push(`${where}: img wajib`); return; }
  const kind = rel.split('/')[0];
  if (!kinds.includes(kind)) errors.push(`${where}: img harus di ${kinds.join('/')}/ (dapat ${rel})`);
  const p = path.join(ASSETS, rel);
  if (!fs.existsSync(p)) errors.push(`${where}: berkas tidak ada ${p}`);
  return p;
}
function pngSize(p) {
  try { const b = fs.readFileSync(p); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; } catch { return null; }
}
function arr(v, min, max, where) {
  if (!Array.isArray(v)) { errors.push(`${where}: harus array`); return []; }
  if (v.length < min || v.length > max) errors.push(`${where}: ${v.length} item, harus ${min}-${max}`);
  return v;
}

if (Array.isArray(data.slides)) {
  // ---------- presentasi ----------
  str(data.title, 80, 'title');
  arr(data.slides, 10, 30, 'slides').forEach((s, i) => {
    const w = `slides[${i}](${s.type})`;
    str(s.notes, 1200, `${w}.notes`);
    const words = (s.notes || '').split(/\s+/).filter(Boolean).length;
    if (words < 40 || words > 180) warns.push(`${w}.notes: ${words} kata (target 50-160)`);
    switch (s.type) {
      case 'cover': str(s.title, 40, w + '.title'); str(s.subtitle, 100, w + '.subtitle'); str(s.meta, 60, w + '.meta'); break;
      case 'agenda': str(s.title, 40, w + '.title'); arr(s.items, 3, 6, w + '.items').forEach((t, j) => str(t, 40, `${w}.items[${j}]`)); break;
      case 'statement': str(s.kicker, 30, w + '.kicker'); str(s.title, 80, w + '.title'); str(s.text, 220, w + '.text'); break;
      case 'split': str(s.title, 60, w + '.title');
        for (const side of ['left', 'right']) { const o = s[side] || {}; str(o.title, 30, `${w}.${side}.title`); arr(o.points, 2, 4, `${w}.${side}.points`).forEach((t, j) => str(t, 90, `${w}.${side}.points[${j}]`)); }
        break;
      case 'features': str(s.title, 60, w + '.title'); str(s.subtitle, 120, w + '.subtitle', { required: false });
        arr(s.items, 4, 6, w + '.items').forEach((it, j) => { str(it.title, 26, `${w}.items[${j}].title`); str(it.text, 90, `${w}.items[${j}].text`); if (!icons.has(it.icon)) errors.push(`${w}.items[${j}].icon tidak tersedia: ${it.icon}`); });
        break;
      case 'phone': str(s.kicker, 30, w + '.kicker', { required: false }); str(s.title, 60, w + '.title'); str(s.text, 220, w + '.text');
        arr(s.bullets || [], 0, 4, w + '.bullets').forEach((t, j) => str(t, 80, `${w}.bullets[${j}]`));
        arr(s.screens, 1, 3, w + '.screens').forEach((r, j) => { const p = img(r, `${w}.screens[${j}]`, ['mobile']); const z = p && pngSize(p); if (z && z.h > 1700) errors.push(`${w}.screens[${j}]: terlalu tinggi (${z.h}px), pilih frame satu layar`); });
        break;
      case 'wide': str(s.kicker, 30, w + '.kicker', { required: false }); str(s.title, 60, w + '.title'); str(s.text, 200, w + '.text');
        arr(s.bullets || [], 0, 3, w + '.bullets').forEach((t, j) => str(t, 80, `${w}.bullets[${j}]`)); img(s.img, w + '.img', ['admin', 'web']); break;
      case 'steps': str(s.title, 60, w + '.title'); arr(s.steps, 3, 5, w + '.steps').forEach((it, j) => { str(it.title, 26, `${w}.steps[${j}].title`); str(it.text, 90, `${w}.steps[${j}].text`); }); break;
      case 'stats': str(s.title, 60, w + '.title'); arr(s.items, 3, 4, w + '.items').forEach((it, j) => { str(it.value, 10, `${w}.items[${j}].value`); str(it.label, 48, `${w}.items[${j}].label`); }); break;
      case 'section': str(s.number, 3, w + '.number'); str(s.title, 40, w + '.title'); str(s.subtitle, 120, w + '.subtitle'); break;
      case 'timeline': str(s.title, 60, w + '.title'); arr(s.items, 3, 5, w + '.items').forEach((it, j) => { str(it.date, 24, `${w}.items[${j}].date`); str(it.title, 40, `${w}.items[${j}].title`); str(it.text, 90, `${w}.items[${j}].text`); }); break;
      case 'cta': str(s.title, 60, w + '.title'); str(s.text, 200, w + '.text'); arr(s.actions, 1, 3, w + '.actions').forEach((a, j) => { str(a.label, 30, `${w}.actions[${j}].label`); str(a.url, 120, `${w}.actions[${j}].url`); }); if (s.qr) str(s.qr, 120, w + '.qr'); break;
      case 'closing': str(s.title, 40, w + '.title'); str(s.text, 160, w + '.text'); str(s.contact, 100, w + '.contact'); break;
      default: errors.push(`${w}: type tidak dikenal`);
    }
  });
} else {
  // ---------- bab panduan ----------
  str(data.id, 8, 'id');
  if (!['anggota', 'pengurus', 'publik', 'umum', 'bantuan'].includes(data.part)) errors.push('part tidak valid');
  str(data.title, 48, 'title'); str(data.kicker, 32, 'kicker'); str(data.summary, 260, 'summary');
  if (!icons.has(data.icon)) errors.push(`icon tidak tersedia: ${data.icon}`);
  arr(data.highlights, 3, 5, 'highlights').forEach((t, i) => str(t, 70, `highlights[${i}]`));
  if (!Array.isArray(data.sources) || !data.sources.length) errors.push('sources wajib diisi');
  let nScreens = 0, nShots = 0;
  arr(data.sections, 2, 9, 'sections').forEach((sec, i) => {
    const w = `sections[${i}]`;
    str(sec.id, 16, w + '.id'); str(sec.title, 60, w + '.title');
    let visual = false, runScreens = 0;
    arr(sec.blocks, 1, 30, w + '.blocks').forEach((b, j) => {
      const bw = `${w}.blocks[${j}](${b.type})`;
      if (b.type === 'screens') { runScreens++; if (runScreens > 3) errors.push(`${bw}: lebih dari 3 blok screens berturut-turut`); } else runScreens = 0;
      switch (b.type) {
        case 'p': str(b.text, 700, bw + '.text'); break;
        case 'steps': str(b.title, 80, bw + '.title', { required: false }); arr(b.items, 2, 8, bw + '.items').forEach((it, k) => { str(it.title, 70, `${bw}.items[${k}].title`, { required: false }); str(it.text, 300, `${bw}.items[${k}].text`); }); break;
        case 'list': str(b.title, 80, bw + '.title', { required: false }); arr(b.items, 1, 10, bw + '.items').forEach((t, k) => str(t, 220, `${bw}.items[${k}]`)); break;
        case 'screens': { visual = true; const items = arr(b.items, 1, 3, bw + '.items');
          items.forEach((it, k) => { nScreens++; str(it.caption, 90, `${bw}.items[${k}].caption`); const p = img(it.img, `${bw}.items[${k}]`, ['mobile']); const z = p && pngSize(p); if (z && z.h > 2000 && items.length > 1) errors.push(`${bw}.items[${k}]: gambar tinggi (${z.h}px) harus sendirian`); });
          break; }
        case 'shot': visual = true; nShots++; str(b.caption, 140, bw + '.caption'); img(b.img, bw + '.img', ['admin', 'web']); break;
        case 'callout': visual = true; if (!['tip', 'info', 'warning', 'penting'].includes(b.variant)) errors.push(`${bw}.variant tidak valid`); str(b.title, 70, bw + '.title', { required: false }); str(b.text, 400, bw + '.text'); break;
        case 'table': { visual = true; str(b.title, 80, bw + '.title', { required: false }); const cols = arr(b.columns, 2, 4, bw + '.columns'); cols.forEach((c, k) => str(c, 40, `${bw}.columns[${k}]`));
          arr(b.rows, 1, 12, bw + '.rows').forEach((r, k) => { if (!Array.isArray(r) || r.length !== cols.length) errors.push(`${bw}.rows[${k}]: jumlah sel != kolom`); else r.forEach((c, m) => str(c, 200, `${bw}.rows[${k}][${m}]`)); });
          break; }
        case 'status': visual = true; str(b.title, 80, bw + '.title', { required: false }); arr(b.items, 1, 10, bw + '.items').forEach((it, k) => { str(it.label, 40, `${bw}.items[${k}].label`); str(it.text, 220, `${bw}.items[${k}].text`); if (!['success', 'warning', 'danger', 'info', 'neutral'].includes(it.tone)) errors.push(`${bw}.items[${k}].tone tidak valid`); }); break;
        case 'faq': visual = true; arr(b.items, 1, 14, bw + '.items').forEach((it, k) => { str(it.q, 160, `${bw}.items[${k}].q`); str(it.a, 600, `${bw}.items[${k}].a`); }); break;
        default: errors.push(`${bw}: type tidak dikenal`);
      }
    });
    if (!visual) warns.push(`${w} "${sec.title}": tanpa visual`);
  });
  console.log(`ringkas: ${data.sections?.length} subbab, ${nScreens} layar ponsel, ${nShots} tangkapan lebar`);
}
// gambar milik bab yang tidak dipakai
const prefix = (data.id || 'deck') + '-';
const used = new Set(JSON.stringify(data).match(/(mobile|admin|web)\/[^"]+\.png/g) || []);
for (const k of ['mobile', 'admin', 'web']) {
  const dir = path.join(ASSETS, k); if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) if (f.startsWith(Array.isArray(data.slides) ? 'deck-' : prefix) && !used.has(`${k}/${f}`)) warns.push(`gambar tak terpakai: ${k}/${f}`);
}
for (const w of warns) console.log('PERINGATAN ' + w);
for (const e of errors) console.log('GALAT ' + e);
console.log(errors.length ? `GAGAL: ${errors.length} galat` : 'LULUS');
process.exit(errors.length ? 1 : 0);
