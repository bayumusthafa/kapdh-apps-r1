// Generator aset grafis listing Google Play KAPDH (id.or.kapdh.app):
//   ikon-512.png                   ikon hi-res 512 x 512, PNG 32-bit (RGBA, alfa penuh), persegi tanpa sudut membulat
//   feature-graphic-1024x500.jpg   feature graphic 1024 x 500, JPG sRGB tanpa alfa
// Ikon diturunkan dari ikon aplikasi iOS 1024 (sumber beresolusi tertinggi; logo resmi hanya 360 x 350). Feature
// graphic disusun sebagai SVG (latar, ornamen, logo, ilustrasi jejaring diadaptasi dari banner-3-jejaring di
// docs/konten/gambar/sumber/generate.mjs) lalu teks Poppins ditempel dengan sharp, karena librsvg tidak memuat font
// dari berkas.
// Butuh `pnpm install` di kapdh-platform: sharp diambil dari dependensi @kapdh/api. Path dihitung dari lokasi skrip:
//   node docs/toko/play/sumber/generate.mjs
// Variabel lingkungan opsional:
//   TOKO_KELUARAN  folder keluaran; bawaan docs/toko/play (menimpa aset ter-commit)
//   TOKO_KERJA     folder svg/ dan pratinjau/; bawaan <tmpdir OS>/kapdh-toko-play
// Verifikasi ukuran, mode warna dan batas berkas dilakukan cek.mjs (dijalankan otomatis di akhir).
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cekGambar, polaTerlarang } from './cek.mjs';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(join(REPO, 'kapdh-platform/apps/api/package.json'));
const sharp = require('sharp');

const OUT = resolve(process.env.TOKO_KELUARAN || join(REPO, 'docs/toko/play'));
const SCRATCH = resolve(process.env.TOKO_KERJA || join(tmpdir(), 'kapdh-toko-play'));
const PREV = join(SCRATCH, 'pratinjau');
const ICON_SRC = join(REPO, 'kapdh-mobile/ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-1024x1024@1x.png');
const LOGO = join(REPO, 'kapdh-platform/apps/web/public/logo-kapdh.png');
const FONT = (w) => join(REPO, `kapdh-mobile/assets/fonts/poppins/Poppins-${w}.ttf`);
mkdirSync(OUT, { recursive: true });
mkdirSync(PREV, { recursive: true });
mkdirSync(join(SCRATCH, 'svg'), { recursive: true });

// ---------------------------------------------------------------- palet (packages/design-tokens/tokens.json)
const C = {
  g950: '#0E280C', g800: '#1A4B17', g700: '#215E1E', g600: '#2D7A28', g100: '#E3F0E1',
  gold: '#E6D312', gold100: '#FBF6C9', cream: '#FCF8F5',
};
const SKIN = { a: '#E2B38C', b: '#C99068', c: '#D8A47C' };

// Feature graphic: elemen penting (logo, teks, ilustrasi) wajib di dalam area aman ini.
const FG = { W: 1024, H: 500, safe: { x0: 64, y0: 48, x1: 960, y1: 452 } };

