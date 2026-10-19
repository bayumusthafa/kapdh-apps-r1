// Generator 9 gambar konten peluncuran KAPDH Apps.
// Setiap gambar disusun sebagai SVG lalu dirender dengan sharp (librsvg), tanpa teks selain logo KAPDH.
// Butuh `pnpm install` di kapdh-platform: sharp diambil dari dependensi @kapdh/api (apps/api/package.json).
// Path dihitung dari lokasi skrip, jadi cwd bebas; contoh dari akar repo:
//   node docs/konten/gambar/sumber/generate.mjs                       semua gambar
//   node docs/konten/gambar/sumber/generate.mjs berita-1 event-2 ...  sebagian (awalan nama berkas)
// Variabel lingkungan opsional:
//   GAMBAR_KELUARAN  folder JPG keluaran; bawaan docs/konten/gambar (menimpa gambar ter-commit)
//   GAMBAR_KERJA     folder svg/, pratinjau/ dan laporan.json; bawaan <tmpdir OS>/kapdh-gambar-konten
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(join(REPO, 'kapdh-platform/apps/api/package.json'));
const sharp = require('sharp');

const OUT = resolve(process.env.GAMBAR_KELUARAN || join(REPO, 'docs/konten/gambar'));
const SCRATCH = resolve(process.env.GAMBAR_KERJA || join(tmpdir(), 'kapdh-gambar-konten'));
const PREV = join(SCRATCH, 'pratinjau');
const LOGO = join(REPO, 'kapdh-platform/apps/web/public/logo-kapdh.png');
// path laporan: relatif repo dengan garis miring maju bila di dalam repo, selain itu absolut
const repoPath = (p) => {
  const r = relative(REPO, p);
  return r.startsWith('..') || isAbsolute(r) ? p : r.replaceAll('\\', '/');
};
mkdirSync(OUT, { recursive: true });
mkdirSync(PREV, { recursive: true });

// ---------------------------------------------------------------- palet
const C = {
  k0: '#020702', g950: '#0E280C', g800: '#1A4B17', g700: '#215E1E', g600: '#2D7A28', g100: '#E3F0E1',
  gold: '#E6D312', gold100: '#FBF6C9', cream: '#FCF8F5', okBg: '#E8F7F0', okFg: '#1E7A46',
};
const SKIN = { a: '#E2B38C', b: '#C99068', c: '#D8A47C', line: '#A9734D' };
const KTA_STOPS = [[0, C.k0], [0.45, C.g950], [1, C.g700]];

// ---------------------------------------------------------------- util
let _id = 0;
const uid = (p = 'i') => `${p}${++_id}`;
const n = (v) => Math.round(v * 100) / 100;
const pts = (arr) => arr.map(([x, y]) => `${n(x)} ${n(y)}`).join(' L');

function cssLinear(id, deg, x, y, w, h, stops) {
  const t = (deg * Math.PI) / 180;
  const dx = Math.sin(t), dy = -Math.cos(t);
  const L = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = x + w / 2, cy = y + h / 2;
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(cx - (dx * L) / 2)}" y1="${n(cy - (dy * L) / 2)}" x2="${n(cx + (dx * L) / 2)}" y2="${n(cy + (dy * L) / 2)}">${stops
    .map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`)
    .join('')}</linearGradient>`;
}
function radialDef(id, cx, cy, rx, ry, color, a0, mid = 0.45) {
  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${rx}" gradientTransform="translate(${cx} ${cy}) scale(1 ${n(ry / rx)}) translate(${-cx} ${-cy})"><stop offset="0" stop-color="${color}" stop-opacity="${a0}"/><stop offset="${mid}" stop-color="${color}" stop-opacity="${n(a0 * 0.45)}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`;
}
const glow = (id, cx, cy, rx, ry) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#${id})"/>`;
const FILTERS = [8, 12, 18, 26]
  .map((s) => `<filter id="blur${s}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${s}"/></filter>`)
  .join('');

// Pola geometris Islami: bintang delapan {8/2} di tiap petak, dihubungkan garis ke tepi dan sudut petak.
function islamicPattern(W, H, T, color, sw, opacity) {
  const R = T * 0.3, ri = R * 0.62;
  const sx = ((W / 2 - T / 2) % T) - T, sy = ((H / 2 - T / 2) % T) - T;
  let d = '';
  for (let oy = sy; oy < H + T; oy += T) {
    for (let ox = sx; ox < W + T; ox += T) {
      const cx = ox + T / 2, cy = oy + T / 2;
      const star = [];
      for (let i = 0; i < 16; i++) {
        const a = ((-90 + i * 22.5) * Math.PI) / 180;
        const rr = i % 2 === 0 ? R : ri;
        star.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
      }
      d += `M${pts(star)}Z`;
      const tgt = [[cx, oy], [ox + T, oy], [ox + T, cy], [ox + T, oy + T], [cx, oy + T], [ox, oy + T], [ox, cy], [ox, oy]];
      for (let i = 0; i < 8; i++) {
        const a = ((-90 + i * 45) * Math.PI) / 180;
        d += `M${n(cx + R * Math.cos(a))} ${n(cy + R * Math.sin(a))}L${n(tgt[i][0])} ${n(tgt[i][1])}`;
      }
      // segi delapan kecil di tengah bintang
      const oct = [];
      for (let i = 0; i < 8; i++) {
        const a = ((-67.5 + i * 45) * Math.PI) / 180;
        oct.push([cx + R * 0.36 * Math.cos(a), cy + R * 0.36 * Math.sin(a)]);
      }
      d += `M${pts(oct)}Z`;
    }
  }
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round" opacity="${opacity}"/>`;
}

// Garis lengkung konsentris seperti .brand-arcs di situs.
const arcs = (cx, cy, radii, color, sw, opacity) =>
  `<g fill="none" stroke="${color}" stroke-width="${sw}" opacity="${opacity}">${radii.map((r) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`).join('')}</g>`;

function squarePath(cx, cy, R, rotDeg) {
  const p = [];
  for (let k = 0; k < 4; k++) {
    const a = ((rotDeg + k * 90) * Math.PI) / 180;
    p.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  }
  return `M${pts(p)}Z`;
}
// Ornamen bintang delapan (dua bujur sangkar bertumpuk) bergaris tipis.
function rubElHizb(cx, cy, R, color, sw, opacity) {
  return `<g fill="none" stroke="${color}" stroke-width="${sw}" opacity="${opacity}" stroke-linejoin="round"><path d="${squarePath(cx, cy, R, 45)}"/><path d="${squarePath(cx, cy, R, 0)}"/><circle cx="${cx}" cy="${cy}" r="${n(R * 0.46)}"/><path d="${squarePath(cx, cy, R * 0.46, 45)}"/><path d="${squarePath(cx, cy, R * 0.46, 0)}"/><circle cx="${cx}" cy="${cy}" r="${n(R * 1.14)}"/></g>`;
}
// Percikan bintang delapan (isi penuh).
function sparkle(cx, cy, R, color, opacity = 1) {
  const p = [];
  for (let i = 0; i < 16; i++) {
    const a = ((-90 + i * 22.5) * Math.PI) / 180;
    const rr = i % 2 === 1 ? R * 0.2 : i % 4 === 0 ? R : R * 0.55;
    p.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  return `<path d="M${pts(p)}Z" fill="${color}" opacity="${opacity}"/>`;
}

// ---------------------------------------------------------------- logo
const LOGO_CACHE = new Map();
async function prepLogos(widths) {
  for (const w of widths) {
    const h = Math.round((w * 350) / 360);
    const buf = await sharp(LOGO).resize(w, h, { kernel: 'lanczos3', fit: 'fill' }).png().toBuffer();
    LOGO_CACHE.set(w, { w, h, uri: `data:image/png;base64,${buf.toString('base64')}` });
  }
  const full = readFileSync(LOGO);
  LOGO_CACHE.set('full', { w: 360, h: 350, uri: `data:image/png;base64,${full.toString('base64')}` });
}
function logoImg(x, y, w) {
  const exact = LOGO_CACHE.get(w);
  const src = exact || LOGO_CACHE.get('full');
  const h = exact ? exact.h : (w * 350) / 360;
  return `<image x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="xMidYMid meet" xlink:href="${src.uri}"/>`;
}
const logoH = (w) => (LOGO_CACHE.get(w) ? LOGO_CACHE.get(w).h : (w * 350) / 360);
// Logo di atas lencana krem membulat (agar terbaca di latar gelap).
function logoBadge(x, y, w, pad = 22, rx = 28) {
  const h = logoH(w), bw = w + pad * 2, bh = h + pad * 2;
  return `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="${rx}" fill="${C.cream}"/><rect x="${x + 7}" y="${y + 7}" width="${bw - 14}" height="${bh - 14}" rx="${rx - 6}" fill="none" stroke="${C.gold}" stroke-width="2" opacity=".7"/>${logoImg(x + pad, y + pad, w)}`;
}

// ---------------------------------------------------------------- figur avatar (tanpa wajah)
// u = jari-jari lingkaran avatar. kind: 'peci' | 'hijab'
function figure(kind, u, o = {}) {
  const skin = o.skin || SKIN.a;
  if (kind === 'peci') {
    const cloth = o.cloth || C.cream, dark = o.clothDark || 'rgba(14,40,12,0.28)', peci = o.peci || '#0B120B';
    return `<path d="M${n(-0.76 * u)} ${n(1.1 * u)} C${n(-0.76 * u)} ${n(0.46 * u)} ${n(-0.44 * u)} ${n(0.24 * u)} 0 ${n(0.24 * u)} C${n(0.44 * u)} ${n(0.24 * u)} ${n(0.76 * u)} ${n(0.46 * u)} ${n(0.76 * u)} ${n(1.1 * u)} Z" fill="${cloth}"/>`
      + `<rect x="${n(-0.11 * u)}" y="${n(0.0 * u)}" width="${n(0.22 * u)}" height="${n(0.28 * u)}" fill="${skin}"/>`
      + `<path d="M${n(-0.17 * u)} ${n(0.25 * u)} Q0 ${n(0.33 * u)} ${n(0.17 * u)} ${n(0.25 * u)}" fill="none" stroke="${dark}" stroke-width="${n(0.05 * u)}" stroke-linecap="round"/>`
      + `<path d="M0 ${n(0.33 * u)} V${n(0.9 * u)}" stroke="${dark}" stroke-width="${n(0.035 * u)}"/>`
      + [0.45, 0.62, 0.79].map((t) => `<circle cx="${n(0.06 * u)}" cy="${n(t * u)}" r="${n(0.025 * u)}" fill="${dark}"/>`).join('')
      + `<circle cx="0" cy="${n(-0.17 * u)}" r="${n(0.29 * u)}" fill="${skin}"/>`
      + `<path d="M${n(-0.295 * u)} ${n(-0.29 * u)} L${n(-0.27 * u)} ${n(-0.52 * u)} Q0 ${n(-0.58 * u)} ${n(0.27 * u)} ${n(-0.52 * u)} L${n(0.295 * u)} ${n(-0.29 * u)} Q0 ${n(-0.33 * u)} ${n(-0.295 * u)} ${n(-0.29 * u)} Z" fill="${peci}"/>`;
  }
  const hijab = o.hijab || C.g100, fold = o.fold || 'rgba(14,40,12,0.22)';
  return `<path d="M0 ${n(-0.6 * u)} C${n(0.25 * u)} ${n(-0.6 * u)} ${n(0.43 * u)} ${n(-0.42 * u)} ${n(0.43 * u)} ${n(-0.16 * u)} C${n(0.43 * u)} ${n(0.06 * u)} ${n(0.38 * u)} ${n(0.18 * u)} ${n(0.32 * u)} ${n(0.25 * u)} C${n(0.58 * u)} ${n(0.33 * u)} ${n(0.8 * u)} ${n(0.52 * u)} ${n(0.8 * u)} ${n(1.1 * u)} L${n(-0.8 * u)} ${n(1.1 * u)} C${n(-0.8 * u)} ${n(0.52 * u)} ${n(-0.58 * u)} ${n(0.33 * u)} ${n(-0.32 * u)} ${n(0.25 * u)} C${n(-0.38 * u)} ${n(0.18 * u)} ${n(-0.43 * u)} ${n(0.06 * u)} ${n(-0.43 * u)} ${n(-0.16 * u)} C${n(-0.43 * u)} ${n(-0.42 * u)} ${n(-0.25 * u)} ${n(-0.6 * u)} 0 ${n(-0.6 * u)} Z" fill="${hijab}"/>`
    + `<ellipse cx="0" cy="${n(-0.13 * u)}" rx="${n(0.215 * u)}" ry="${n(0.265 * u)}" fill="${skin}"/>`
    + `<path d="M${n(-0.32 * u)} ${n(0.25 * u)} Q0 ${n(0.46 * u)} ${n(0.32 * u)} ${n(0.25 * u)}" fill="none" stroke="${fold}" stroke-width="${n(0.04 * u)}" stroke-linecap="round"/>`;
}
function avatar(cx, cy, r, kind, o = {}) {
  const id = uid('av');
  const ring = o.ring === undefined ? C.g600 : o.ring;
  const ringW = o.ringW === undefined ? Math.max(3, r * 0.1) : o.ringW;
  return `<g transform="translate(${n(cx)} ${n(cy)})"><clipPath id="${id}"><circle r="${n(r)}"/></clipPath><circle r="${n(r)}" fill="${o.bg || C.g700}"/><g clip-path="url(#${id})"><g transform="translate(0 ${n(r * 0.1)})">${figure(kind, r, o)}</g></g>${ring ? `<circle r="${n(r)}" fill="none" stroke="${ring}" stroke-width="${n(ringW)}"/>` : ''}</g>`;
}
function tileAvatar(x, y, w, h, kind, bg, o = {}) {
  const id = uid('ta');
  const u = Math.min(w, h) * 0.46;
  return `<clipPath id="${id}"><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(w * 0.12)}"/></clipPath><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(w * 0.12)}" fill="${bg}"/><g clip-path="url(#${id})"><g transform="translate(${n(x + w / 2)} ${n(y + h * 0.55)})">${figure(kind, u, o)}</g></g>`;
}

// ---------------------------------------------------------------- ikon garis (kisi 48)
const ICONS = {
  briefcase: '<rect x="5" y="15" width="38" height="26" rx="4"/><path d="M17 15v-4a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v4"/><path d="M5 26h38"/><rect x="20" y="23" width="8" height="6" rx="1.5"/>',
  laptop: '<rect x="9" y="9" width="30" height="21" rx="2.5"/><path d="M4 38h40l-4-8H8z"/><path d="M21 34h6"/>',
  stethoscope: '<path d="M8 6h4M28 6h4"/><path d="M10 6v11a10 10 0 0 0 20 0V6"/><path d="M20 27v5a8 8 0 0 0 16 0v-4"/><circle cx="36" cy="24" r="4"/>',
  scales: '<path d="M24 9v31M15 41h18M9 13h30"/><circle cx="24" cy="8" r="2.2"/><path d="M9 13 3.5 27M9 13l5.5 14M39 13l-5.5 14M39 13l5.5 14"/><path d="M3 27q6 7 12 0zM33 27q6 7 12 0z"/>',
  hardhat: '<path d="M8 32a16 16 0 0 1 32 0"/><path d="M4 32h40v3.5a2.5 2.5 0 0 1-2.5 2.5h-35A2.5 2.5 0 0 1 4 35.5z"/><path d="M19 17.5V26M29 17.5V26"/>',
  // daun padi: tangkai tegak, bulir terisi berpasangan, satu helai daun di pangkal
  rice: '<path d="M24 45V13"/><path d="M24 45c-7-3-12-9-14-17 6 3 11 8 14 13"/><g fill="currentColor" stroke="none"><ellipse cx="24" cy="8.5" rx="3.6" ry="6"/><ellipse cx="18.6" cy="16" rx="3.4" ry="6.2" transform="rotate(-38 18.6 16)"/><ellipse cx="29.4" cy="16" rx="3.4" ry="6.2" transform="rotate(38 29.4 16)"/><ellipse cx="18.6" cy="25.5" rx="3.4" ry="6.2" transform="rotate(-38 18.6 25.5)"/><ellipse cx="29.4" cy="25.5" rx="3.4" ry="6.2" transform="rotate(38 29.4 25.5)"/></g>',
  upload: '<path d="M24 30V10M15 18l9-9 9 9"/><path d="M8 30v7a3 3 0 0 0 3 3h26a3 3 0 0 0 3-3v-7"/>',
};
function icon(name, cx, cy, size, color, sw) {
  const s = size / 48;
  return `<g transform="translate(${n(cx - size / 2)} ${n(cy - size / 2)}) scale(${n(s * 1000) / 1000})" color="${color}" fill="none" stroke="${color}" stroke-width="${n(sw / s)}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</g>`;
}
function iconBadge(name, cx, cy, r, o = {}) {
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${r}" fill="${o.fill || C.g950}" stroke="${o.ring || C.g600}" stroke-width="${o.ringW || 3}"/>${icon(name, cx, cy, r * 1.25, o.color || C.cream, o.sw || 2.5)}`;
}

