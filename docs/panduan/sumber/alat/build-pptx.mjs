// Membangun presentasi peluncuran KAPDH Apps (.pptx, 16:9) dari presentasi.json + tangkapan layar.
// Pemakaian: node build-pptx.mjs [--src <presentasi.json>] [--out <pptx>]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WT, ASSETS, HERE, parseFlags } from './common.mjs';
import { createRenderer, backgrounds, phone, browserFrame, icon, qr } from './deck-assets.mjs';

const require = createRequire(import.meta.url);
const pptxgen = require('pptxgenjs');
const JSZip = require(require.resolve('jszip', { paths: [require.resolve('pptxgenjs')] }));

const { flags } = parseFlags(process.argv.slice(2));
const ROOT = WT + '/docs/panduan';
const SRC = flags.src || ROOT + '/sumber/konten/presentasi.json';
const OUT = flags.out || ROOT + '/Presentasi-Peluncuran-KAPDH-Apps.pptx';
const A = path.join(HERE, '.build', 'pptx'); fs.mkdirSync(A, { recursive: true });
const deck = JSON.parse(fs.readFileSync(SRC, 'utf8'));
// Tanda hubung tak-putus (U+2011) pada kata berulang ("benar-benar") dan spasi tak-putus pada "KAPDH Apps"
// agar PowerPoint tidak memotongnya di akhir baris. Judul sampul dikecualikan (dipecah sendiri).
const SKIP_KEYS = new Set(['notes', 'screens', 'img', 'url', 'qr', 'icon', 'type', '_section']);
function nb(v, key) {
  if (typeof v === 'string') return SKIP_KEYS.has(key) ? v : v.replace(/(\p{L})-(\p{L})/gu, '$1\u2011$2').replace(/KAPDH Apps/g, 'KAPDH\u00A0Apps').replace(/Pesan Grup/g, 'Pesan\u00A0Grup').replace(/Darel Hikmah/g, 'Darel\u00A0Hikmah').replace(/Ketentuan Komunitas/g, 'Ketentuan\u00A0Komunitas')
    .replace(/(\d{1,2}) (Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember) (\d{4})/g, '$1\u00A0$2\u00A0$3');
  if (Array.isArray(v)) return SKIP_KEYS.has(key) ? v : v.map(x => nb(x, ''));
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = nb(v[k], k); return v; }
  return v;
}
for (const s of deck.slides) { const keepTitle = s.type === 'cover' ? s.title : null; nb(s, ''); if (keepTitle) s.title = keepTitle; }

// ---------- tema ----------
const THEME = {
  name: 'KAPDH',
  headFontFace: 'Segoe UI Semibold',
  bodyFontFace: 'Segoe UI',
  colors: { dk1: '1C1B1F', lt1: 'FFFFFF', dk2: '0E280C', lt2: 'F5F7F3', accent1: '1A4B17', accent2: 'E6D312', accent3: '2D7A28', accent4: 'E3F0E1', accent5: '8A5A00', accent6: 'B3261E', hlink: '2D7A28', folHlink: '215E1E' },
};
const K = { g950: '0E280C', g900: '143A12', g800: '1A4B17', g700: '215E1E', g600: '2D7A28', g100: 'E3F0E1', g50: 'F1F8F0', gold: 'E6D312', gold1: 'FBF6C9', text: '1C1B1F', muted: '5E665C', white: 'FFFFFF', card: 'E6EBE3', soft: 'F1F3EF' };
const HEAD = THEME.headFontFace, BODY = THEME.bodyFontFace, BLACK = 'Segoe UI Black';
const W = 13.333, H = 7.5;

