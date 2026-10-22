// Membangun Panduan Penggunaan KAPDH Apps (PDF A4) dari konten JSON + tangkapan layar.
// Pemakaian: node build-pdf.mjs [--only b02,b03] [--out <pdf>] [--html-only]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { launch, WT, ASSETS, MOCKUP, HERE, parseFlags } from './common.mjs';
import { loadIcons, iconSvg } from './icons.mjs';

const { flags } = parseFlags(process.argv.slice(2));
const ROOT = WT + '/docs/panduan';
const KONTEN = flags.konten || ROOT + '/sumber/konten';
const BUILD = path.join(HERE, '.build', 'pdf');
const OUT = flags.out || ROOT + '/Panduan-Penggunaan-KAPDH-Apps.pdf';
const TOOLS = HERE;
fs.mkdirSync(BUILD + '/img', { recursive: true });
fs.mkdirSync(BUILD + '/fonts', { recursive: true });

const ICONS = loadIcons(MOCKUP + '/css/icons-phosphor.css');
const ic = (n, c) => iconSvg(ICONS, n, c);

// ---------- urutan dan bagian ----------
const PARTS = [
  { key: 'umum', letter: '', title: 'Pengenalan', ids: ['b01'] },
  { key: 'anggota', letter: 'A', title: 'Aplikasi Anggota', icon: 'ph-device-mobile',
    desc: 'Untuk alumni: mendaftar, membayar iuran, memakai KTA digital, mengikuti event, terhubung lewat Jejaring, dan mengatur akun.',
    ids: ['b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08'] },
  { key: 'pengurus', letter: 'B', title: 'Web Admin Pengurus', icon: 'ph-desktop',
    desc: 'Untuk pengurus: memverifikasi pembayaran, mengelola data alumni, konten, event, moderasi, admin, dan pengaturan.',
    ids: ['b09', 'b10', 'b11', 'b12', 'b13', 'b14', 'b15'] },
  { key: 'publik', letter: 'C', title: 'Situs Publik', icon: 'ph-globe',
    desc: 'Situs kapdh.or.id untuk umum: informasi perkumpulan, unduh aplikasi, verifikasi KTA, dan hapus akun.',
    ids: ['b16'] },
  { key: 'bantuan', letter: 'D', title: 'Bantuan', icon: 'ph-question',
    desc: 'Tanya jawab, pemecahan masalah, daftar istilah, dan cara menghubungi tim bantuan.',
    ids: ['b17'] },
];
const only = flags.only ? new Set(String(flags.only).split(',')) : null;
const chapters = [];
let num = 0;
for (const part of PARTS) {
  part.chapters = [];
  for (const id of part.ids) {
    num++;
    const f = `${KONTEN}/${id}.json`;
    if (!fs.existsSync(f) || (only && !only.has(id))) continue;
    const ch = JSON.parse(fs.readFileSync(f, 'utf8'));
    ch.num = num; ch.partObj = part;
    part.chapters.push(ch); chapters.push(ch);
  }
}

// ---------- gambar ----------
const imgCache = new Map();
async function prepImage(rel) {
  if (imgCache.has(rel)) return imgCache.get(rel);
  const src = path.join(ASSETS, rel);
  const kind = rel.split('/')[0];
  const base = rel.replace(/[\/\\]/g, '__').replace(/\.png$/, '.jpg');
  const dst = path.join(BUILD, 'img', base);
  const meta = await sharp(src).metadata();
  const maxW = kind === 'mobile' ? 540 : 1440;
  if (!fs.existsSync(dst) || fs.statSync(dst).mtimeMs < fs.statSync(src).mtimeMs) {
    await sharp(src).flatten({ background: '#ffffff' }).resize({ width: Math.min(maxW, meta.width) }).jpeg({ quality: 80, mozjpeg: true }).toFile(dst);
  }
  const info = { src: 'img/' + base, w: meta.width, h: meta.height, kind };
  imgCache.set(rel, info);
  return info;
}
async function copyAsset(src, name) { const d = path.join(BUILD, 'img', name); fs.copyFileSync(src, d); return 'img/' + name; }

// ---------- teks ----------
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const md = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/ - /g, ' – ').replace(/\b(Bab|Bagian|Langkah) (\d+|[A-D])\b/g, '$1&nbsp;$2');
const pad2 = n => String(n).padStart(2, '0');