// ---------------------------------------------------------------- QR ikon (bukan kode QR)
function qrGlyph(x, y, s, color) {
  const u = s / 100;
  const finder = (ax, ay) => `<rect x="${n(x + (ax + 3) * u)}" y="${n(y + (ay + 3) * u)}" width="${n(24 * u)}" height="${n(24 * u)}" rx="${n(4 * u)}" fill="none" stroke="${color}" stroke-width="${n(6 * u)}"/><rect x="${n(x + (ax + 11) * u)}" y="${n(y + (ay + 11) * u)}" width="${n(8 * u)}" height="${n(8 * u)}" rx="${n(1.5 * u)}" fill="${color}"/>`;
  const blocks = [[44, 8, 12], [42, 44, 14], [66, 64, 12], [82, 82, 12], [58, 84, 9]]
    .map(([bx, by, bs]) => `<rect x="${n(x + bx * u)}" y="${n(y + by * u)}" width="${n(bs * u)}" height="${n(bs * u)}" rx="${n(2.5 * u)}" fill="${color}"/>`)
    .join('');
  return finder(0, 0) + finder(70, 0) + finder(0, 70) + blocks;
}

// ---------------------------------------------------------------- kartu KTA (koordinat lokal 0..w, 0..h)
function ktaCard(w, h, o = {}) {
  const s = w / 760, S = (v) => n(v * s);
  const gid = uid('ktag'), cid = uid('ktac');
  const qr = o.qr !== false;
  let out = '';
  if (o.shadow !== false) out += `<rect x="${S(14)}" y="${S(24)}" width="${n(w)}" height="${n(h)}" rx="${S(34)}" fill="#000" opacity=".38" filter="url(#${o.shadowBlur || 'blur18'})"/>`;
  out += `<defs>${cssLinear(gid, 135, 0, 0, w, h, KTA_STOPS)}<clipPath id="${cid}"><rect width="${n(w)}" height="${n(h)}" rx="${S(34)}"/></clipPath></defs>`;
  out += `<rect width="${n(w)}" height="${n(h)}" rx="${S(34)}" fill="url(#${gid})"/>`;
  out += `<g clip-path="url(#${cid})">`;
  out += arcs(n(w), 0, [110, 165, 220, 275, 330].map((r) => S(r)), C.cream, S(2), 0.07);
  out += rubElHizb(S(650), S(80), S(52), C.gold, S(2), 0.14);
  out += `<rect x="0" y="${n(h - S(24))}" width="${n(w)}" height="${S(24)}" fill="${C.gold}"/>`;
  out += `<rect x="0" y="${n(h - S(36))}" width="${n(w)}" height="${S(3)}" fill="${C.gold}" opacity=".5"/>`;
  out += `</g>`;
  // logo pada keping krem
  out += `<rect x="${S(36)}" y="${S(30)}" width="${S(72)}" height="${S(72)}" rx="${S(18)}" fill="${C.cream}"/>`;
  const lw = Math.round(60 * s);
  out += logoImg(S(42) + (S(60) - lw) / 2, S(66) - logoH(lw) / 2, lw);
  out += `<rect x="${S(128)}" y="${S(44)}" width="${S(250)}" height="${S(18)}" rx="${S(9)}" fill="${C.cream}" opacity=".92"/>`;
  out += `<rect x="${S(128)}" y="${S(74)}" width="${S(170)}" height="${S(12)}" rx="${S(6)}" fill="${C.gold100}" opacity=".7"/>`;
  out += `<rect x="${S(36)}" y="${S(122)}" width="${S(688)}" height="${S(4)}" rx="${S(2)}" fill="${C.gold}"/>`;
  // slot foto: siluet netral
  const pid = uid('ktap');
  out += `<clipPath id="${pid}"><rect x="${S(40)}" y="${S(150)}" width="${S(150)}" height="${S(190)}" rx="${S(16)}"/></clipPath>`;
  out += `<rect x="${S(40)}" y="${S(150)}" width="${S(150)}" height="${S(190)}" rx="${S(16)}" fill="${C.cream}" opacity=".12"/>`;
  out += `<g clip-path="url(#${pid})" fill="${C.cream}" opacity=".55"><circle cx="${S(115)}" cy="${S(222)}" r="${S(34)}"/><path d="M${S(56)} ${S(345)} C${S(56)} ${S(292)} ${S(84)} ${S(266)} ${S(115)} ${S(266)} C${S(146)} ${S(266)} ${S(174)} ${S(292)} ${S(174)} ${S(345)} Z"/></g>`;
  out += `<rect x="${S(40)}" y="${S(150)}" width="${S(150)}" height="${S(190)}" rx="${S(16)}" fill="none" stroke="${C.cream}" stroke-opacity=".3" stroke-width="${S(2)}"/>`;
  // nama, nomor (batang samaran)
  out += `<rect x="${S(220)}" y="${S(168)}" width="${S(300)}" height="${S(26)}" rx="${S(13)}" fill="${C.cream}" opacity=".95"/>`;
  out += `<rect x="${S(220)}" y="${S(212)}" width="${S(210)}" height="${S(18)}" rx="${S(9)}" fill="${C.gold100}" opacity=".8"/>`;
  out += `<rect x="${S(220)}" y="${S(248)}" width="${S(170)}" height="${S(12)}" rx="${S(6)}" fill="${C.cream}" opacity=".35"/>`;
  out += `<rect x="${S(220)}" y="${S(270)}" width="${S(120)}" height="${S(12)}" rx="${S(6)}" fill="${C.cream}" opacity=".25"/>`;
  // lencana status "KTA Aktif" tanpa teks
  out += `<rect x="${S(220)}" y="${S(300)}" width="${S(164)}" height="${S(44)}" rx="${S(22)}" fill="${C.okBg}"/>`;
  out += `<circle cx="${S(244)}" cy="${S(322)}" r="${S(13)}" fill="${C.okFg}"/>`;
  out += `<path d="M${S(237.5)} ${S(322)} l${S(4.5)} ${S(4.8)} l${S(8.5)} ${S(-9.5)}" fill="none" stroke="${C.okBg}" stroke-width="${S(3.6)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  out += `<rect x="${S(266)}" y="${S(316)}" width="${S(100)}" height="${S(12)}" rx="${S(6)}" fill="${C.okFg}" opacity=".85"/>`;
  // baris masa berlaku (batang samaran)
  out += `<circle cx="${S(48)}" cy="${S(388)}" r="${S(8)}" fill="${C.gold}"/><rect x="${S(66)}" y="${S(381)}" width="${S(200)}" height="${S(14)}" rx="${S(7)}" fill="${C.cream}" opacity=".32"/>`;
  out += `<rect x="${S(66)}" y="${S(406)}" width="${S(130)}" height="${S(12)}" rx="${S(6)}" fill="${C.cream}" opacity=".2"/>`;
  if (qr) {
    out += `<rect x="${S(552)}" y="${S(160)}" width="${S(172)}" height="${S(172)}" rx="${S(18)}" fill="${C.cream}"/>`;
    out += qrGlyph(S(568), S(176), S(140), C.g950);
    out += `<rect x="${S(578)}" y="${S(352)}" width="${S(120)}" height="${S(12)}" rx="${S(6)}" fill="${C.cream}" opacity=".3"/>`;
  }
  return out;
}

// ---------------------------------------------------------------- ponsel
function phone({ cx, cy, w, h, rot = 0, bezel = '#0A110A', screen = C.cream, edge = 'rgba(227,240,225,0.38)', content = () => '', shadow = true, shadowBlur = 'blur18', shadowOff = [14, 24], shadowOpacity = 0.42, scaleX = 1 }) {
  const x = -w / 2, y = -h / 2, b = Math.round(w * 0.045), r = w * 0.16;
  const sx = x + b, sy = y + b, sw = w - 2 * b, sh = h - 2 * b, sr = r - b * 0.8;
  const clip = uid('ph');
  return `<g transform="translate(${n(cx)} ${n(cy)}) rotate(${rot}) scale(${scaleX} 1)">`
    + (shadow ? `<rect x="${n(x + shadowOff[0] * scaleX)}" y="${n(y + shadowOff[1])}" width="${w}" height="${h}" rx="${n(r)}" fill="#000" opacity="${shadowOpacity}" filter="url(#${shadowBlur})"/>` : '')
    + `<rect x="${n(x + w - 2)}" y="${n(y + h * 0.2)}" width="5" height="${n(h * 0.09)}" rx="2" fill="${bezel}"/><rect x="${n(x - 3)}" y="${n(y + h * 0.18)}" width="5" height="${n(h * 0.06)}" rx="2" fill="${bezel}"/>`
    + `<rect x="${n(x)}" y="${n(y)}" width="${w}" height="${h}" rx="${n(r)}" fill="${bezel}" stroke="${edge}" stroke-width="2"/>`
    + `<clipPath id="${clip}"><rect x="${n(sx)}" y="${n(sy)}" width="${n(sw)}" height="${n(sh)}" rx="${n(sr)}"/></clipPath>`
    + `<rect x="${n(sx)}" y="${n(sy)}" width="${n(sw)}" height="${n(sh)}" rx="${n(sr)}" fill="${screen}"/>`
    + `<g clip-path="url(#${clip})">${content(sx, sy, sw, sh)}</g>`
    + `<rect x="${n(-w * 0.13)}" y="${n(sy + b * 0.7)}" width="${n(w * 0.26)}" height="${n(Math.max(8, b * 1.5))}" rx="${n(Math.max(4, b * 0.75))}" fill="${bezel}"/>`
    + `</g>`;
}

// Layar Beranda samaran
function homeScreen(sx, sy, sw) {
  const k = sw / 246, X = (v) => n(sx + v * k), Y = (v) => n(sy + v * k), S = (v) => n(v * k);
  const gid = uid('hb'), cid = uid('hbc');
  let s = `<defs>${cssLinear(gid, 120, sx + 14 * k, sy + 86 * k, 218 * k, 112 * k, [[0, C.g800], [1, C.g700]])}<clipPath id="${cid}"><rect x="${X(14)}" y="${Y(86)}" width="${S(218)}" height="${S(112)}" rx="${S(16)}"/></clipPath></defs>`;
  s += `<rect x="${X(20)}" y="${Y(18)}" width="${S(30)}" height="${S(8)}" rx="${S(4)}" fill="${C.g950}" opacity=".5"/><rect x="${X(196)}" y="${Y(18)}" width="${S(30)}" height="${S(8)}" rx="${S(4)}" fill="${C.g950}" opacity=".5"/>`;
  s += `<circle cx="${X(34)}" cy="${Y(58)}" r="${S(15)}" fill="${C.g100}"/><circle cx="${X(34)}" cy="${Y(54)}" r="${S(6)}" fill="${C.g600}" opacity=".6"/>`;
  s += `<rect x="${X(58)}" y="${Y(48)}" width="${S(84)}" height="${S(9)}" rx="${S(4.5)}" fill="${C.g950}" opacity=".75"/><rect x="${X(58)}" y="${Y(62)}" width="${S(56)}" height="${S(7)}" rx="${S(3.5)}" fill="${C.g950}" opacity=".3"/>`;
  s += `<circle cx="${X(214)}" cy="${Y(58)}" r="${S(14)}" fill="${C.g100}"/><circle cx="${X(214)}" cy="${Y(58)}" r="${S(5)}" fill="${C.g600}"/>`;
  s += `<rect x="${X(14)}" y="${Y(86)}" width="${S(218)}" height="${S(112)}" rx="${S(16)}" fill="url(#${gid})"/>`;
  s += `<g clip-path="url(#${cid})">${arcs(X(232), Y(86), [40, 62, 84, 106].map(S), '#FFFFFF', S(1.6), 0.14)}</g>`;
  s += `<rect x="${X(30)}" y="${Y(108)}" width="${S(40)}" height="${S(12)}" rx="${S(6)}" fill="${C.gold}"/>`;
  s += `<rect x="${X(30)}" y="${Y(146)}" width="${S(104)}" height="${S(11)}" rx="${S(5.5)}" fill="${C.cream}" opacity=".92"/><rect x="${X(30)}" y="${Y(165)}" width="${S(70)}" height="${S(9)}" rx="${S(4.5)}" fill="${C.cream}" opacity=".55"/>`;
  s += [108, 123, 138].map((x, i) => `<circle cx="${X(x)}" cy="${Y(212)}" r="${S(3.5)}" fill="${i ? '#C9D6C7' : C.g800}"/>`).join('');
  const qc = [C.g600, C.gold, C.g800, C.g600];
  for (let i = 0; i < 4; i++) {
    const x0 = 14 + i * 58;
    s += `<rect x="${X(x0)}" y="${Y(228)}" width="${S(46)}" height="${S(46)}" rx="${S(13)}" fill="${C.g100}"/><circle cx="${X(x0 + 23)}" cy="${Y(251)}" r="${S(9)}" fill="${qc[i]}"/><rect x="${X(x0 + 9)}" y="${Y(282)}" width="${S(28)}" height="${S(6)}" rx="${S(3)}" fill="${C.g950}" opacity=".3"/>`;
  }
  s += `<rect x="${X(14)}" y="${Y(300)}" width="${S(80)}" height="${S(9)}" rx="${S(4.5)}" fill="${C.g950}" opacity=".7"/>`;
  for (let i = 0; i < 2; i++) {
    const y0 = 316 + i * 78;
    s += `<rect x="${X(14)}" y="${Y(y0)}" width="${S(218)}" height="${S(68)}" rx="${S(12)}" fill="#FFFFFF" stroke="${C.g100}" stroke-width="${S(1.5)}"/>`;
    s += `<rect x="${X(22)}" y="${Y(y0 + 7)}" width="${S(54)}" height="${S(54)}" rx="${S(10)}" fill="${C.g100}"/>`;
    s += `<path d="M${X(26)} ${Y(y0 + 56)} L${X(42)} ${Y(y0 + 36)} L${X(52)} ${Y(y0 + 46)} L${X(60)} ${Y(y0 + 38)} L${X(72)} ${Y(y0 + 56)} Z" fill="${C.g600}" opacity=".45"/><circle cx="${X(62)}" cy="${Y(y0 + 20)}" r="${S(5)}" fill="${C.gold}" opacity=".8"/>`;
    s += `<rect x="${X(86)}" y="${Y(y0 + 13)}" width="${S(130)}" height="${S(9)}" rx="${S(4.5)}" fill="${C.g950}" opacity=".75"/><rect x="${X(86)}" y="${Y(y0 + 29)}" width="${S(104)}" height="${S(7)}" rx="${S(3.5)}" fill="${C.g950}" opacity=".3"/><rect x="${X(86)}" y="${Y(y0 + 48)}" width="${S(44)}" height="${S(7)}" rx="${S(3.5)}" fill="${C.g600}" opacity=".6"/>`;
  }
  s += `<rect x="${X(0)}" y="${Y(470)}" width="${S(246)}" height="${S(60)}" fill="#FFFFFF"/><rect x="${X(0)}" y="${Y(470)}" width="${S(246)}" height="${S(1.5)}" fill="${C.g100}"/>`;
  for (let i = 0; i < 4; i++) s += `<circle cx="${X(36 + i * 58)}" cy="${Y(490)}" r="${S(8)}" fill="${i ? '#C9D6C7' : C.g800}"/><rect x="${X(24 + i * 58)}" y="${Y(504)}" width="${S(24)}" height="${S(5)}" rx="${S(2.5)}" fill="${i ? '#C9D6C7' : C.g800}"/>`;
  return s;
}
// Layar KTA samaran
function ktaScreen(sx, sy, sw) {
  const k = sw / 246, X = (v) => n(sx + v * k), Y = (v) => n(sy + v * k), S = (v) => n(v * k);
  let s = `<path d="M${X(28)} ${Y(46)} l${S(-8)} ${S(8)} l${S(8)} ${S(8)}" fill="none" stroke="${C.g950}" stroke-width="${S(3)}" stroke-linecap="round" stroke-linejoin="round"/><rect x="${X(44)}" y="${Y(49)}" width="${S(90)}" height="${S(10)}" rx="${S(5)}" fill="${C.g950}" opacity=".75"/>`;
  s += `<g transform="translate(${X(14)} ${Y(76)})">${ktaCard(S(218), S(218 / 1.585), { qr: false, shadowBlur: 'blur8' })}</g>`;
  s += `<rect x="${X(46)}" y="${Y(236)}" width="${S(154)}" height="${S(154)}" rx="${S(16)}" fill="#FFFFFF" stroke="${C.g100}" stroke-width="${S(2)}"/>`;
  s += qrGlyph(X(62), Y(252), S(122), C.g950);
  s += `<rect x="${X(71)}" y="${Y(404)}" width="${S(104)}" height="${S(28)}" rx="${S(14)}" fill="${C.okBg}"/><circle cx="${X(86)}" cy="${Y(418)}" r="${S(8)}" fill="${C.okFg}"/><rect x="${X(100)}" y="${Y(414)}" width="${S(62)}" height="${S(8)}" rx="${S(4)}" fill="${C.okFg}" opacity=".85"/>`;
  s += `<rect x="${X(40)}" y="${Y(446)}" width="${S(166)}" height="${S(8)}" rx="${S(4)}" fill="${C.g950}" opacity=".28"/><rect x="${X(62)}" y="${Y(461)}" width="${S(122)}" height="${S(8)}" rx="${S(4)}" fill="${C.g950}" opacity=".2"/>`;
  s += `<rect x="${X(14)}" y="${Y(484)}" width="${S(218)}" height="${S(32)}" rx="${S(16)}" fill="${C.g800}"/>`;
  return s;
}
// Layar panggilan video: kotak video berisi avatar abstrak
function videoScreen(sx, sy, sw, sh, kinds) {
  let s = `<rect x="${n(sx)}" y="${n(sy)}" width="${n(sw)}" height="${n(sh)}" fill="#0C1A0B"/>`;
  const g = 6, tw = (sw - 3 * g) / 2, th = (sh - 26 - 54 - g) / 2;
  const bgs = [C.g700, C.g800, C.g800, C.g700];
  const opts = [{ cloth: C.cream }, { hijab: C.gold100 }, { hijab: C.g100, skin: SKIN.c }, { cloth: C.g100, skin: SKIN.b }];
  for (let i = 0; i < 4; i++) {
    const x = sx + g + (i % 2) * (tw + g), y = sy + 26 + Math.floor(i / 2) * (th + g);
    s += tileAvatar(x, y, tw, th, kinds[i], bgs[i], opts[i]);
  }
  const by = sy + sh - 30;
  s += `<circle cx="${n(sx + sw / 2 - 36)}" cy="${n(by)}" r="10" fill="${C.cream}" opacity=".85"/><circle cx="${n(sx + sw / 2)}" cy="${n(by)}" r="12" fill="${C.gold}"/><circle cx="${n(sx + sw / 2 + 36)}" cy="${n(by)}" r="10" fill="${C.cream}" opacity=".85"/>`;
  s += `<rect x="${n(sx + 12)}" y="${n(sy + 10)}" width="28" height="7" rx="3.5" fill="${C.cream}" opacity=".45"/>`;
  return s;
}

// Tangan memegang ponsel (koordinat lokal ponsel, ponsel di tengah 0,0). Jari di kiri (luar), jempol di kanan.
function handWithPhone({ cx, cy, rot, mirror, kinds, skin, sleeve }) {
  const w = 170, h = 320;
  const sk = skin, line = SKIN.line;
  let g = `<g transform="translate(${cx} ${cy}) rotate(${rot}) scale(${mirror ? -1 : 1} 1)">`;
  // lengan baju dari bawah
  g += `<path d="M-74 222 L74 222 L102 640 L-102 640 Z" fill="${sleeve}"/>`;
  g += `<rect x="-78" y="214" width="156" height="30" rx="10" fill="${sleeve === C.g100 ? C.g600 : C.g100}"/><rect x="-78" y="236" width="156" height="4" fill="${C.gold}" opacity=".9"/>`;
  // telapak di belakang ponsel
  g += `<path d="M-98 40 C-104 130 -80 214 -2 226 C66 222 98 176 100 104 L100 40 Z" fill="${sk}"/>`;
  // jari (sisi luar, kiri)
  g += [[-6, 34], [30, 34], [66, 32], [100, 28]].map(([y, hh], i) => `<rect x="${-116 + i * 3}" y="${y}" width="70" height="${hh}" rx="${hh / 2}" fill="${sk}" stroke="${line}" stroke-width="2"/>`).join('');
  g += phone({ cx: 0, cy: 0, w, h, bezel: '#091009', edge: 'rgba(227,240,225,0.3)', shadow: false, content: (sx, sy, sw, sh) => videoScreen(sx, sy, sw, sh, kinds) }).replace('scale(1 1)', 'scale(1 1)');
  // jempol di depan, sisi kanan
  g += `<g transform="translate(92 132) rotate(16)"><rect x="-19" y="-86" width="38" height="120" rx="19" fill="${sk}" stroke="${line}" stroke-width="2"/></g>`;
  g += `<path d="M58 150 C80 196 72 218 30 228" fill="none" stroke="${line}" stroke-width="2" opacity=".6"/>`;
  g += `</g>`;
  return g;
}

// ---------------------------------------------------------------- jabat tangan (pusat 0,0)
// Gaya ikon jabat tangan: tangan kanan di depan dengan jari terjuntai ke bawah, jempol tangan kiri mengait di atas,
// ujung jari tangan kiri mengintip di bawah. Lengan baju koko memudar di ujung agar tetap di dalam x 255-1345.
function handshake() {
  const sL = SKIN.b, sR = SKIN.a, line = SKIN.line;
  const fid = uid('armf'), mid = uid('armm');
  let g = `<defs><linearGradient id="${fid}" gradientUnits="userSpaceOnUse" x1="-530" y1="0" x2="530" y2="0"><stop offset="0" stop-color="#000"/><stop offset=".15" stop-color="#fff"/><stop offset=".85" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient><mask id="${mid}" maskUnits="userSpaceOnUse" x="-560" y="-220" width="1120" height="440"><rect x="-560" y="-220" width="1120" height="440" fill="url(#${fid})"/></mask></defs>`;
  // lengan baju (kiri #1A4B17, kanan #2D7A28), datang dari bawah samping
  g += `<g mask="url(#${mid})">`
    + `<path d="M-204 -64 L-530 6 L-530 140 L-204 64 Z" fill="${C.g800}"/>`
    + `<path d="M-250 -30 L-520 30" stroke="${C.g700}" stroke-width="5" opacity=".8"/>`
    + `<path d="M204 -64 L530 6 L530 140 L204 64 Z" fill="${C.g600}"/>`
    + `<path d="M250 -30 L520 30" stroke="${C.g700}" stroke-width="5" opacity=".6"/>`
    + `</g>`;
  g += `<g transform="translate(-206 0) rotate(-12.3)"><rect x="-22" y="-72" width="44" height="144" rx="12" fill="${C.g600}"/><rect x="-3" y="-72" width="5" height="144" fill="${C.gold}"/></g>`;
  g += `<g transform="translate(206 0) rotate(12.3)"><rect x="-22" y="-72" width="44" height="144" rx="12" fill="${C.g800}"/><rect x="-2" y="-72" width="5" height="144" fill="${C.gold}"/></g>`;
  // tangan kiri: badan tangan (di belakang)
  g += `<path d="M-192 -50 C-140 -54 -70 -66 -10 -58 C30 -52 60 -36 70 -14 L72 30 C60 54 30 66 -10 68 C-80 70 -140 58 -192 50 Z" fill="${sL}"/>`;
  // ujung jari tangan kiri mengintip di bawah tangan kanan
  g += [[38, 70], [70, 74], [102, 72], [132, 66]].map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="17" ry="13" fill="${sL}" stroke="${line}" stroke-width="2.5"/>`).join('');
  // tangan kanan: punggung tangan
  g += `<path d="M192 -52 C150 -58 80 -72 20 -64 L14 64 C80 74 150 62 192 52 Z" fill="${sR}"/>`;
  // empat jari tangan kanan terjuntai miring ke kiri bawah
  const fingers = [[-58, 132], [-28, 140], [2, 136], [32, 122]];
  for (const [x, len] of fingers) {
    g += `<g transform="translate(${x + 14} -60) rotate(18)"><rect x="-15" y="0" width="30" height="${len}" rx="15" fill="${sR}" stroke="${line}" stroke-width="2.5"/></g>`;
  }
  // tutup sambungan jari di sisi buku jari agar menyatu
  g += `<path d="M-40 -66 C0 -72 60 -72 110 -64 L110 -20 L-20 -20 Z" fill="${sR}"/>`;
  g += `<path d="M60 -10 C90 -6 130 -6 170 -14" fill="none" stroke="${line}" stroke-width="2.5" stroke-linecap="round" opacity=".55"/>`;
  // jempol tangan kiri mengait di atas
  g += `<path d="M-96 -52 C-74 -92 -10 -104 46 -92 C70 -86 74 -64 56 -58 C20 -50 -30 -46 -62 -34 Z" fill="${sL}" stroke="${line}" stroke-width="2.5" stroke-linejoin="round"/>`;
  return g;
}