// ---------- aset ----------
const R = await createRenderer();
const bg = await backgrounds(R, A);
const LOGO = WT + '/kapdh-mobile/assets/logo-kapdh.png';
const LOGO_AR = 350 / 360;
const pngSize = p => { const b = fs.readFileSync(p); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
async function phoneImg(rel) {
  const out = path.join(A, 'ponsel-' + path.basename(rel));
  await phone(R, path.join(ASSETS, rel), out); const z = pngSize(out); return { path: out, ar: z.w / z.h };
}
async function browserImg(rel) {
  const out = path.join(A, 'browser-' + path.basename(rel));
  await browserFrame(R, path.join(ASSETS, rel), out, rel.startsWith('admin/') ? 'admin.kapdh.or.id' : 'kapdh.or.id');
  const z = pngSize(out); return { path: out, ar: z.w / z.h };
}
async function iconImg(name, color) {
  const out = path.join(A, `ikon-${name}-${color}.png`);
  await icon(R, name, '#' + color, out); return out;
}

// ---------- presentasi ----------
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
pres.title = deck.title || 'Peluncuran KAPDH Apps';
pres.author = 'KAPDH';
pres.company = 'Perkumpulan Keluarga Alumni Pesantren Darel Hikmah';
pres.subject = 'Presentasi peluncuran KAPDH Apps';
pres.theme = { headFontFace: HEAD, bodyFontFace: BODY };

const footer = (color) => ({ text: { text: 'KAPDH Apps · Peluncuran Resmi', options: { x: 0.6, y: 6.98, w: 6, h: 0.3, fontFace: BODY, fontSize: 10, color, margin: 0 } } });
const logoObj = { image: { path: LOGO, x: 12.18, y: 0.32, w: 0.56, h: 0.56 * LOGO_AR } };
const ph = (name, type, o) => ({ placeholder: { options: { name, type, margin: 0, ...o }, text: '' } });
pres.defineSlideMaster({ title: 'KAPDH Sampul', background: { path: bg.dark },
  objects: [ph('title', 'title', { x: 0.6, y: 2.5, w: 6.9, h: 1.95, fontFace: BLACK, fontSize: 50, color: K.white, align: 'left', valign: 'top', lineSpacingMultiple: 0.95 }),
    ph('body', 'body', { x: 0.6, y: 4.6, w: 6.3, h: 1.2, fontFace: BODY, fontSize: 19, color: 'DCE6DA', align: 'left', valign: 'top' })] });
pres.defineSlideMaster({ title: 'KAPDH Seksi', background: { path: bg.dark },
  objects: [ph('title', 'title', { x: 0.6, y: 3.15, w: 11.5, h: 1.15, fontFace: HEAD, fontSize: 44, color: K.white, align: 'left', valign: 'top' }),
    ph('body', 'body', { x: 0.6, y: 4.4, w: 10.0, h: 1.2, fontFace: BODY, fontSize: 20, color: 'DCE6DA', align: 'left', valign: 'top' }), logoObj] });
pres.defineSlideMaster({ title: 'KAPDH Pernyataan', background: { path: bg.dark },
  objects: [ph('title', 'title', { x: 0.6, y: 2.2, w: 11.2, h: 2.0, fontFace: HEAD, fontSize: 38, color: K.white, align: 'left', valign: 'top' }),
    ph('body', 'body', { x: 0.6, y: 4.4, w: 10.4, h: 1.6, fontFace: BODY, fontSize: 20, color: 'DCE6DA', align: 'left', valign: 'top' }), logoObj, footer('9DB39A')],
  slideNumber: { x: 12.13, y: 6.98, w: 0.6, h: 0.3, fontFace: HEAD, fontSize: 10, color: K.gold, align: 'right' } });
pres.defineSlideMaster({ title: 'KAPDH Terang', background: { path: bg.light },
  objects: [ph('title', 'title', { x: 0.6, y: 0.7, w: 11.3, h: 1.0, fontFace: HEAD, fontSize: 28, color: K.g900, align: 'left', valign: 'top' }), logoObj, footer('5E665C')],
  slideNumber: { x: 12.13, y: 6.98, w: 0.6, h: 0.3, fontFace: HEAD, fontSize: 10, color: K.g800, align: 'right' } });
pres.defineSlideMaster({ title: 'KAPDH Terang Kiri', background: { path: bg.light },
  objects: [ph('title', 'title', { x: 0.6, y: 0.7, w: 6.0, h: 1.15, fontFace: HEAD, fontSize: 28, color: K.g900, align: 'left', valign: 'top' }), footer('5E665C')],
  slideNumber: { x: 12.13, y: 6.98, w: 0.6, h: 0.3, fontFace: HEAD, fontSize: 10, color: K.g800, align: 'right' } });
pres.defineSlideMaster({ title: 'KAPDH Gelap', background: { path: bg.dark },
  objects: [ph('title', 'title', { x: 0.6, y: 0.7, w: 7.5, h: 1.1, fontFace: HEAD, fontSize: 30, color: K.white, align: 'left', valign: 'top' }), logoObj, footer('9DB39A')],
  slideNumber: { x: 12.13, y: 6.98, w: 0.6, h: 0.3, fontFace: HEAD, fontSize: 10, color: K.gold, align: 'right' } });
pres.defineSlideMaster({ title: 'KAPDH Penutup', background: { path: bg.dark },
  objects: [ph('title', 'title', { x: 0.9, y: 2.35, w: 11.53, h: 1.15, fontFace: BLACK, fontSize: 54, color: K.white, align: 'center', valign: 'top' }),
    ph('body', 'body', { x: 1.9, y: 3.65, w: 9.53, h: 1.0, fontFace: BODY, fontSize: 20, color: 'DCE6DA', align: 'center', valign: 'top' })] });

// ---------- pembantu ----------
// Lebar teks diukur dengan Segoe UI di Chrome, lalu dibungkus per kata seperti PowerPoint.
async function measure(t, pt, wIn, face = BODY) {
  const weight = face === HEAD ? 600 : face === BLACK ? 900 : 400;
  return R.page.evaluate(({ t, pt, wIn, weight }) => {
    const c = (window.__cv ||= document.createElement('canvas').getContext('2d'));
    c.font = weight + ' ' + pt + 'pt "Segoe UI"';
    const max = wIn * 96 * 1.01; let n = 1, cur = '', widest = 0;
    for (const w of String(t).split(/[ \t\n]+/).filter(Boolean)) {
      const x = cur ? cur + ' ' + w : w;
      if (c.measureText(x).width > max && cur) { widest = Math.max(widest, c.measureText(cur).width); n++; cur = w; } else cur = x;
    }
    widest = Math.max(widest, c.measureText(cur).width);
    return { lines: n, width: widest / 96 };
  }, { t, pt, wIn, weight });
}
const est = async (t, pt, wIn, face) => (await measure(t, pt, wIn, face)).lines;
const textW = async (t, pt, face) => (await measure(t, pt, 100, face)).width;
const lineH = (pt, n, f = 1.28) => (pt * f * n) / 72;
let shapeN = 0;
const nm = (s) => `${s}-${++shapeN}`;
function kicker(slide, text, x, y, color = K.g600, w = 8) {
  if (!text) return;
  slide.addText(text.toUpperCase(), { x, y, w, h: 0.3, fontFace: HEAD, fontSize: 12, color, charSpacing: 1.5, margin: 0, isTextBox: true, objectName: nm('kicker') });
}
async function iconCircle(slide, name, x, y, d, fill, iconColor) {
  slide.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: fill }, line: { type: 'none' }, objectName: nm('lingkaran-ikon') });
  const p = await iconImg(name, iconColor); const s = d * 0.54;
  slide.addImage({ path: p, x: x + (d - s) / 2, y: y + (d - s) / 2, w: s, h: s, objectName: nm('ikon') });
}
async function bulletRows(slide, items, x, y, w, { pt = 15, color = K.text, iconName = 'ph-check-circle-fill', iconColor = K.g600, gap = 0.14 } = {}) {
  const ic = await iconImg(iconName, iconColor);
  for (const t of items) {
    const n = await est(t, pt, w - 0.42); const h = lineH(pt, n, 1.34) + 0.04;
    slide.addImage({ path: ic, x, y: y + 0.04, w: 0.26, h: 0.26, objectName: nm('ikon-butir') });
    slide.addText(t, { x: x + 0.42, y, w: w - 0.42, h, fontFace: BODY, fontSize: pt, color, margin: 0, valign: 'top', isTextBox: true, objectName: nm('butir') });
    y += h + gap;
  }
  return y;
}
const sectionTitles = [];
function addSlide(master, s) {
  const sec = s._section;
  if (sec && sectionTitles[sectionTitles.length - 1] !== sec) { pres.addSection({ title: sec }); sectionTitles.push(sec); }
  const slide = pres.addSlide({ masterName: master, sectionTitle: sec });
  if (s.notes) slide.addNotes(s.notes);
  return slide;
}