// ---------------------------------------------------------------- util SVG (salinan ringkas dari generator konten)
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
const arcs = (cx, cy, radii, color, sw, opacity) =>
  `<g fill="none" stroke="${color}" stroke-width="${sw}" opacity="${opacity}">${radii.map((r) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`).join('')}</g>`;
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
let LOGO_URI = '';
async function prepLogo(w) {
  const h = Math.round((w * 350) / 360);
  const buf = await sharp(LOGO).resize(w, h, { kernel: 'lanczos3', fit: 'fill' }).png().toBuffer();
  LOGO_URI = `data:image/png;base64,${buf.toString('base64')}`;
  return h;
}
// Logo di atas lencana krem membulat dengan garis emas (sama dengan banner peluncuran).
function logoBadge(x, y, w, h, pad, rx) {
  const bw = w + pad * 2, bh = h + pad * 2;
  return `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="${rx}" fill="${C.cream}"/><rect x="${x + 6}" y="${y + 6}" width="${bw - 12}" height="${bh - 12}" rx="${rx - 5}" fill="none" stroke="${C.gold}" stroke-width="2" opacity=".7"/><image x="${x + pad}" y="${y + pad}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" xlink:href="${LOGO_URI}"/>`;
}

// ---------------------------------------------------------------- figur avatar (tanpa wajah)
function figure(kind, u, o = {}) {
  const skin = o.skin || SKIN.a;
  if (kind === 'peci') {
    const cloth = o.cloth || C.cream, dark = o.clothDark || 'rgba(14,40,12,0.28)', peci = o.peci || '#0B120B';
    return `<path d="M${n(-0.76 * u)} ${n(1.1 * u)} C${n(-0.76 * u)} ${n(0.46 * u)} ${n(-0.44 * u)} ${n(0.24 * u)} 0 ${n(0.24 * u)} C${n(0.44 * u)} ${n(0.24 * u)} ${n(0.76 * u)} ${n(0.46 * u)} ${n(0.76 * u)} ${n(1.1 * u)} Z" fill="${cloth}"/>`
      + `<rect x="${n(-0.11 * u)}" y="0" width="${n(0.22 * u)}" height="${n(0.28 * u)}" fill="${skin}"/>`
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
  return `<g transform="translate(${n(cx)} ${n(cy)})"><clipPath id="${id}"><circle r="${n(r)}"/></clipPath><circle r="${n(r)}" fill="${o.bg || C.g700}"/><g clip-path="url(#${id})"><g transform="translate(0 ${n(r * 0.1)})">${figure(kind, r, o)}</g></g><circle r="${n(r)}" fill="none" stroke="${o.ring || C.g600}" stroke-width="${n(o.ringW || 3)}"/></g>`;
}

// ---------------------------------------------------------------- ikon garis profesi (kisi 48)
const ICONS = {
  briefcase: '<rect x="5" y="15" width="38" height="26" rx="4"/><path d="M17 15v-4a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v4"/><path d="M5 26h38"/><rect x="20" y="23" width="8" height="6" rx="1.5"/>',
  laptop: '<rect x="9" y="9" width="30" height="21" rx="2.5"/><path d="M4 38h40l-4-8H8z"/><path d="M21 34h6"/>',
  stethoscope: '<path d="M8 6h4M28 6h4"/><path d="M10 6v11a10 10 0 0 0 20 0V6"/><path d="M20 27v5a8 8 0 0 0 16 0v-4"/><circle cx="36" cy="24" r="4"/>',
  scales: '<path d="M24 9v31M15 41h18M9 13h30"/><circle cx="24" cy="8" r="2.2"/><path d="M9 13 3.5 27M9 13l5.5 14M39 13l-5.5 14M39 13l5.5 14"/><path d="M3 27q6 7 12 0zM33 27q6 7 12 0z"/>',
  rice: '<path d="M24 45V13"/><path d="M24 45c-7-3-12-9-14-17 6 3 11 8 14 13"/><g fill="currentColor" stroke="none"><ellipse cx="24" cy="8.5" rx="3.6" ry="6"/><ellipse cx="18.6" cy="16" rx="3.4" ry="6.2" transform="rotate(-38 18.6 16)"/><ellipse cx="29.4" cy="16" rx="3.4" ry="6.2" transform="rotate(38 29.4 16)"/><ellipse cx="18.6" cy="25.5" rx="3.4" ry="6.2" transform="rotate(-38 18.6 25.5)"/><ellipse cx="29.4" cy="25.5" rx="3.4" ry="6.2" transform="rotate(38 29.4 25.5)"/></g>',
};
function iconBadge(name, cx, cy, r) {
  const size = r * 1.25, s = size / 48;
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${r}" fill="${C.g950}" stroke="${C.g600}" stroke-width="2.5"/>`
    + `<g transform="translate(${n(cx - size / 2)} ${n(cy - size / 2)}) scale(${n(s * 1000) / 1000})" color="${C.cream}" fill="none" stroke="${C.cream}" stroke-width="${n(2.2 / s)}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</g>`;
}

// Jejaring anggota: avatar bersimpul garis emas dengan lencana profesi (diadaptasi dari banner-3-jejaring, tanpa
// gambar perangkat sesuai panduan feature graphic Play). Koordinat langsung di kanvas 1024 x 500.
const NODES = [
  { x: 648, y: 190, r: 44, k: 'peci', o: { cloth: C.cream, skin: SKIN.a }, ic: 'briefcase', a: 200 },
  { x: 786, y: 124, r: 42, k: 'hijab', o: { hijab: C.gold100, skin: SKIN.c }, ic: 'laptop', a: 300 },
  { x: 680, y: 364, r: 42, k: 'hijab', o: { hijab: C.cream, skin: SKIN.b }, ic: 'stethoscope', a: 160 },
  { x: 780, y: 270, r: 56, k: 'peci', o: { cloth: C.g100, skin: SKIN.c }, ic: null },
  { x: 886, y: 188, r: 40, k: 'peci', o: { cloth: C.gold100, skin: SKIN.b }, ic: 'scales', a: 330 },
  { x: 860, y: 380, r: 44, k: 'hijab', o: { hijab: C.g100, skin: SKIN.a }, ic: 'rice', a: 40 },
];
const EDGES = [[0, 1], [0, 3], [2, 3], [0, 2], [1, 3], [3, 4], [1, 4], [3, 5], [4, 5], [2, 5]];
function jejaring() {
  let links = '', av = '', badges = '';
  for (const [a, b] of EDGES) {
    const A = NODES[a], B = NODES[b];
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2 - 14;
    links += `<path d="M${A.x} ${A.y} Q${n(mx)} ${n(my)} ${B.x} ${B.y}" fill="none" stroke="${C.gold}" stroke-width="2.5" opacity=".85"/>`;
  }
  for (const nd of NODES) {
    av += avatar(nd.x, nd.y, nd.r, nd.k, { bg: C.g950, ring: C.g600, ringW: 5, ...nd.o });
    if (nd.ic) {
      const a = (nd.a * Math.PI) / 180;
      badges += iconBadge(nd.ic, nd.x + (nd.r + 2) * Math.cos(a), nd.y + (nd.r + 2) * Math.sin(a), 17);
    }
  }
  return links + av + badges + [[722, 74, 8], [928, 282, 7], [606, 282, 6]].map(([x, y, r]) => sparkle(x, y, r, C.gold100, 0.85)).join('');
}