// ---------------------------------------------------------------- ketupat & janur
function ketupat(cx, cy, s = 1) {
  const hw = 34 * s, hh = 40 * s;
  let l = '';
  for (const t of [1 / 3, 2 / 3]) {
    l += `M${n(-hw + hw * t)} ${n(hh * t)} L${n(hw * t)} ${n(-hh + hh * t)}`;
    l += `M${n(-hw + hw * t)} ${n(-hh * t)} L${n(hw * t)} ${n(hh - hh * t)}`;
  }
  return `<g transform="translate(${n(cx)} ${n(cy)})">`
    + `<path d="M0 ${n(-hh)} C${n(-6 * s)} ${n(-hh - 18 * s)} ${n(-16 * s)} ${n(-hh - 28 * s)} ${n(-28 * s)} ${n(-hh - 38 * s)}" fill="none" stroke="${C.g600}" stroke-width="${n(6 * s)}" stroke-linecap="round"/>`
    + `<path d="M0 ${n(-hh)} C${n(8 * s)} ${n(-hh - 16 * s)} ${n(18 * s)} ${n(-hh - 24 * s)} ${n(30 * s)} ${n(-hh - 30 * s)}" fill="none" stroke="${C.gold}" stroke-width="${n(4 * s)}" stroke-linecap="round"/>`
    + `<path d="M0 ${n(-hh)} L${n(hw)} 0 L0 ${n(hh)} L${n(-hw)} 0 Z" fill="${C.g600}" stroke="${C.gold}" stroke-width="${n(3.5 * s)}" stroke-linejoin="round"/>`
    + `<path d="${l}" stroke="${C.gold}" stroke-width="${n(2.5 * s)}"/>`
    + `</g>`;
}
function leaf(x, y, rot, len, color, strokeC) {
  return `<path transform="translate(${n(x)} ${n(y)}) rotate(${n(rot)})" d="M0 0 Q${n(len * 0.18)} ${n(len * 0.45)} 0 ${n(len)} Q${n(-len * 0.18)} ${n(len * 0.45)} 0 0 Z" fill="${color}"${strokeC ? ` stroke="${strokeC}" stroke-width="1.5"` : ''}/>`;
}
// titik pada kurva kuadrat
const qpt = (p0, p1, p2, t) => [(1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0], (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]];