// bagian (section) PowerPoint mengikuti slide bertipe section
let curSection = 'Pembuka';
for (const s of deck.slides) { if (s.type === 'section') curSection = s.title; if (s.type === 'cta' || s.type === 'closing') curSection = s.type === 'cta' ? 'Ajakan' : curSection; s._section = curSection; }

const firstMobile = deck.slides.flatMap(s => s.screens || []).find(Boolean);

// ---------- jenis slide ----------
const RENDER = {
  async cover(s) {
    const slide = addSlide('KAPDH Sampul', s);
    slide.addImage({ path: LOGO, x: 0.6, y: 0.6, w: 0.86, h: 0.86 * LOGO_AR, objectName: 'logo' });
    slide.addText('Keluarga Alumni\nPondok Pesantren Darel Hikmah', { x: 1.62, y: 0.66, w: 4.6, h: 0.72, fontFace: HEAD, fontSize: 14, color: K.white, margin: 0, valign: 'middle', isTextBox: true, objectName: 'nama-organisasi' });
    slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.6, y: 1.85, w: 3.05, h: 0.46, rectRadius: 0.23, fill: { color: K.gold }, line: { type: 'none' }, objectName: 'pil-label' });
    slide.addText('PELUNCURAN APLIKASI', { x: 0.6, y: 1.85, w: 3.05, h: 0.46, fontFace: HEAD, fontSize: 12, color: K.g950, charSpacing: 1.5, align: 'center', valign: 'middle', margin: 0, isTextBox: true, objectName: 'label' });
    // Dua kata terakhir (mis. "KAPDH Apps") di baris kedua, kata terakhir berwarna emas.
    const words = s.title.split(' ');
    const runs = words.length > 2
      ? [{ text: words.slice(0, -2).join(' '), options: { color: K.white, breakLine: true } }, { text: words[words.length - 2] + ' ', options: { color: K.white } }, { text: words[words.length - 1], options: { color: K.gold } }]
      : words.length === 2 ? [{ text: words[0] + ' ', options: { color: K.white } }, { text: words[1], options: { color: K.gold } }] : [{ text: s.title }];
    slide.addText(runs, { placeholder: 'title' });
    slide.addText(s.subtitle, { placeholder: 'body' });
    slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.6, y: 6.15, w: 6.2, h: 0.6, rectRadius: 0.3, fill: { color: K.g950, transparency: 100 }, line: { color: K.gold, width: 1.25, transparency: 35 }, objectName: 'pil-meta' });
    slide.addText(s.meta, { x: 0.85, y: 6.15, w: 5.8, h: 0.6, fontFace: BODY, fontSize: 15, color: K.white, valign: 'middle', margin: 0, isTextBox: true, objectName: 'meta' });
    // sampul: utamakan layar yang paling mewakili (KTA, beranda, event, jejaring)
    const all = deck.slides.flatMap(x => x.screens || []).filter((v, i, a) => a.indexOf(v) === i);
    const pref = ['kta-aktif', 'beranda', 'home', 'event', 'jejaring', 'tiket'];
    const picked = [];
    for (const k of pref) { const f = all.find(v => v.includes(k) && !picked.includes(v)); if (f && picked.length < 3) picked.push(f); }
    for (const v of all) if (picked.length < 3 && !picked.includes(v)) picked.push(v);
    // urutan gambar: [tengah, kiri, kanan]
    const pics = picked;
    if (pics.length) {
      const imgs = await Promise.all(pics.map(phoneImg));
      const pos = [{ x: 7.35, y: 1.45, h: 5.35, r: -7 }, { x: 10.3, y: 1.45, h: 5.35, r: 7 }, { x: 8.75, y: 0.75, h: 6.05, r: 0 }];
      const order = imgs.length === 3 ? [1, 2, 0] : [0, 1, 2]; // pos[2] (tengah, depan) = gambar pertama
      for (const k of [0, 1, 2]) {
        const im = imgs[order[k]]; if (!im) continue;
        const p = pos[k]; const w = p.h * im.ar;
        slide.addImage({ path: im.path, x: p.x, y: p.y, w, h: p.h, rotate: p.r, objectName: nm('ponsel') });
      }
    }
  },
  async agenda(s) {
    const slide = addSlide('KAPDH Terang Kiri', s);
    slide.addText(s.title, { placeholder: 'title' });
    let y = 1.95;
    const rowH = Math.min(0.82, 4.7 / s.items.length);
    for (let i = 0; i < s.items.length; i++) {
      await iconCircle(slide, 'ph-arrow-right', 0.6, y + (rowH - 0.46) / 2, 0.46, K.g800, K.gold);
      slide.addText(s.items[i], { x: 1.3, y, w: 5.4, h: rowH, fontFace: BODY, fontSize: 20, color: K.text, valign: 'middle', margin: 0, isTextBox: true, objectName: nm('agenda') });
      if (i < s.items.length - 1) slide.addShape(pres.shapes.LINE, { x: 1.3, y: y + rowH, w: 5.4, h: 0, line: { color: K.card, width: 1 }, objectName: nm('pemisah') });
      y += rowH;
    }
    slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 7.25, y: 0.55, w: 5.5, h: 6.25, rectRadius: 0.3, fill: { color: K.g800 }, line: { type: 'none' }, objectName: 'panel' });
    if (firstMobile) { const im = await phoneImg(firstMobile); const h = 5.85; slide.addImage({ path: im.path, x: 7.25 + (5.5 - h * im.ar) / 2, y: 0.75, w: h * im.ar, h, objectName: 'ponsel' }); }
  },
  async statement(s) {
    const slide = addSlide('KAPDH Pernyataan', s);
    kicker(slide, s.kicker, 0.6, 1.75, K.gold);
    slide.addText(s.title, { placeholder: 'title' });
    slide.addText(s.text, { placeholder: 'body' });
  },
  async split(s) {
    const slide = addSlide('KAPDH Terang', s);
    slide.addText(s.title, { placeholder: 'title' });
    const NEG = /tantangan|sebelum|dulu|masalah|kendala|selama ini/i;
    const head = (t, right) => /hukum|legal|disahkan/i.test(t) ? 'ph-gavel' : /data|privasi|pelindungan/i.test(t) ? 'ph-shield-check'
      : NEG.test(t) ? 'ph-clock-counter-clockwise' : /kapdh|bersama|sekarang|aplikasi/i.test(t) ? 'ph-device-mobile' : right ? 'ph-check-circle' : 'ph-info';
    const leftNeg = NEG.test(s.left.title);
    const cards = [{ o: s.left, x: 0.6, fill: K.soft, tc: K.g900, bc: K.text, icon: leftNeg ? 'ph-x-circle-fill' : 'ph-check-circle-fill', ic: leftNeg ? '8A8F87' : K.g600, head: head(s.left.title, false), hf: leftNeg ? 'D9DED6' : K.g800, hc: leftNeg ? K.g800 : K.gold },
      { o: s.right, x: 6.83, fill: K.g800, tc: K.white, bc: 'E8F0E6', icon: 'ph-check-circle-fill', ic: K.gold, head: head(s.right.title, true), hf: K.gold, hc: K.g950 }];
    for (const c of cards) {
      slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: c.x, y: 1.95, w: 5.9, h: 4.75, rectRadius: 0.2, fill: { color: c.fill }, line: { type: 'none' }, objectName: nm('kartu') });
      await iconCircle(slide, c.head, c.x + 0.4, 2.3, 0.66, c.hf, c.hc);
      slide.addText(c.o.title, { x: c.x + 1.25, y: 2.3, w: 4.4, h: 0.66, fontFace: HEAD, fontSize: 22, color: c.tc, valign: 'middle', margin: 0, isTextBox: true, objectName: nm('judul-kartu') });
      await bulletRows(slide, c.o.points, c.x + 0.45, 3.3, 5.05, { pt: 16, color: c.bc, iconName: c.icon, iconColor: c.ic, gap: 0.2 });
    }
  },
  async section(s) {
    const slide = addSlide('KAPDH Seksi', s);
    slide.addText(s.number, { x: 0.52, y: 0.85, w: 5, h: 2.1, fontFace: BLACK, fontSize: 120, color: K.gold, margin: 0, valign: 'bottom', isTextBox: true, objectName: 'nomor-bagian' });
    slide.addText(s.title, { placeholder: 'title' });
    slide.addText(s.subtitle, { placeholder: 'body' });
  },
  async features(s) {
    const slide = addSlide('KAPDH Terang', s);
    slide.addText(s.title, { placeholder: 'title' });
    let top = 1.95;
    if (s.subtitle) { slide.addText(s.subtitle, { x: 0.6, y: 1.55, w: 11.3, h: 0.45, fontFace: BODY, fontSize: 16, color: K.muted, margin: 0, isTextBox: true, objectName: 'subjudul' }); top = 2.2; }
    const n = s.items.length, cols = n === 4 ? 4 : 3, rows = Math.ceil(n / cols);
    const gap = 0.32, cw = (12.13 - gap * (cols - 1)) / cols, chh = rows === 1 ? 4.4 : (6.72 - top - gap) / 2;
    for (let i = 0; i < n; i++) {
      const it = s.items[i], r = Math.floor(i / cols), c = i % cols;
      const x = 0.6 + c * (cw + gap), y = top + r * (chh + gap);
      const dark = (r + c) % 2 === 1;
      slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cw, h: chh, rectRadius: 0.16, fill: { color: dark ? K.g800 : K.white }, line: dark ? { type: 'none' } : { color: K.card, width: 1 }, shadow: dark ? undefined : { type: 'outer', color: '0E280C', opacity: 0.08, blur: 10, offset: 3, angle: 90 }, objectName: nm('kartu-fitur') });
      await iconCircle(slide, it.icon, x + 0.3, y + 0.3, 0.68, dark ? K.gold : K.g800, dark ? K.g950 : K.gold);
      if (rows === 1) {
        slide.addText(it.title, { x: x + 0.3, y: y + 1.2, w: cw - 0.6, h: 0.75, fontFace: HEAD, fontSize: 19, color: dark ? K.white : K.g900, margin: 0, valign: 'top', isTextBox: true, objectName: nm('judul-fitur') });
        slide.addText(it.text, { x: x + 0.3, y: y + 1.95, w: cw - 0.6, h: chh - 2.2, fontFace: BODY, fontSize: 15, color: dark ? 'E8F0E6' : K.text, margin: 0, valign: 'top', isTextBox: true, objectName: nm('teks-fitur') });
      } else {
        slide.addText(it.title, { x: x + 1.15, y: y + 0.3, w: cw - 1.4, h: 0.68, fontFace: HEAD, fontSize: 18, color: dark ? K.white : K.g900, margin: 0, valign: 'middle', isTextBox: true, objectName: nm('judul-fitur') });
        slide.addText(it.text, { x: x + 0.3, y: y + 1.12, w: cw - 0.6, h: chh - 1.3, fontFace: BODY, fontSize: 14, color: dark ? 'E8F0E6' : K.text, margin: 0, valign: 'top', isTextBox: true, objectName: nm('teks-fitur') });
      }
    }
  },
  async phone(s) {
    const slide = addSlide('KAPDH Terang Kiri', s);
    kicker(slide, s.kicker, 0.6, 0.38);
    slide.addText(s.title, { placeholder: 'title' });
    let y = 2.0;
    const tn = await est(s.text, 17, 6.0); const th = lineH(17, tn, 1.47);
    slide.addText(s.text, { x: 0.6, y, w: 6.0, h: th + 0.08, fontFace: BODY, fontSize: 17, color: '2E352D', margin: 0, valign: 'top', isTextBox: true, objectName: 'teks', lineSpacingMultiple: 1.1 });
    y += th + 0.35;
    if (s.bullets?.length) await bulletRows(slide, s.bullets, 0.6, y, 6.0, { pt: 16, gap: 0.16 });
    slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 7.0, y: 0.5, w: 5.75, h: 6.3, rectRadius: 0.3, fill: { color: K.g800 }, line: { type: 'none' }, objectName: 'panel' });
    const imgs = await Promise.all(s.screens.map(phoneImg));
    const cx = 7.0 + 5.75 / 2;
    if (imgs.length === 1) { const h = 5.95; const w = h * imgs[0].ar; slide.addImage({ path: imgs[0].path, x: cx - w / 2, y: 0.68, w, h, objectName: 'ponsel' }); }
    else if (imgs.length === 2) {
      const h = 5.55, wl = h * imgs[0].ar, wr = h * imgs[1].ar;
      slide.addImage({ path: imgs[0].path, x: 7.35, y: 1.0, w: wl, h, objectName: nm('ponsel') });
      slide.addImage({ path: imgs[1].path, x: 12.4 - wr, y: 0.65, w: wr, h, objectName: nm('ponsel') });
    }
    else { const hs = 4.9, hc = 5.85;
      const l = imgs[0], c = imgs[1], r = imgs[2];
      slide.addImage({ path: l.path, x: 7.15, y: 1.2, w: hs * l.ar, h: hs, objectName: nm('ponsel') });
      slide.addImage({ path: r.path, x: 12.6 - hs * r.ar, y: 1.2, w: hs * r.ar, h: hs, objectName: nm('ponsel') });
      slide.addImage({ path: c.path, x: cx - (hc * c.ar) / 2, y: 0.7, w: hc * c.ar, h: hc, objectName: nm('ponsel') }); }
  },
  async wide(s) {
    const slide = addSlide('KAPDH Terang', s);
    kicker(slide, s.kicker, 0.6, 0.38);
    slide.addText(s.title, { placeholder: 'title' });
    const tn = await est(s.text, 17, 3.75); const th = lineH(17, tn, 1.47);
    slide.addText(s.text, { x: 0.6, y: 2.0, w: 3.75, h: th + 0.08, fontFace: BODY, fontSize: 17, color: '2E352D', margin: 0, valign: 'top', isTextBox: true, objectName: 'teks', lineSpacingMultiple: 1.1 });
    if (s.bullets?.length) await bulletRows(slide, s.bullets, 0.6, 2.0 + th + 0.35, 3.75, { pt: 15 });
    const im = await browserImg(s.img);
    let w = 8.15, h = w / im.ar; if (h > 5.0) { h = 5.0; w = h * im.ar; }
    slide.addImage({ path: im.path, x: 12.75 - w, y: 1.8, w, h, objectName: 'tangkapan-layar' });
  },
  async steps(s) {
    const slide = addSlide('KAPDH Terang', s);
    slide.addText(s.title, { placeholder: 'title' });
    const n = s.steps.length, colW = 12.13 / n, d = 0.95, cy = 2.4;
    slide.addShape(pres.shapes.LINE, { x: 0.6 + colW / 2, y: cy + d / 2, w: colW * (n - 1), h: 0, line: { color: K.gold, width: 3 }, objectName: 'garis-alur' });
    for (let i = 0; i < n; i++) {
      const it = s.steps[i], x = 0.6 + i * colW;
      slide.addShape(pres.shapes.OVAL, { x: x + colW / 2 - d / 2, y: cy, w: d, h: d, fill: { color: K.g800 }, line: { color: K.white, width: 4 }, objectName: nm('lingkaran-langkah') });
      slide.addText(String(i + 1), { x: x + colW / 2 - d / 2, y: cy, w: d, h: d, fontFace: BLACK, fontSize: 26, color: K.gold, align: 'center', valign: 'middle', margin: 0, isTextBox: true, objectName: nm('nomor-langkah') });
      const th = lineH(19, await est(it.title, 19, colW - 0.3, HEAD), 1.2);
      slide.addText(it.title, { x: x + 0.15, y: cy + d + 0.3, w: colW - 0.3, h: th + 0.05, fontFace: HEAD, fontSize: 19, color: K.g900, align: 'center', valign: 'top', margin: 0, isTextBox: true, objectName: nm('judul-langkah') });
      slide.addText(it.text, { x: x + 0.15, y: cy + d + 0.45 + th, w: colW - 0.3, h: 1.9, fontFace: BODY, fontSize: n >= 5 ? 14 : 15, color: '2E352D', align: 'center', valign: 'top', margin: 0, isTextBox: true, objectName: nm('teks-langkah') });
    }
  },
  async stats(s) {
    const slide = addSlide('KAPDH Terang', s);
    slide.addText(s.title, { placeholder: 'title' });
    const n = s.items.length, gap = 0.3, cw = (12.13 - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const x = 0.6 + i * (cw + gap), it = s.items[i];
      slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 2.2, w: cw, h: 3.6, rectRadius: 0.18, fill: { color: i % 2 ? K.g800 : K.white }, line: i % 2 ? { type: 'none' } : { color: K.card, width: 1 }, objectName: nm('kartu-angka') });
      slide.addText(it.value, { x: x + 0.3, y: 2.6, w: cw - 0.6, h: 1.3, fontFace: BLACK, fontSize: 54, color: i % 2 ? K.gold : K.g800, margin: 0, valign: 'middle', isTextBox: true, objectName: nm('angka') });
      slide.addText(it.label, { x: x + 0.3, y: 4.0, w: cw - 0.6, h: 1.5, fontFace: BODY, fontSize: 17, color: i % 2 ? 'E8F0E6' : K.text, margin: 0, valign: 'top', isTextBox: true, objectName: nm('label-angka') });
    }
  },
  async timeline(s) {
    const slide = addSlide('KAPDH Terang', s);
    slide.addText(s.title, { placeholder: 'title' });
    const n = s.items.length, colW = 12.13 / n, ly = 3.05;
    slide.addShape(pres.shapes.LINE, { x: 0.6, y: ly, w: 12.13, h: 0, line: { color: 'B9D1B4', width: 4 }, objectName: 'garis-waktu' });
    for (let i = 0; i < n; i++) {
      const it = s.items[i], x = 0.6 + i * colW;
      slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x + 0.15, y: 2.05, w: Math.min(colW - 0.3, 2.5), h: 0.5, rectRadius: 0.25, fill: { color: K.g800 }, line: { type: 'none' }, objectName: nm('pil-tanggal') });
      slide.addText(it.date, { x: x + 0.15, y: 2.05, w: Math.min(colW - 0.3, 2.5), h: 0.5, fontFace: HEAD, fontSize: 14, color: K.white, align: 'center', valign: 'middle', margin: 0, isTextBox: true, objectName: nm('tanggal') });
      slide.addShape(pres.shapes.OVAL, { x: x + 0.15, y: ly - 0.17, w: 0.34, h: 0.34, fill: { color: K.gold }, line: { color: K.g800, width: 3 }, objectName: nm('simpul') });
      const tt = lineH(19, await est(it.title, 19, colW - 0.45, HEAD), 1.2);
      slide.addText(it.title, { x: x + 0.15, y: 3.5, w: colW - 0.45, h: tt + 0.05, fontFace: HEAD, fontSize: 19, color: K.g900, valign: 'top', margin: 0, isTextBox: true, objectName: nm('judul-waktu') });
      slide.addText(it.text, { x: x + 0.15, y: 3.5 + tt + 0.18, w: colW - 0.45, h: 2.2, fontFace: BODY, fontSize: 15, color: '2E352D', valign: 'top', margin: 0, isTextBox: true, objectName: nm('teks-waktu') });
    }
  },
  async cta(s) {
    const slide = addSlide('KAPDH Gelap', s);
    slide.addText(s.title, { placeholder: 'title' });
    const tn = await est(s.text, 19, 7.0); const th = lineH(19, tn, 1.36);
    slide.addText(s.text, { x: 0.6, y: 2.0, w: 7.0, h: th + 0.1, fontFace: BODY, fontSize: 19, color: 'DCE6DA', margin: 0, valign: 'top', isTextBox: true, objectName: 'teks' });
    let y = 2.0 + th + 0.45;
    let bwMax = 0;
    for (const a of s.actions) bwMax = Math.max(bwMax, Math.min(7.0, Math.max(3.6, (await textW(a.label, 18, HEAD)) + (await textW('   ' + a.url.replace(/^https?:\/\//, ''), 14)) + 0.75)));
    for (const a of s.actions) {
      const bw0 = Math.min(7.0, Math.max(3.6, (await textW(a.label, 18, HEAD)) + (await textW('   ' + a.url.replace(/^https?:\/\//, ''), 14)) + 0.75));
      const bw = bwMax || bw0;
      slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.6, y, w: bw, h: 0.72, rectRadius: 0.36, fill: { color: K.gold }, line: { type: 'none' }, objectName: nm('tombol') });
      slide.addText([{ text: a.label, options: { fontFace: HEAD, fontSize: 18, color: K.g950 } }, { text: '   ' + a.url.replace(/^https?:\/\//, ''), options: { fontFace: BODY, fontSize: 14, color: K.g800 } }], { x: 0.92, y, w: bw - 0.5, h: 0.72, valign: 'middle', margin: 0, isTextBox: true, objectName: nm('teks-tombol') });
      y += 1.02;
    }
    if (s.qr) {
      const q = await qr(s.qr, path.join(A, 'qr.png'));
      slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 8.75, y: 1.2, w: 3.9, h: 4.95, rectRadius: 0.25, fill: { color: K.white }, line: { type: 'none' }, objectName: 'kartu-qr' });
      slide.addImage({ path: q, x: 9.05, y: 1.5, w: 3.3, h: 3.3, objectName: 'kode-qr' });
      slide.addText([{ text: 'Pindai dengan kamera ponsel', options: { fontFace: HEAD, fontSize: 15, color: K.g900, breakLine: true } }, { text: s.qr.replace(/^https?:\/\//, ''), options: { fontFace: BODY, fontSize: 13, color: K.muted } }], { x: 8.95, y: 4.95, w: 3.5, h: 0.95, align: 'center', valign: 'middle', margin: 0, isTextBox: true, objectName: 'keterangan-qr' });
    }
  },
  async closing(s) {
    const slide = addSlide('KAPDH Penutup', s);
    slide.addImage({ path: LOGO, x: W / 2 - 0.6, y: 0.85, w: 1.2, h: 1.2 * LOGO_AR, objectName: 'logo' });
    slide.addText(s.title, { placeholder: 'title' });
    slide.addText(s.text, { placeholder: 'body' });
    const pw = Math.min(11.0, Math.max(6.4, s.contact.length * 16 * 0.5 / 72 + 1.0));
    slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: W / 2 - pw / 2, y: 5.15, w: pw, h: 0.66, rectRadius: 0.33, fill: { color: K.g950, transparency: 100 }, line: { color: K.gold, width: 1.25, transparency: 30 }, objectName: 'pil-kontak' });
    slide.addText(s.contact, { x: W / 2 - pw / 2 + 0.1, y: 5.15, w: pw - 0.2, h: 0.66, fontFace: BODY, fontSize: 16, color: K.white, align: 'center', valign: 'middle', margin: 0, isTextBox: true, objectName: 'kontak' });
  },
};

for (const [i, s] of deck.slides.entries()) {
  const fn = RENDER[s.type];
  if (!fn) { console.log(`lewati slide ${i + 1}: jenis ${s.type}`); continue; }
  await fn(s);
}
await R.close();
await pres.writeFile({ fileName: OUT });

// tulis warna merek ke tema (pptxgenjs hanya menulis font tema)
const zip = await JSZip.loadAsync(fs.readFileSync(OUT));
const part = 'ppt/theme/theme1.xml';
const SLOTS = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
let xml = await zip.file(part).async('string');
const scheme = `<a:clrScheme name="${THEME.name}">` + SLOTS.map(k => `<a:${k}><a:srgbClr val="${THEME.colors[k]}"/></a:${k}>`).join('') + '</a:clrScheme>';
xml = xml.replace(/<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/, scheme).replace(/(<a:(?:theme|fontScheme)\b[^>]*?\bname=")[^"]*"/g, (_, h) => `${h}${THEME.name}"`);
zip.file(part, xml);
for (const name of Object.keys(zip.files)) {
  if (!name.endsWith('.xml')) continue;
  const x = await zip.file(name).async('string');
  const bad = x.match(/<a:srgbClr val="(?![0-9A-Fa-f]{6}")[^"]*"/);
  if (bad) throw new Error(`warna tidak valid di ${name}: ${bad[0]}`);
}
fs.writeFileSync(OUT, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`PPTX: ${OUT} (${deck.slides.length} slide, ${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