// ---------- blok ----------
const CALLOUT = {
  tip: { icon: 'ph-star-fill', label: 'Tips' },
  info: { icon: 'ph-info-fill', label: 'Info' },
  warning: { icon: 'ph-warning-fill', label: 'Perhatian' },
  penting: { icon: 'ph-warning-circle-fill', label: 'Penting' },
};
// Skala per gambar dari langkah penyesuaian: gambar yang terdorong ke halaman berikut diperkecil secukupnya.
const SCALE = new Map();
const sc = img => SCALE.get(img) || 1;
async function phone(item, size, key) {
  size = Math.round(size * sc(key || item.img) * 10) / 10;
  const im = await prepImage(item.img);
  const tall = im.h / im.w > 2.6;
  return `<figure class="phone ${tall ? 'tall' : ''}" style="--pw:${size}mm">
    <div class="bezel"><div class="glass"><img src="${im.src}" alt=""></div></div>
    ${item.caption ? `<figcaption>${md(item.caption)}</figcaption>` : ''}</figure>`;
}
// Lebar kolom tabel (persen dari 174 mm). Kolom tidak boleh lebih sempit dari kata terpanjangnya (agar kata tidak
// terpotong), kolom berisi teks pendek dibuat pas isinya, sisa lebar dibagi menurut panjang isi.
const plain = t => String(t).replace(/\*\*/g, '');
const CHW = 1.85, PAD = 7, TOTAL = 174;
function tableWidths(b) {
  const n = b.columns.length;
  const cells = k => [b.columns[k], ...b.rows.map(r => r[k])].map(plain);
  const longestWord = k => Math.max(...cells(k).flatMap(t => t.split(/\s+/)).map(w => w.length));
  const maxLen = k => Math.max(...cells(k).map(t => t.length));
  const avg = k => b.rows.reduce((a, r) => a + plain(r[k]).length, 0) / b.rows.length;
  const short = b.columns.map((_, k) => maxLen(k) <= 12);
  const minW = b.columns.map((_, k) => Math.min(72, Math.max(short[k] ? maxLen(k) : longestWord(k), 3) * CHW + PAD));
  const w = b.columns.map((_, k) => short[k] ? minW[k] : 0);
  let free = b.columns.map((_, k) => k).filter(k => !short[k]);
  const weight = k => Math.max(10, Math.min(120, (avg(k) + maxLen(k)) / 2));
  for (let guard = 0; guard < 5 && free.length; guard++) {
    const rest = TOTAL - w.reduce((a, v, k) => a + (free.includes(k) ? 0 : v), 0);
    const tw = free.reduce((a, k) => a + weight(k), 0);
    const firstMin = n === 2 ? 42 : 30;
    const clamped = free.filter(k => { const share = rest * weight(k) / tw; const need = Math.max(minW[k], k === 0 ? firstMin : 26); if (share < need) { w[k] = need; return true; } return false; });
    if (!clamped.length) { for (const k of free) w[k] = rest * weight(k) / tw; break; }
    free = free.filter(k => !clamped.includes(k));
  }
  const sum = w.reduce((a, v) => a + v, 0);
  return w.map(v => Math.round(v / sum * 1000) / 10);
}
// Perkiraan tinggi tabel (mm) untuk memutuskan apakah judul subbab dikunci bersama tabel utuh.
function tableHeightMm(b) {
  const pct = tableWidths(b), CH = 1.7;
  const rowsH = b.rows.reduce((a, r) => a + 4.6 + 4.5 * Math.max(...r.map((t, k) => Math.ceil(plain(t).length * CH / Math.max(8, 174 * pct[k] / 100 - 6)))), 0);
  return rowsH + 9 + (b.title ? 9 : 0);
}
async function block(b) {
  switch (b.type) {
    case 'p': return `<p>${md(b.text)}</p>`;
    case 'steps': return `<div class="steps">${b.title ? `<h4 class="blk-title">${md(b.title)}</h4>` : ''}<ol>${b.items.map(it => `<li><div class="st-body">${it.title ? `<strong>${md(it.title)}</strong>` : ''}<span>${md(it.text)}</span></div></li>`).join('')}</ol></div>`;
    case 'list': return `<div class="list">${b.title ? `<h4 class="blk-title">${md(b.title)}</h4>` : ''}<ul>${b.items.map(t => `<li>${md(t)}</li>`).join('')}</ul></div>`;
    case 'screens': {
      const n = b.items.length;
      const size = n === 1 ? 50 : n === 2 ? 46 : 42;
      const figs = await Promise.all(b.items.map(it => phone(it, size, b.items[0].img)));
      return `<div class="screens n${n}" data-fit="${b.items[0].img}">${figs.join('')}</div>`;
    }
    case 'shot': {
      const im = await prepImage(b.img);
      // tampilan ponsel situs publik -> bingkai ponsel; potongan web admin yang tegak (dialog) tetap di bingkai browser, lebih sempit
      if (im.h > im.w * 1.2 && im.kind !== 'admin') return `<div class="screens n1" data-fit="${b.img}">${await phone({ img: b.img, caption: b.caption }, 56)}</div>`;
      const host = im.kind === 'admin' ? 'admin.kapdh.or.id' : 'kapdh.or.id';
      let bw = im.h > im.w * 0.9 ? Math.max(90, Math.min(174, Math.round(150 * im.w / im.h))) : 174;
      bw = Math.round(bw * sc(b.img));
      const narrow = bw < 174 ? ` narrow" style="--bw:${bw}mm` : '';
      return `<figure data-fit="${b.img}" class="browser${narrow}"><div class="chrome"><span class="dots"><i></i><i></i><i></i></span><span class="url">${ic('ph-lock-simple-fill', 'ic lock')}${host}</span></div>
        <div class="viewport"><img src="${im.src}" alt=""></div>${b.caption ? `<figcaption>${md(b.caption)}</figcaption>` : ''}</figure>`;
    }
    case 'callout': {
      const c = CALLOUT[b.variant] || CALLOUT.info;
      return `<aside class="callout ${b.variant}"><div class="co-icon">${ic(c.icon)}</div><div class="co-body"><div class="co-title">${esc(b.title || c.label)}</div><p>${md(b.text)}</p></div></aside>`;
    }
    case 'table': {
      // kolom berisi teks pendek (mis. "Bab 9") tidak dipecah baris
      const short = b.columns.map((c, k) => Math.max(plain(c).length, ...b.rows.map(r => plain(r[k]).length)) <= 12);
      const cell = (t, k, tag) => `<${tag}${short[k] ? ' class="nw"' : ''}>${md(t)}</${tag}>`;
      const pct = tableWidths(b);
      return `<div class="tbl${b.rows.length <= 6 ? ' small' : ''}">${b.title ? `<h4 class="blk-title">${md(b.title)}</h4>` : ''}<table class="c${b.columns.length}"><colgroup>${pct.map(p => `<col style="width:${p}%">`).join('')}</colgroup><thead><tr>${b.columns.map((c, k) => cell(c, k, 'th')).join('')}</tr></thead><tbody>${b.rows.map(r => `<tr>${r.map((c, k) => cell(c, k, 'td')).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    case 'status': return `<div class="status">${b.title ? `<h4 class="blk-title">${md(b.title)}</h4>` : ''}<div class="st-grid">${b.items.map(it => `<div class="st-item"><span class="chip ${it.tone}"><i></i>${esc(it.label)}</span><p>${md(it.text)}</p></div>`).join('')}</div></div>`;
    case 'faq': return `<div class="faq">${b.items.map(it => `<div class="qa"><div class="q">${ic('ph-question')}<span>${md(it.q)}</span></div><p class="a">${md(it.a)}</p></div>`).join('')}</div>`;
    default: return '';
  }
}

// ---------- motif ----------
function arcs(cls = 'arcs') {
  // Busur konsentris seperti pada Guidelines KAPDH (pojok kanan atas dan kiri bawah).
  const ring = (cx, cy, rs) => rs.map(r => `<circle cx="${cx}" cy="${cy}" r="${r}" />`).join('');
  return `<svg class="${cls}" viewBox="0 0 210 297" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <g fill="none" stroke="currentColor" stroke-width="7">${ring(210, 0, [40, 58, 76, 94])}${ring(0, 297, [46, 64, 82, 100])}</g></svg>`;
}

// ---------- halaman ----------
async function cover() {
  const logo = await copyAsset(WT + '/kapdh-mobile/assets/logo-kapdh.png', 'logo.png');
  const shots = ['b01-beranda.png', 'b04-kta-aktif.png', 'b06-daftar-event.png'];
  const avail = [];
  for (const s of shots) { if (fs.existsSync(path.join(ASSETS, 'mobile', s))) avail.push(await prepImage('mobile/' + s)); }
  // cadangan: ambil gambar ponsel apa pun yang ada
  if (avail.length < 3) {
    for (const f of fs.readdirSync(path.join(ASSETS, 'mobile')).filter(f => /\.png$/.test(f) && !shots.includes(f)).slice(0, 3 - avail.length)) avail.push(await prepImage('mobile/' + f));
  }
  return `<section class="cover">
    ${arcs('arcs cover-arcs')}
    <div class="cv-top"><img class="cv-logo" src="${logo}" alt="Logo KAPDH"><div class="cv-org">Keluarga Alumni<br>Pondok Pesantren Darel Hikmah</div></div>
    <div class="cv-title">
      <div class="cv-kicker">Panduan Penggunaan</div>
      <h1>KAPDH <span>Apps</span></h1>
      <p>Panduan lengkap aplikasi anggota, web admin pengurus, dan situs kapdh.or.id</p>
    </div>
    <div class="cv-phones">${avail.map((im, i) => `<div class="cv-ph p${i}"><div class="bezel"><div class="glass"><img src="${im.src}" alt=""></div></div></div>`).join('')}</div>
    <div class="cv-pill"><span>Rilis 1.0</span><span>Oktober 2026</span></div>
  </section>`;
}

function about() {
  const parts = PARTS.filter(p => p.letter);
  return `<section class="front about">
    <div class="eyebrow">Sebelum mulai</div>
    <h1 class="front-title">Tentang panduan ini</h1>
    <p class="lead">Panduan ini menjelaskan cara memakai seluruh layanan KAPDH Apps, dari mendaftar sebagai anggota sampai mengelola data alumni sebagai pengurus. Bacalah bagian yang sesuai dengan peran Anda; setiap bab dapat dibaca terpisah.</p>
    <div class="parts-grid">${parts.map(p => `<div class="pg-item"><div class="pg-icon">${ic(p.icon)}</div><div><div class="pg-letter">Bagian ${p.letter}</div><div class="pg-title">${p.title}</div><p>${p.desc}</p></div></div>`).join('')}</div>
    <h3 class="front-sub">Cara membaca panduan</h3>
    <div class="conv">
      <div class="conv-item"><div class="conv-key"><b>Masuk</b></div><p>Nama tombol, menu, tab, dan label di layar dicetak tebal, persis seperti yang tampil di aplikasi.</p></div>
      <div class="conv-item"><div class="conv-key"><span class="mini-steps"><i>1</i><i>2</i><i>3</i></span></div><p>Langkah bernomor diikuti berurutan dari atas ke bawah.</p></div>
      ${['tip', 'info', 'warning', 'penting'].map(v => `<div class="conv-item"><div class="conv-key"><span class="mini-co ${v}">${ic(CALLOUT[v].icon)}${CALLOUT[v].label}</span></div><p>${{ tip: 'Saran agar pekerjaan lebih mudah atau cepat.', info: 'Penjelasan tambahan yang perlu diketahui.', warning: 'Hal yang perlu diperhatikan agar tidak terjadi kesalahan.', penting: 'Aturan atau akibat yang tidak dapat dibatalkan.' }[v]}</p></div>`).join('')}
    </div>
    <aside class="note-box">${ic('ph-info')}<p>Nama, nomor KTA, nominal, dan tanggal pada gambar adalah <b>data contoh</b>, bukan data anggota sebenarnya. Tarif iuran resmi ditetapkan pengurus dan dapat berubah. Tampilan pada perangkat Anda dapat sedikit berbeda menurut ukuran layar, tema, dan versi aplikasi.</p></aside>
  </section>`;
}

function toc() {
  const rows = [];
  for (const p of PARTS) {
    if (!p.chapters.length) continue;
    if (p.letter) rows.push(`<div class="toc-part"><span>Bagian ${p.letter}</span>${p.title}</div>`);
    for (const ch of p.chapters) {
      rows.push(`<a class="toc-ch" href="#${ch.id}"><span class="toc-num">${pad2(ch.num)}</span><span class="toc-t">${esc(ch.title)}</span><span class="fill"></span></a>`);
      rows.push(`<div class="toc-secs">${ch.sections.map((s, i) => `<a class="toc-sec" href="#${s.id}"><span class="toc-sn">${ch.num}.${i + 1}</span><span class="toc-t">${md(s.title)}</span><span class="fill"></span></a>`).join('')}</div>`);
    }
  }
  return `<nav class="toc"><div class="eyebrow">Isi</div><h1 class="front-title">Daftar isi</h1>${rows.join('')}</nav>`;
}

function partDivider(p) {
  return `<section class="part-div" id="part-${p.key}">
    ${arcs('arcs part-arcs')}
    <div class="pd-letter">${p.letter}</div>
    <div class="pd-body">
      <div class="pd-kicker">Bagian ${p.letter}</div>
      <h1>${p.title}</h1>
      <p>${p.desc}</p>
      <ol class="pd-list">${p.chapters.map(ch => `<li><span>${pad2(ch.num)}</span>${esc(ch.title)}</li>`).join('')}</ol>
    </div>
  </section>`;
}

async function chapter(ch) {
  const secs = [];
  for (let i = 0; i < ch.sections.length; i++) {
    const s = ch.sections[i];
    // Layar ponsel tunggal ditaruh berdampingan dengan blok teks di dekatnya (sebelum, atau sesudah bila tidak ada)
    // agar halaman tidak menyisakan ruang kosong lebar.
    const TEXTY = new Set(['p', 'steps', 'list', 'callout']);
    const items = [];
    for (const b of s.blocks) items.push({ b, html: await block(b) });
    const out = [];
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      const single = it.b.type === 'screens' && it.b.items.length === 1;
      if (single) {
        const prev = out[out.length - 1];
        const next = items[k + 1];
        const fig = await phone(it.b.items[0], 48);
        if (prev && !prev.paired && TEXTY.has(prev.b.type) && prev.len < 1400) {
          out[out.length - 1] = { b: prev.b, paired: true, html: `<div class="pair" data-fit="${it.b.items[0].img}"><div class="pair-text">${prev.html}</div><div class="pair-fig" style="width:${48 * sc(it.b.items[0].img)}mm">${fig}</div></div>` };
          continue;
        }
        if (next && TEXTY.has(next.b.type)) {
          out.push({ b: next.b, paired: true, html: `<div class="pair" data-fit="${it.b.items[0].img}"><div class="pair-text">${next.html}</div><div class="pair-fig" style="width:${48 * sc(it.b.items[0].img)}mm">${fig}</div></div>` });
          k++; continue;
        }
      }
      out.push({ ...it, len: JSON.stringify(it.b).length });
    }
    // Judul subbab dikunci bersama blok pertamanya (tidak yatim di dasar halaman), kecuali blok pertama panjang dan
    // boleh terbelah (tabel/daftar tanya jawab besar). id dipasang pada judul agar daftar isi menunjuk halaman judul.
    const h2 = `<h2 id="${s.id}"><span class="sn">${ch.num}.${i + 1}</span>${md(s.title)}</h2>`;
    const first = out[0];
    const splittable = first && ((first.b.type === 'table' && tableHeightMm(first.b) > 170) || (first.b.type === 'faq' && first.b.items.length > 3) || (first.b.type === 'steps' && first.b.items.length > 6 && !first.paired));
    // tabel panjang: judul ikut tabel (.mv); bila di dasar halaman belum ada baris, handler memindahkan keduanya ke halaman berikut
    const head = first && !splittable ? `<div class="keep">${h2}${first.html}</div>` : first && first.b.type === 'table' ? `<div class="mv">${h2}${first.html}</div>` : h2 + (first ? first.html : '');
    secs.push(`<section class="sec">${head}${out.slice(1).map(o => o.html).join('\n')}</section>`);
  }
  return `<article class="chapter part-${ch.part}" id="${ch.id}" data-title="${esc(ch.title)}">
    <header class="ch-head">
      ${arcs('arcs head-arcs')}
      <div class="ch-meta"><span class="ch-num">Bab ${pad2(ch.num)}</span><span class="ch-kicker">${esc(ch.kicker)}</span></div>
      <div class="ch-icon">${ic(ch.icon)}</div>
      <h1 class="ch-title">${esc(ch.title)}</h1>
      <p class="ch-sum">${md(ch.summary)}</p>
      <div class="ch-learn"><div class="cl-title">Yang akan Anda pelajari</div><ul>${ch.highlights.map(h => `<li>${ic('ph-check-circle-fill')}<span>${md(h)}</span></li>`).join('')}</ul></div>
    </header>
    ${secs.join('\n')}
  </article>`;
}

function backCover() {
  return `<section class="back">
    ${arcs('arcs back-arcs')}
    <img class="bk-logo" src="img/logo.png" alt="Logo KAPDH">
    <h2>Butuh bantuan?</h2>
    <p>Tim bantuan KAPDH siap membantu kendala akun, iuran, KTA, dan event.</p>
    <div class="bk-contacts">
      <div>${ic('ph-envelope-simple')}<span>bantuan@kapdh.or.id</span></div>
      <div>${ic('ph-globe')}<span>kapdh.or.id</span></div>
      <div>${ic('ph-book-open-text')}<span>kapdh.or.id/bantuan</span></div>
    </div>
    <div class="bk-legal">Perkumpulan Keluarga Alumni Pesantren Darel Hikmah (KAPDH)<br>Badan hukum perkumpulan, SK Menteri Hukum dan HAM Nomor AHU-0002732.AH.01.07.TAHUN 2023<br>Jalan Manyar Sakti, Kelurahan Simpang Baru, Kecamatan Binawidya, Kota Pekanbaru, Riau 28293</div>
    <div class="bk-foot">Panduan Penggunaan KAPDH Apps · Rilis 1.0 · Oktober 2026</div>
  </section>`;
}

// ---------- rakit ----------
for (const f of fs.readdirSync(MOCKUP + '/fonts').filter(f => f.endsWith('.woff2'))) fs.copyFileSync(MOCKUP + '/fonts/' + f, BUILD + '/fonts/' + f);
fs.copyFileSync(TOOLS + '/panduan.css', BUILD + '/panduan.css');
fs.copyFileSync(TOOLS + '/paged-handlers.js', BUILD + '/paged-handlers.js');
fs.copyFileSync(path.join(HERE, 'node_modules', 'pagedjs', 'dist', 'paged.polyfill.js'), BUILD + '/paged.polyfill.js');

async function assemble() {
const body = [await cover(), about(), toc()];
for (const p of PARTS) {
  if (!p.chapters.length) continue;
  if (p.letter) body.push(partDivider(p));
  for (const ch of p.chapters) body.push(await chapter(ch));
}
body.push(backCover());

return `<!doctype html><html lang="id"><head><meta charset="utf-8">
<title>Panduan Penggunaan KAPDH Apps</title>
<link rel="stylesheet" href="panduan.css">
<script>window.PagedConfig = { auto: false };</script>
<script src="paged.polyfill.js"></script>
<script src="paged-handlers.js"></script>
</head><body>
${body.join('\n')}
</body></html>`;
}
fs.writeFileSync(BUILD + '/panduan.html', await assemble());
console.log(`HTML: ${BUILD}/panduan.html (${chapters.length} bab)`);
if (flags['html-only']) process.exit(0);

const browser = await launch(['--allow-file-access-from-files']);
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('[halaman]', m.type(), m.text().slice(0, 300)); });
page.on('pageerror', e => console.log('[galat halaman]', e.message));
async function render() {
  await page.goto(pathToFileURL(BUILD + '/panduan.html').href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const t0 = performance.now();
  await page.evaluate(async () => { await window.PagedPolyfill.preview(); });
  const n = await page.evaluate(() => document.querySelectorAll('.pagedjs_page').length);
  console.log(`Paged.js: ${n} halaman (${Math.round(performance.now() - t0)} ms)`);
  return n;
}
// Halaman tengah bab yang kosong karena blok bergambar terdorong ke halaman berikut: hitung skala agar muat.
async function fitCandidates() {
  return page.evaluate(() => {
    const MM = 96 / 25.4, out = [];
    const pages = [...document.querySelectorAll('.pagedjs_page')];
    pages.forEach((pg, i) => {
      const area = pg.querySelector('.pagedjs_page_content'), next = pages[i + 1];
      if (!area || !next || !area.querySelector('.chapter') || next.querySelector('.ch-head')) return;
      const nArea = next.querySelector('.pagedjs_page_content'); if (!nArea || !nArea.querySelector('.chapter')) return;
      const a = area.getBoundingClientRect(); let last = a.top;
      for (const e of area.querySelectorAll('.chapter *')) { const r = e.getBoundingClientRect(); if (r.height > 0 && r.bottom > last && getComputedStyle(e).visibility !== 'hidden') last = r.bottom; }
      const avail = a.bottom - last - 5 * MM;
      if ((last - a.top) / a.height > 0.8 || avail < 25 * MM) return;
      const sec = nArea.querySelector('.chapter section.sec'); if (!sec) return;
      const first = sec.firstElementChild; if (!first) return;
      const fit = first.matches('[data-fit]') ? first : first.querySelector(':scope > [data-fit]'); if (!fit) return;
      const H = first.getBoundingClientRect().height;
      if (H <= avail) return;
      if (fit.classList.contains('pair')) { const t = fit.querySelector('.pair-text').getBoundingClientRect().height; if (t > avail - (H - fit.getBoundingClientRect().height)) return; }
      const hf = fit.getBoundingClientRect().height;
      const s = (hf - (H - avail) - 2 * MM) / hf;
      out.push({ img: fit.dataset.fit, s: Math.round(s * 1000) / 1000, page: Number(pg.dataset.pageNumber) });
    });
    return out;
  });
}
let pages = await render();
if (!flags['no-fit']) {
  for (let pass = 1; pass <= 3; pass++) {
    const cand = (await fitCandidates()).filter(c => c.s >= 0.8 && c.s < 0.995 && sc(c.img) * c.s >= 0.78);
    if (!cand.length) break;
    for (const c of cand) SCALE.set(c.img, Math.round(sc(c.img) * c.s * 1000) / 1000);
    console.log(`penyesuaian ${pass}: ${cand.length} gambar diperkecil (${cand.map(c => c.page + ':' + Math.round(c.s * 100) + '%').join(' ')})`);
    fs.writeFileSync(BUILD + '/panduan.html', await assemble());
    pages = await render();
  }
}
// laporan luapan: konten yang melewati area halaman
const overflow = await page.evaluate(() => {
  const out = [];
  for (const pg of document.querySelectorAll('.pagedjs_page')) {
    const area = pg.querySelector('.pagedjs_page_content'); if (!area) continue;
    const r = area.getBoundingClientRect();
    for (const el of area.querySelectorAll('figure, aside, table, .steps, .st-grid, img')) {
      const b = el.getBoundingClientRect();
      if (b.bottom > r.bottom + 2 && b.height > 0) out.push(`hal ${pg.dataset.pageNumber}: ${el.tagName}.${el.className} meluap ${Math.round(b.bottom - r.bottom)}px`);
    }
  }
  return out.slice(0, 40);
});
for (const o of overflow) console.log('LUAPAN', o);
if (flags.png) {
  // pratinjau per halaman untuk pemeriksaan visual: --png <folder> [--pages 1-6,12]
  const dir = String(flags.png); fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/^hal-\d+\.png$/.test(f)) fs.unlinkSync(path.join(dir, f));
  const want = flags.pages ? new Set(String(flags.pages).split(',').flatMap(r => { const [a, b] = r.split('-').map(Number); return Array.from({ length: (b || a) - a + 1 }, (_, i) => a + i); })) : null;
  await page.addStyleTag({ content: '.pagedjs_page{margin:0 auto 10px!important;box-shadow:none!important}' });
  const els = await page.$$('.pagedjs_page');
  for (let i = 0; i < els.length; i++) {
    if (want && !want.has(i + 1)) continue;
    await els[i].screenshot({ path: path.join(dir, `hal-${String(i + 1).padStart(3, '0')}.png`) });
  }
  console.log(`PNG: ${dir}`);
}
await page.pdf({ path: OUT, preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false, tagged: true, outline: true });
console.log(`PDF: ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
await browser.close();