// ---------------------------------------------------------------- teks (Poppins dari berkas, dpi 72: 1 pt = 1 px)
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function teks(str, { berat, ukuran, warna, spasi = 0 }) {
  const markup = `<span foreground="${warna}"${spasi ? ` letter_spacing="${Math.round(spasi * 1024)}"` : ''}>${esc(str)}</span>`;
  const { data, info } = await sharp({ text: { text: markup, font: `Poppins ${berat} ${ukuran}`, fontfile: FONT(berat), rgba: true, dpi: 72 } })
    .png().toBuffer({ resolveWithObject: true });
  const ink = alphaBBox(await sharp(data).raw().toBuffer({ resolveWithObject: true }));
  return { buf: data, w: info.width, h: info.height, ink };
}

function alphaBBox({ data, info }, thr = 10) {
  const { width: w, height: h, channels: c } = info;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * c + 3] > thr) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}
const svgDoc = (W, H, defs, body) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${body}</svg>`;
const rasterRaw = async (svg) => sharp(Buffer.from(svg), { density: 72 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

// ---------------------------------------------------------------- ikon 512
async function buildIcon() {
  const file = join(OUT, 'ikon-512.png');
  await sharp(ICON_SRC)
    .resize(512, 512, { kernel: 'lanczos3' })
    .toColourspace('srgb')
    .ensureAlpha(1)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(file);
  // Pratinjau: topeng sudut membulat Play (radius 20%) dan lingkaran, di atas latar terang dan gelap.
  const mask = (shape) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">${shape}</svg>`);
  const cells = [];
  for (const shape of ['<rect width="512" height="512" rx="102.4"/>', '<circle cx="256" cy="256" r="256"/>']) {
    const masked = await sharp(file).composite([{ input: mask(shape), blend: 'dest-in' }]).png().toBuffer();
    for (const bg of ['#FFFFFF', '#1F1F1F']) {
      cells.push(await sharp({ create: { width: 560, height: 560, channels: 4, background: bg } })
        .composite([{ input: masked, left: 24, top: 24 }]).png().toBuffer());
    }
  }
  await sharp({ create: { width: 560 * 4, height: 560, channels: 3, background: '#000' } })
    .composite(cells.map((input, i) => ({ input, left: i * 560, top: 0 })))
    .png().toFile(join(PREV, 'ikon-512-topeng.png'));
  return file;
}