// ---------------------------------------------------------------- siluet gedung (kubah + atap Melayu generik)
function hallSilhouette() {
  const arch = (x, y, w, h) => `<path d="M${x} ${y + h} V${y + w / 2} a${w / 2} ${w / 2} 0 0 1 ${w} 0 V${y + h} Z" fill="${C.cream}"/>`;
  const wing = (m) => {
    const X = (v) => 800 + m * (v - 800);
    return `<rect x="${Math.min(X(420), X(640))}" y="780" width="220" height="90"/>`
      + `<path d="M${X(384)} 790 L${X(448)} 742 L${X(612)} 742 L${X(676)} 790 Z"/>`
      + `<path d="M${X(452)} 748 Q${X(500)} 714 ${X(530)} 656 Q${X(560)} 714 ${X(608)} 748 Z"/>`
      + `<path d="M${X(530)} 664 Q${X(520)} 640 ${X(502)} 626 M${X(530)} 664 Q${X(540)} 640 ${X(558)} 626" fill="none" stroke="${C.g950}" stroke-width="7" stroke-linecap="round"/>`
      + [452, 518, 584].map((v) => arch(Math.min(X(v), X(v + 24)), 804, 24, 46)).join('');
  };
  return `<g fill="${C.g950}" opacity=".15" transform="translate(0 14)">`
    + `<rect x="300" y="868" width="1000" height="32"/>`
    + wing(1) + wing(-1)
    + `<rect x="650" y="716" width="300" height="154"/>`
    + `<rect x="700" y="690" width="200" height="30"/>`
    + `<path d="M700 692 C700 618 748 586 800 566 C852 586 900 618 900 692 Z"/>`
    + `<path d="M800 566 V532" stroke="${C.g950}" stroke-width="6"/><circle cx="800" cy="536" r="9"/>`
    + [676, 780, 884].map((x) => arch(x, 752, 40, 92)).join('')
    + `</g>`;
}