// ---------------------------------------------------------------- feature graphic 1024 x 500
async function buildFeatureGraphic() {
  const { W, H, safe } = FG;
  // Lencana logo kiri atas, teks di kolom kiri, ilustrasi jejaring di kanan.
  const logoW = 112, logoHt = await prepLogo(logoW), pad = 14;
  const badge = { x: 72, y: 82, w: logoW + pad * 2, h: logoHt + pad * 2 };

  // Latar hijau g800 ke g700 (bukan hitam atau abu gelap, agar tidak menyatu dengan latar Play mode gelap).
  const defs = cssLinear('bg', 120, 0, 0, W, H, [[0, C.g800], [1, C.g700]])
    + radialDef('glow', 780, 262, 260, 200, C.gold, 0.2)
    + `<linearGradient id="fadeg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${W}" y2="0"><stop offset="0" stop-color="#000"/><stop offset=".42" stop-color="#000"/><stop offset=".7" stop-color="#fff"/><stop offset="1" stop-color="#fff"/></linearGradient><mask id="fade" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="url(#fadeg)"/></mask>`;
  const bg = `<rect width="${W}" height="${H}" fill="url(#bg)"/>`;
  const decor = `<g mask="url(#fade)">${islamicPattern(W, H, 100, C.gold, 1.1, 0.07)}</g>`
    + arcs(0, H, [90, 130, 170, 210], '#FFFFFF', 1.6, 0.06)
    + `<ellipse cx="780" cy="262" rx="260" ry="200" fill="url(#glow)"/>`;
  const subject = logoBadge(badge.x, badge.y, logoW, logoHt, pad, 22)
    + `<rect x="72" y="272" width="56" height="5" rx="2.5" fill="${C.gold}"/>`
    + jejaring();
  const svg = svgDoc(W, H, defs, bg + decor + subject);
  writeFileSync(join(SCRATCH, 'svg', 'feature-graphic.svg'), svg);

  // Teks: nama singkat di samping lencana, nama perkumpulan di bawahnya, tagline dua baris di bawah garis emas.
  const tx = badge.x + badge.w + 24;
  const lines = [
    { str: 'KAPDH', o: { berat: 'Bold', ukuran: 60, warna: C.cream, spasi: 1 }, x: tx, inkTop: badge.y + 10 },
    { str: 'Keluarga Alumni Pesantren', o: { berat: 'Medium', ukuran: 19, warna: C.gold100 }, x: tx, inkTop: badge.y + 86 },
    { str: 'Darel Hikmah', o: { berat: 'Medium', ukuran: 19, warna: C.gold100 }, x: tx, inkTop: badge.y + 112 },
    { str: 'Wadah digital', o: { berat: 'SemiBold', ukuran: 38, warna: C.cream }, x: 72, inkTop: 302 },
    { str: 'silaturahmi alumni', o: { berat: 'SemiBold', ukuran: 38, warna: C.cream }, x: 72, inkTop: 354 },
  ];
  const overlays = [], boxes = [];
  for (const l of lines) {
    const t = await teks(l.str, l.o);
    const left = Math.round(l.x - t.ink.x0), top = Math.round(l.inkTop - t.ink.y0);
    overlays.push({ input: t.buf, left, top });
    boxes.push({ teks: l.str, x0: left + t.ink.x0, y0: top + t.ink.y0, x1: left + t.ink.x1, y1: top + t.ink.y1 });
  }

  const file = join(OUT, 'feature-graphic-1024x500.jpg');
  const base = await sharp(Buffer.from(svg), { density: 72 }).resize(W, H).flatten({ background: C.g800 }).png().toBuffer();
  await sharp(base)
    .composite(overlays)
    .flatten({ background: C.g800 })
    .removeAlpha()
    .toColourspace('srgb')
    .withIccProfile('srgb')
    .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toFile(file);

  // Area aman: kotak tinta subjek SVG dan setiap baris teks harus di dalam safe.
  const errs = lines.flatMap((l) => polaTerlarang(l.str).map((m) => `teks "${l.str}": ${m}`));
  const subjBox = alphaBBox(await rasterRaw(svgDoc(W, H, defs, subject)));
  const all = [{ teks: '(logo, garis, ilustrasi)', ...subjBox }, ...boxes];
  for (const b of all) {
    if (b.x0 < safe.x0 || b.y0 < safe.y0 || b.x1 > safe.x1 || b.y1 > safe.y1) errs.push(`di luar area aman: ${b.teks} ${JSON.stringify(b)}`);
  }
  // Teks tidak boleh bertumpuk dengan ilustrasi jejaring.
  const ilustrasi = alphaBBox(await rasterRaw(svgDoc(W, H, defs, jejaring())));
  for (const b of boxes) if (b.x1 >= ilustrasi.x0 - 16) errs.push(`teks terlalu dekat ilustrasi: ${b.teks} x1 ${b.x1}, ilustrasi x0 ${ilustrasi.x0}`);

  // Pratinjau dengan garis area aman.
  const ov = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="${safe.x0}" y="${safe.y0}" width="${safe.x1 - safe.x0}" height="${safe.y1 - safe.y0}" fill="none" stroke="#ff3b30" stroke-width="2" stroke-dasharray="10 6"/></svg>`;
  await sharp(file).composite([{ input: Buffer.from(ov) }]).jpeg({ quality: 90 }).toFile(join(PREV, 'feature-graphic-area-aman.jpg'));
  return { file, boxes: all, ilustrasi, errs };
}

// ---------------------------------------------------------------- main
const icon = await buildIcon();
const fg = await buildFeatureGraphic();
console.log(`ikon: ${icon}`);
console.log(`feature graphic: ${fg.file}`);
for (const b of fg.boxes) console.log(`  kotak ${b.teks}: x ${b.x0}-${b.x1}, y ${b.y0}-${b.y1}`);
console.log(`  ilustrasi jejaring: x ${fg.ilustrasi.x0}-${fg.ilustrasi.x1}, y ${fg.ilustrasi.y0}-${fg.ilustrasi.y1}`);
console.log(`pratinjau: ${PREV}`);
if (fg.errs.length) {
  console.error(fg.errs.join('\n'));
  process.exitCode = 1;
}
if (!(await cekGambar(OUT))) process.exitCode = 1;