// ---------------------------------------------------------------- daftar gambar
// Setiap spesifikasi: bg (latar), decor (ornamen boleh di luar area aman), subject (wajib di dalam area aman).
function specBerita1() {
  const W = 1600, H = 900;
  const defs = cssLinear('bg', 135, 0, 0, W, H, KTA_STOPS) + radialDef('glow', 800, 470, 430, 400, C.gold, 0.3);
  const decor = islamicPattern(W, H, 150, C.gold, 1.4, 0.05)
    + arcs(0, H, [250, 310, 370, 430, 490, 550], '#FFFFFF', 2, 0.07)
    + arcs(W, 0, [120, 170, 220], C.gold, 1.5, 0.12)
    + glow('glow', 800, 470, 430, 400);
  const subject = phone({ cx: 690, cy: 478, w: 270, h: 550, rot: -9, screen: '#F3F8F2', content: (sx, sy, sw) => ktaScreen(sx, sy, sw) })
    + phone({ cx: 910, cy: 458, w: 270, h: 550, rot: 7, content: (sx, sy, sw) => homeScreen(sx, sy, sw) })
    + rubElHizb(1420, 186, 96, C.gold, 2.2, 0.85)
    + sparkle(1300, 300, 14, C.gold100, 0.9) + sparkle(1486, 330, 9, C.gold100, 0.8) + sparkle(1260, 140, 8, C.gold, 0.8)
    + logoBadge(64, 64, 220);
  return { name: 'berita-1-peluncuran', W, H, kind: 'berita', defs, bg: `<rect width="${W}" height="${H}" fill="url(#bg)"/>`, decor, subject };
}
function specBerita2() {
  const W = 1600, H = 900, cx = 800, cy = 450;
  const defs = radialDef('glow', cx, cy, 520, 420, C.gold100, 0.95, 0.5);
  const decor = islamicPattern(W, H, 150, C.g100, 2.2, 1)
    + glow('glow', cx, cy, 520, 420)
    + `<rect x="51" y="51" width="${W - 102}" height="${H - 102}" fill="none" stroke="${C.gold}" stroke-width="6"/>`
    + `<rect x="66" y="66" width="${W - 132}" height="${H - 132}" fill="none" stroke="${C.gold}" stroke-width="1.5" opacity=".55"/>`
    + [[104, 104], [W - 104, 104], [104, H - 104], [W - 104, H - 104]].map(([x, y]) => rubElHizb(x, y, 22, C.gold, 2, 0.9)).join('');
  const dots = Array.from({ length: 8 }, (_, i) => {
    const a = ((i * 45 - 22.5) * Math.PI) / 180;
    return sparkle(n(cx + 210 * Math.cos(a)), n(cy + 210 * Math.sin(a)), 9, C.gold, 0.9);
  }).join('');
  const shield = `<g transform="translate(1022 652)">`
    + `<path d="M0 -88 L72 -60 V-6 C72 46 40 78 0 92 C-40 78 -72 46 -72 -6 V-60 Z" fill="${C.cream}" stroke="${C.cream}" stroke-width="18" stroke-linejoin="round"/>`
    + `<path d="M0 -88 L72 -60 V-6 C72 46 40 78 0 92 C-40 78 -72 46 -72 -6 V-60 Z" fill="${C.g950}" stroke="${C.gold}" stroke-width="6" stroke-linejoin="round"/>`
    + `<path d="M0 -70 L56 -48 V-6 C56 36 30 62 0 74 C-30 62 -56 36 -56 -6 V-48 Z" fill="none" stroke="${C.gold}" stroke-width="1.5" opacity=".5"/>`
    + `<path d="M-22 -6 V-24 a22 22 0 0 1 44 0 V-6" fill="none" stroke="${C.gold}" stroke-width="9" stroke-linecap="round"/>`
    + `<rect x="-36" y="-10" width="72" height="56" rx="10" fill="${C.gold}"/>`
    + `<circle cx="0" cy="12" r="8" fill="${C.g950}"/><rect x="-3.5" y="14" width="7" height="18" rx="3" fill="${C.g950}"/>`
    + `</g>`;
  const subject = `<circle cx="${cx + 6}" cy="${cy + 14}" r="232" fill="#000" opacity=".16" filter="url(#blur18)"/>`
    + `<circle cx="${cx}" cy="${cy}" r="232" fill="${C.g800}"/>`
    + `<circle cx="${cx}" cy="${cy}" r="248" fill="none" stroke="${C.gold}" stroke-width="2" opacity=".75"/>`
    + dots
    + `<circle cx="${cx}" cy="${cy}" r="186" fill="${C.cream}" stroke="${C.gold}" stroke-width="4"/>`
    + logoImg(cx - 309 / 2 + 0.5, cy - 150, 309)
    + shield;
  return { name: 'berita-2-legalitas', W, H, kind: 'berita', defs, bg: `<rect width="${W}" height="${H}" fill="${C.cream}"/>`, decor, subject };
}
function specBerita3() {
  const W = 1600, H = 900;
  const defs = cssLinear('bg', 90, 0, 0, W, H, [[0, C.g100], [1, C.cream]]) + radialDef('glow', 800, 440, 520, 380, C.gold100, 0.9, 0.5);
  const decor = arcs(W, 0, [140, 190, 240, 290, 340, 390], C.g800, 2, 0.1)
    + arcs(0, H, [160, 210, 260, 310], C.g800, 2, 0.08)
    + glow('glow', 800, 440, 520, 380);
  // ponsel kiri: unggah bukti + centang
  const ph = phone({
    cx: 236, cy: 470, w: 200, h: 404, rot: 0, bezel: C.g800, edge: 'rgba(14,40,12,0.0)', shadowBlur: 'blur12', shadowOff: [8, 16], shadowOpacity: 0.22,
    content: (sx, sy, sw, sh) => {
      const mx = sx + sw / 2;
      return `<rect x="${n(sx + 18)}" y="${n(sy + 30)}" width="70" height="8" rx="4" fill="${C.g950}" opacity=".45"/>`
        + `<rect x="${n(mx - 52)}" y="${n(sy + 72)}" width="104" height="132" rx="12" fill="${C.g100}" stroke="${C.g600}" stroke-width="3"/>`
        + `<path d="M${n(mx + 22)} ${n(sy + 72)} v22 h30" fill="none" stroke="${C.g600}" stroke-width="3"/>`
        + icon('upload', mx, sy + 140, 64, C.g600, 4.5)
        + `<rect x="${n(sx + 22)}" y="${n(sy + 228)}" width="${n(sw - 44)}" height="9" rx="4.5" fill="${C.g950}" opacity=".35"/><rect x="${n(sx + 38)}" y="${n(sy + 246)}" width="${n(sw - 76)}" height="9" rx="4.5" fill="${C.g950}" opacity=".22"/>`
        + `<circle cx="${n(mx)}" cy="${n(sy + 306)}" r="34" fill="${C.okFg}"/><path d="M${n(mx - 15)} ${n(sy + 306)} l10 10 l20 -22" fill="none" stroke="${C.cream}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;
    },
  });
  // kalender kecil tanpa angka
  const cal = `<g transform="translate(1372 338) rotate(5)">`
    + `<rect x="-86" y="-80" width="172" height="168" rx="22" fill="#000" opacity=".14" filter="url(#blur12)" transform="translate(6 10)"/>`
    + `<rect x="-86" y="-80" width="172" height="168" rx="22" fill="${C.cream}" stroke="${C.g800}" stroke-width="4"/>`
    + `<path d="M-84 -38 V-58 a20 20 0 0 1 20 -20 H64 a20 20 0 0 1 20 20 V-38 Z" fill="${C.g800}"/>`
    + `<rect x="-50" y="-98" width="12" height="34" rx="6" fill="${C.gold}"/><rect x="38" y="-98" width="12" height="34" rx="6" fill="${C.gold}"/>`
    + Array.from({ length: 12 }, (_, i) => {
      const x = -64 + (i % 4) * 34, y = -22 + Math.floor(i / 4) * 34;
      const hi = i === 6;
      return `<rect x="${x}" y="${y}" width="26" height="24" rx="6" fill="${hi ? C.gold : C.g100}"${hi ? ` stroke="${C.g800}" stroke-width="2.5"` : ''}/>`;
    }).join('')
    + `</g>`;
  const card = `<g transform="translate(800 440) rotate(-6) translate(-380 -240)">${ktaCard(760, 480)}</g>`;
  const subject = ph + cal + card
    + sparkle(1290, 560, 16, C.gold, 0.95) + sparkle(1452, 600, 10, C.gold, 0.85) + sparkle(372, 210, 12, C.gold, 0.9) + sparkle(1180, 150, 9, C.gold, 0.8);
  return { name: 'berita-3-iuran-kta', W, H, kind: 'berita', defs, bg: `<rect width="${W}" height="${H}" fill="url(#bg)"/>`, decor, subject };
}

const fadeMask = (W, H) => `<linearGradient id="fadeg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${H}"><stop offset="0" stop-color="#fff"/><stop offset="${n(250 / H)}" stop-color="#fff" stop-opacity="1"/><stop offset="${n(430 / H)}" stop-color="#000"/><stop offset="1" stop-color="#000"/></linearGradient><mask id="fade" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="url(#fadeg)"/></mask><clipPath id="upper"><rect width="${W}" height="456"/></clipPath>`;

function specBanner1() {
  const W = 1760, H = 800;
  const defs = cssLinear('bg', 135, 0, 0, W, H, KTA_STOPS) + radialDef('glow', 1440, 240, 330, 205, C.gold, 0.26) + fadeMask(W, H);
  const decor = `<g mask="url(#fade)">${islamicPattern(W, H, 140, C.gold, 1.4, 0.06)}</g>`
    + arcs(W, 0, [130, 180, 230, 280, 330, 380], '#FFFFFF', 2, 0.06)
    + glow('glow', 1440, 240, 330, 205);
  const ph = (cx, cy, rot, kind, o) => phone({
    cx, cy, w: 140, h: 280, rot, shadowBlur: 'blur12', shadowOff: [8, 12], shadowOpacity: 0.38,
    content: (sx, sy, sw) => {
      const mx = sx + sw / 2;
      return avatar(mx, sy + 86, 40, kind, { bg: C.g100, ring: C.g600, ringW: 3, ...o })
        + `<rect x="${n(mx - 42)}" y="${n(sy + 146)}" width="84" height="10" rx="5" fill="${C.g950}" opacity=".75"/><rect x="${n(mx - 30)}" y="${n(sy + 164)}" width="60" height="8" rx="4" fill="${C.g950}" opacity=".3"/>`
        + `<rect x="${n(mx - 40)}" y="${n(sy + 196)}" width="80" height="26" rx="13" fill="${C.g800}"/><circle cx="${n(mx)}" cy="${n(sy + 209)}" r="5" fill="${C.gold}"/>`;
    },
  });
  const link = (d) => `<path d="${d}" fill="none" stroke="${C.g950}" stroke-width="8" stroke-linecap="round" opacity=".55"/><path d="${d}" fill="none" stroke="${C.gold}" stroke-width="3.5" stroke-linecap="round"/>`;
  const subject = ph(1265, 252, -4, 'peci', { cloth: C.g600, skin: SKIN.a })
    + ph(1440, 224, 0, 'hijab', { hijab: C.g600, skin: SKIN.c, fold: 'rgba(252,248,245,0.35)' })
    + ph(1615, 252, 4, 'peci', { cloth: C.g800, skin: SKIN.b, clothDark: 'rgba(252,248,245,0.35)' })
    + link('M1300 190 C1330 130 1370 124 1404 156')
    + link('M1476 156 C1510 124 1550 130 1580 190')
    + link('M1262 112 C1320 50 1560 50 1618 112')
    + [[1300, 190], [1404, 156], [1476, 156], [1580, 190], [1262, 112], [1618, 112]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6" fill="${C.gold}"/>`).join('')
    + sparkle(1440, 64, 12, C.gold100, 0.95) + sparkle(1180, 360, 9, C.gold100, 0.8) + sparkle(1700, 330, 8, C.gold100, 0.8)
    + logoBadge(64, 64, 200);
  return { name: 'banner-1-gabung', W, H, kind: 'banner', defs, bg: `<rect width="${W}" height="${H}" fill="url(#bg)"/>`, decor, subject };
}
function specBanner2() {
  const W = 1760, H = 800;
  const defs = cssLinear('bg', 90, 0, 0, W, H, [[0, C.g800], [1, C.g700]]) + fadeMask(W, H);
  const decor = `<g mask="url(#fade)">${islamicPattern(W, H, 140, C.gold, 1.4, 0.06)}</g>`
    + arcs(0, 0, [140, 190, 240, 290, 340, 390], '#FFFFFF', 2, 0.07);
  const subject = `<circle cx="1390" cy="245" r="204" fill="${C.gold100}" opacity=".25"/>`
    + `<circle cx="1390" cy="245" r="204" fill="none" stroke="${C.gold}" stroke-width="2" opacity=".5"/>`
    + `<g transform="translate(1390 245) rotate(-8) translate(-250 -157.9)">${ktaCard(500, 315.8, { shadowBlur: 'blur12' })}</g>`
    + sparkle(1160, 90, 13, C.gold, 0.9) + sparkle(1640, 380, 11, C.gold, 0.85) + sparkle(1612, 74, 8, C.gold100, 0.9) + sparkle(1140, 400, 7, C.gold100, 0.8)
    + sparkle(1060, 230, 9, C.gold100, 0.7) + sparkle(1700, 220, 7, C.gold100, 0.7);
  return { name: 'banner-2-iuran-kta', W, H, kind: 'banner', defs, bg: `<rect width="${W}" height="${H}" fill="url(#bg)"/>`, decor, subject };
}
function specBanner3() {
  const W = 1760, H = 800;
  const defs = radialDef('glow', 1300, 240, 470, 200, C.gold, 0.14) + fadeMask(W, H);
  const decor = `<g mask="url(#fade)">${islamicPattern(W, H, 140, C.gold, 1.4, 0.05)}</g>`
    + arcs(0, 0, [140, 190, 240, 290, 340, 390], '#FFFFFF', 2, 0.06)
    + glow('glow', 1300, 240, 470, 200);
  const nodes = [
    { x: 985, y: 250, r: 60, k: 'peci', o: { cloth: C.cream, skin: SKIN.a }, ic: 'briefcase', a: 135 },
    { x: 1140, y: 126, r: 62, k: 'hijab', o: { hijab: C.gold100, skin: SKIN.c }, ic: 'laptop', a: 200 },
    { x: 1188, y: 342, r: 58, k: 'peci', o: { cloth: C.g100, skin: SKIN.b }, ic: 'stethoscope', a: 150 },
    { x: 1366, y: 228, r: 72, k: 'hijab', o: { hijab: C.g100, skin: SKIN.a }, ic: null },
    { x: 1548, y: 118, r: 60, k: 'peci', o: { cloth: C.gold100, skin: SKIN.c }, ic: 'scales', a: 330 },
    { x: 1598, y: 336, r: 62, k: 'hijab', o: { hijab: C.cream, skin: SKIN.b }, ic: 'rice', a: 30 },
  ];
  const E = [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [3, 5], [4, 5], [1, 4]];
  let links = '';
  for (const [a, b] of E) {
    const A = nodes[a], B = nodes[b];
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2 - (a === 1 && b === 4 ? 60 : 0);
    links += `<path d="M${A.x} ${A.y} Q${mx} ${my} ${B.x} ${B.y}" fill="none" stroke="${C.gold}" stroke-width="3" opacity=".85"/>`;
  }
  let av = '', badges = '';
  for (const nd of nodes) {
    av += avatar(nd.x, nd.y, nd.r, nd.k, { bg: C.g800, ring: C.g600, ringW: 6, ...nd.o });
    if (nd.ic) {
      const a = (nd.a * Math.PI) / 180;
      badges += iconBadge(nd.ic, nd.x + (nd.r + 6) * Math.cos(a), nd.y + (nd.r + 6) * Math.sin(a), 30, { sw: 2.6 });
    }
  }
  const subject = links + av + badges + [[1262, 64, 10], [1460, 386, 9], [1060, 404, 8]].map(([x, y, r]) => sparkle(x, y, r, C.gold100, 0.85)).join('');
  return { name: 'banner-3-jejaring', W, H, kind: 'banner', defs, bg: `<rect width="${W}" height="${H}" fill="${C.g950}"/>`, decor, subject };
}

function specEvent1() {
  const W = 1600, H = 900, cx = 800, cy = 448;
  const defs = cssLinear('bg', 135, 0, 0, W, H, [[0, C.g950], [1, C.g700]]) + radialDef('glow', cx, cy, 380, 380, C.gold, 0.28);
  const decor = islamicPattern(W, H, 150, C.gold, 1.4, 0.05)
    + arcs(0, 0, [180, 230, 280, 330], '#FFFFFF', 2, 0.06)
    + arcs(W, H, [180, 230, 280, 330], '#FFFFFF', 2, 0.06)
    + glow('glow', cx, cy, 380, 380);
  const sp = [[-62, 300, 22], [-20, 318, 12], [28, 304, 18], [150, 300, 14], [205, 316, 22], [250, 296, 11], [-120, 312, 10], [100, 322, 9]]
    .map(([deg, r, s]) => {
      const a = (deg * Math.PI) / 180;
      return sparkle(n(cx + r * Math.cos(a)), n(cy + r * Math.sin(a)), s, C.gold100, 0.95);
    }).join('');
  const center = phone({
    cx, cy, w: 250, h: 500, rot: 0, shadowBlur: 'blur18',
    content: (sx, sy, sw, sh) => logoImg(cx - 85 - cx, -112, 170)
      + [-18, 0, 18].map((d, i) => `<circle cx="${d}" cy="${n(sy + sh - 110)}" r="5" fill="${i === 1 ? C.gold : C.g600}"/>`).join('')
      + `<rect x="-56" y="${n(sy + sh - 74)}" width="112" height="9" rx="4.5" fill="${C.g950}" opacity=".18"/>`,
  });
  const subject = `<circle cx="${cx}" cy="${cy}" r="268" fill="none" stroke="${C.gold}" stroke-width="5"/>`
    + `<circle cx="${cx}" cy="${cy}" r="296" fill="none" stroke="${C.gold}" stroke-width="2" opacity=".45"/>`
    + `<circle cx="${cx}" cy="${cy}" r="240" fill="none" stroke="${C.gold}" stroke-width="1.5" stroke-dasharray="2 12" stroke-linecap="round" opacity=".7"/>`
    + sp
    + handWithPhone({ cx: 452, cy: 486, rot: -12, mirror: false, kinds: ['peci', 'hijab', 'hijab', 'peci'], skin: SKIN.a, sleeve: C.g600 })
    + handWithPhone({ cx: 1148, cy: 486, rot: 12, mirror: true, kinds: ['hijab', 'peci', 'peci', 'hijab'], skin: SKIN.b, sleeve: C.g100 })
    + center;
  return { name: 'event-1-peluncuran', W, H, kind: 'event', defs, bg: `<rect width="${W}" height="${H}" fill="url(#bg)"/>`, decor, subject };
}
function specEvent2() {
  const W = 1600, H = 900;
  const defs = radialDef('glow', 800, 380, 560, 360, C.gold100, 0.95, 0.5);
  const decor = islamicPattern(W, H, 150, C.g100, 2.2, 1) + glow('glow', 800, 380, 560, 360) + hallSilhouette();
  // rangkaian janur + ketupat di atas jabat tangan
  const p0 = [330, 132], p1 = [800, 270], p2 = [1270, 132];
  const d = `M${p0[0]} ${p0[1]} Q${p1[0]} ${p1[1]} ${p2[0]} ${p2[1]}`;
  let garland = `<path d="${d}" fill="none" stroke="${C.g600}" stroke-width="7" stroke-linecap="round"/><path d="${d}" fill="none" stroke="${C.gold}" stroke-width="2.5" stroke-dasharray="14 10" stroke-linecap="round"/>`;
  for (let i = 0; i <= 24; i++) {
    const t = i / 24, [x, y] = qpt(p0, p1, p2, t);
    garland += leaf(x, y, i % 2 ? 18 : -18, i % 3 === 0 ? 46 : 36, i % 2 ? C.g600 : C.gold, null);
  }
  const kt = [0.1, 0.3, 0.5, 0.7, 0.9].map((t, i) => {
    const [x, y] = qpt(p0, p1, p2, t);
    const drop = i === 2 ? 76 : i % 2 ? 70 : 60;
    return `<path d="M${n(x)} ${n(y)} V${n(y + drop - 44)}" stroke="${C.gold}" stroke-width="2.5"/>` + ketupat(x, y + drop, i === 2 ? 1.05 : 0.92);
  }).join('');
  // jumbai janur di kedua ujung rangkaian
  const tassel = (x, y, m) => [-34, -14, 6, 26].map((r, i) => leaf(x, y, m * r, 58 + (i % 2) * 14, i % 2 ? C.gold : C.g600)).join('')
    + `<circle cx="${x}" cy="${y}" r="9" fill="${C.gold}" stroke="${C.g600}" stroke-width="3"/>`;
  const side = tassel(p0[0], p0[1], 1) + tassel(p2[0], p2[1], -1);
  const subject = garland + kt + side
    + `<g transform="translate(800 440)">${handshake()}</g>`
    + sparkle(540, 330, 13, C.gold, 0.9) + sparkle(1060, 330, 13, C.gold, 0.9) + sparkle(430, 300, 8, C.gold, 0.8) + sparkle(1170, 300, 8, C.gold, 0.8);
  return { name: 'event-2-halal-bihalal', W, H, kind: 'event', defs, bg: `<rect width="${W}" height="${H}" fill="${C.cream}"/>`, decor, subject };
}
function specEvent3() {
  const W = 1600, H = 900, cx = 800, cy = 440;
  const defs = cssLinear('bg', 180, 0, 0, W, H, [[0, C.g950], [1, C.g800]]) + radialDef('glow', cx, cy, 420, 360, C.gold, 0.2);
  const decor = islamicPattern(W, H, 150, C.gold, 1.4, 0.045)
    + arcs(0, 0, [180, 230, 280], '#FFFFFF', 2, 0.05) + arcs(W, H, [180, 230, 280], '#FFFFFF', 2, 0.05)
    + glow('glow', cx, cy, 420, 360);
  const Rx = 384, Ry = 262, r = 76;
  const kinds = ['peci', 'hijab', 'peci', 'hijab', 'peci', 'hijab'];
  const opts = [
    { cloth: C.cream, skin: SKIN.a }, { hijab: C.gold100, skin: SKIN.b }, { cloth: C.g100, skin: SKIN.c },
    { hijab: C.cream, skin: SKIN.a }, { cloth: C.gold100, skin: SKIN.b }, { hijab: C.g100, skin: SKIN.c },
  ];
  const icons = ['laptop', 'stethoscope', 'scales', 'briefcase', 'hardhat', 'rice'];
  const nodes = Array.from({ length: 6 }, (_, i) => {
    const a = ((i * 60) * Math.PI) / 180;
    return { x: cx + Rx * Math.cos(a), y: cy + Ry * Math.sin(a), a };
  });
  let s = `<ellipse cx="${cx}" cy="${cy}" rx="${Rx}" ry="${Ry}" fill="none" stroke="${C.gold}" stroke-width="2.5" stroke-dasharray="2 12" stroke-linecap="round" opacity=".7"/>`;
  s += arcs(cx, cy, [150, 182], C.gold, 1.5, 0.22);
  for (let i = 0; i < 6; i++) {
    const A = nodes[i], B = nodes[(i + 1) % 6];
    s += `<path d="M${n(cx)} ${n(cy)} L${n(A.x)} ${n(A.y)}" stroke="${C.gold}" stroke-width="3.5" opacity=".9"/>`;
    s += `<path d="M${n(A.x)} ${n(A.y)} L${n(B.x)} ${n(B.y)}" stroke="${C.gold}" stroke-width="2" opacity=".45"/>`;
  }
  nodes.forEach((p, i) => {
    s += avatar(p.x, p.y, r, kinds[i], { bg: C.g800, ring: C.g600, ringW: 7, ...opts[i] });
  });
  nodes.forEach((p, i) => {
    // lencana ikon di sisi luar, digeser 42 derajat
    const a = p.a + ((i % 2 ? -42 : 42) * Math.PI) / 180;
    s += iconBadge(icons[i], p.x + (r + 4) * Math.cos(a), p.y + (r + 4) * Math.sin(a), 32, { sw: 2.7 });
  });
  // simpul pusat: krem dengan logo
  s += `<circle cx="${cx}" cy="${cy}" r="${r * 1.42 + 14}" fill="none" stroke="${C.gold}" stroke-width="2.5"/>`;
  s += `<circle cx="${cx}" cy="${cy}" r="${n(r * 1.42)}" fill="${C.cream}" stroke="${C.g600}" stroke-width="10"/>`;
  s += logoImg(cx - 85, cy - 83, 170);
  return { name: 'event-3-temu-jejaring', W, H, kind: 'event', defs, bg: `<rect width="${W}" height="${H}" fill="url(#bg)"/>`, decor, subject: s };
}

// ---------------------------------------------------------------- render + verifikasi
const svgDoc = (W, H, defs, body) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${FILTERS}${defs}</defs>${body}</svg>`;
const rasterRaw = async (svg) => sharp(Buffer.from(svg), { density: 72 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

function alphaBBox({ data, info }, thr = 10) {
  const { width: w, height: h, channels: c } = info;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * c + 3] > thr) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}
function maxAlphaBelow({ data, info }, yStart) {
  const { width: w, height: h, channels: c } = info;
  let m = 0;
  for (let y = yStart; y < h; y++) for (let x = 0; x < w; x++) m = Math.max(m, data[(y * w + x) * c + 3]);
  return m;
}
function bandStats(rgb, w, h, ch, y0, y1) {
  // simpangan baku global dan rata-rata simpangan baku lokal (blok 32 px) pada luminans
  let sum = 0, sum2 = 0, cnt = 0;
  const B = 32; let localSum = 0, blocks = 0, localMax = 0;
  const lum = (i) => 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
  for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) { const v = lum((y * w + x) * ch); sum += v; sum2 += v * v; cnt++; }
  for (let by = y0; by + B <= y1; by += B) for (let bx = 0; bx + B <= w; bx += B) {
    let s = 0, s2 = 0, c = 0;
    for (let y = by; y < by + B; y++) for (let x = bx; x < bx + B; x++) { const v = lum((y * w + x) * ch); s += v; s2 += v * v; c++; }
    const sd = Math.sqrt(Math.max(0, s2 / c - (s / c) ** 2));
    localSum += sd; blocks++; localMax = Math.max(localMax, sd);
  }
  return { std: n(Math.sqrt(Math.max(0, sum2 / cnt - (sum / cnt) ** 2))), localStdMean: n(localSum / blocks), localStdMax: n(localMax) };
}

async function build(spec) {
  const { name, W, H, defs, bg, decor, subject, kind } = spec;
  const upper = kind === 'banner';
  const body = bg + (upper ? `<g clip-path="url(#upper)">${decor}${subject}</g>` : decor + subject);
  const svg = svgDoc(W, H, defs, body);
  writeFileSync(`${SCRATCH}/svg/${name}.svg`, svg);
  const file = join(OUT, `${name}.jpg`);
  await sharp(Buffer.from(svg), { density: 72 })
    .resize(W, H)
    .flatten({ background: '#000000' })
    .toColourspace('srgb')
    .withIccProfile('srgb')
    .jpeg({ quality: 82, progressive: true, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toFile(file);

  // ---- verifikasi berkas
  const buf = readFileSync(file);
  const meta = await sharp(file).metadata();
  const rep = {
    file: repoPath(file), width: meta.width, height: meta.height, bytes: buf.length, kb: n(buf.length / 1024),
    magic: buf.subarray(0, 3).toString('hex'), space: meta.space, exif: !!meta.exif, icc: !!meta.icc, xmp: !!meta.xmp,
    progressive: meta.isProgressive, chroma: meta.chromaSubsampling,
  };
  const errs = [];
  if (meta.width !== W || meta.height !== H) errs.push('ukuran');
  if (rep.magic !== 'ffd8ff') errs.push('magic');
  if (buf.length >= 1024 * 1024) errs.push('>1MB');
  if (meta.space !== 'srgb') errs.push('bukan sRGB');
  if (meta.exif) errs.push('ada EXIF');
  if (!meta.isProgressive) errs.push('tidak progresif');

  // ---- verifikasi area aman (render lapisan subjek saja, latar transparan)
  const subjRaw = await rasterRaw(svgDoc(W, H, defs, upper ? `<g clip-path="url(#upper)">${subject}</g>` : subject));
  const bb = alphaBBox(subjRaw);
  rep.subjectBBox = bb;
  if (kind === 'berita') {
    rep.safe = 'margin 64 px';
    if (bb.x0 < 64 || bb.y0 < 64 || bb.x1 > W - 65 || bb.y1 > H - 65) errs.push('subjek melewati margin 64');
  } else if (kind === 'event') {
    rep.safe = 'subjek di x 255-1345';
    if (bb.x0 < 255 || bb.x1 > 1345) errs.push('subjek di luar x 255-1345');
  } else {
    rep.safe = 'subjek di y 40-460, pita y 460-800 polos';
    if (bb.y0 < 40 || bb.y1 >= 460) errs.push('subjek di luar y 40-460');
    const ovRaw = await rasterRaw(svgDoc(W, H, defs, `<g clip-path="url(#upper)">${decor}${subject}</g>`));
    rep.overlayMaxAlphaY460 = maxAlphaBelow(ovRaw, 460);
    if (rep.overlayMaxAlphaY460 > 0) errs.push('ornamen masuk pita bawah');
    const dec = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    rep.bandY460 = bandStats(dec.data, W, H, dec.info.channels, 460, 800);
    const bgOnly = await sharp(Buffer.from(svgDoc(W, H, defs, bg)), { density: 72 }).removeAlpha().raw().toBuffer();
    let md = 0;
    for (let y = 460; y < 800; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) md = Math.max(md, Math.abs(dec.data[(y * W + x) * 3 + c] - bgOnly[(y * W + x) * 3 + c]));
    rep.bandMaxDiffVsPlainBg = md; // selisih JPEG vs latar polos (hanya derau kompresi)
    if (rep.bandY460.localStdMax > 6) errs.push('pita bawah tidak polos');
  }
  rep.ok = errs.length === 0;
  rep.errors = errs;
  return rep;
}

async function previews(specs) {
  const cells = [];
  for (const s of specs) {
    const file = join(OUT, `${s.name}.jpg`);
    if (s.kind === 'event') {
      await sharp(file).extract({ left: 255, top: 0, width: 1090, height: 900 }).jpeg({ quality: 85 }).toFile(`${PREV}/${s.name}-potong-1090x900.jpg`);
      const thumb = await sharp(file).extract({ left: 255, top: 0, width: 1090, height: 900 }).resize(92, 76, { fit: 'cover' }).png().toBuffer();
      await sharp(thumb).resize(368, 304, { kernel: 'nearest' }).png().toFile(`${PREV}/${s.name}-thumb-92x76-x4.png`);
    } else if (s.kind === 'banner') {
      const ov = `<svg xmlns="http://www.w3.org/2000/svg" width="1760" height="800"><defs><linearGradient id="g" x1="0" y1="360" x2="0" y2="800" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".78"/></linearGradient></defs><rect y="360" width="1760" height="440" fill="url(#g)"/><rect x="65" y="560" width="1630" height="64" rx="10" fill="#fff" opacity=".92"/><rect x="65" y="648" width="980" height="64" rx="10" fill="#fff" opacity=".92"/><rect x="0" y="0" width="1760" height="800" fill="none" stroke="#ff3b30" stroke-width="0"/><line x1="0" y1="460" x2="1760" y2="460" stroke="#ff3b30" stroke-width="2" stroke-dasharray="12 8"/></svg>`;
      await sharp(file).composite([{ input: Buffer.from(ov) }]).jpeg({ quality: 85 }).toFile(`${PREV}/${s.name}-simulasi-judul.jpg`);
    } else {
      const ov = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect x="64" y="64" width="1472" height="772" fill="none" stroke="#ff3b30" stroke-width="2" stroke-dasharray="12 8"/></svg>`;
      await sharp(file).composite([{ input: Buffer.from(ov) }]).jpeg({ quality: 85 }).toFile(`${PREV}/${s.name}-margin64.jpg`);
    }
    cells.push({ s, buf: await sharp(file).resize(520, s.kind === 'banner' ? 236 : 293).toBuffer() });
  }
  if (cells.length === 9) {
    const order = ['berita-1-peluncuran', 'berita-2-legalitas', 'berita-3-iuran-kta', 'banner-1-gabung', 'banner-2-iuran-kta', 'banner-3-jejaring', 'event-1-peluncuran', 'event-2-halal-bihalal', 'event-3-temu-jejaring'];
    const rowsY = [16, 16 + 293 + 16, 16 + 293 + 16 + 236 + 16];
    const comp = order.map((nm, i) => ({ input: cells.find((c) => c.s.name === nm).buf, left: 16 + (i % 3) * 536, top: rowsY[Math.floor(i / 3)] }));
    await sharp({ create: { width: 1624, height: 16 * 4 + 293 * 2 + 236, channels: 3, background: '#2a2a2a' } }).composite(comp).jpeg({ quality: 85 }).toFile(`${PREV}/lembar-kontak.jpg`);
  }
}

// ---------------------------------------------------------------- main
await prepLogos([220, 309, 200, 170, 60]);
mkdirSync(`${SCRATCH}/svg`, { recursive: true });
const ALL = [specBerita1, specBerita2, specBerita3, specBanner1, specBanner2, specBanner3, specEvent1, specEvent2, specEvent3];
const only = process.argv.slice(2);
const specs = ALL.map((f) => f()).filter((s) => !only.length || only.some((o) => s.name.startsWith(o)));
const report = [];
for (const s of specs) report.push(await build(s));
await previews(specs);
writeFileSync(`${SCRATCH}/laporan.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.some((r) => !r.ok)) process.exitCode = 1;
