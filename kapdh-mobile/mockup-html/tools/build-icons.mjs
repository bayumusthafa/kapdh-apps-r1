// Membangkitkan ikon mockup dari font ikon Flutter (MaterialIcons-Regular.otf di Flutter SDK), sehingga glyph di
// mockup sama persis dengan Icons.<nama> yang dirender aplikasi.
//
// Keluaran:
//   css/icons.css     kelas .ic-<nama> (mask SVG data URI, warna = currentColor), diimpor oleh css/components.css
//   assets/icons.svg  sprite <symbol id="<nama>"> untuk desainer (Figma/Illustrator) atau <use> lewat server http
//   components.html   galeri ikon di antara penanda <!-- ICONS:START --> dan <!-- ICONS:END -->
//
// Pakai (dari folder mockup-html):  node tools/build-icons.mjs
// Variabel lingkungan opsional:
//   FLUTTER_ROOT  default C:/flutter/flutter
//   FONTKITTEN    path ke dist/index.js paket fontkitten (parser font, ada di pnpm store kapdh-platform)
//
// Menambah ikon: tulis nama Flutter-nya (mis. `qr_code_scanner`) di tools/icon-list.txt lalu jalankan ulang skrip.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const flutterRoot = process.env.FLUTTER_ROOT ?? 'C:/flutter/flutter';
const fontkittenPath =
  process.env.FONTKITTEN ??
  'C:/Users/Admin/KAPDHAPPS/kapdh-platform/node_modules/.pnpm/fontkitten@1.0.3/node_modules/fontkitten/dist/index.js';

const { create } = await import(pathToFileURL(fontkittenPath).href);

const iconsDart = readFileSync(join(flutterRoot, 'packages/flutter/lib/src/material/icons.dart'), 'utf8');
const codepoints = new Map();
for (const m of iconsDart.matchAll(/static const IconData (\w+) = IconData\(\s*(0x[0-9a-fA-F]+)/g)) {
  codepoints.set(m[1], Number.parseInt(m[2], 16));
}

const names = [
  ...new Set(
    readFileSync(join(here, 'icon-list.txt'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  ),
].sort();

const font = create(readFileSync(join(flutterRoot, 'bin/cache/artifacts/material_fonts/materialicons-regular.otf')));
const upem = font.unitsPerEm; // 512, ascent 512, descent 0: kotak glyph = 1 em
const scale = 24 / upem;

const fmt = (n) => {
  const v = Math.round(n * 100) / 100;
  return (Object.is(v, -0) ? 0 : v).toString();
};

const icons = [];
const missing = [];
for (const name of names) {
  const cp = codepoints.get(name);
  if (cp === undefined) {
    missing.push(name);
    continue;
  }
  const glyph = font.glyphForCodePoint(cp);
  // Koordinat font (y ke atas, 0..512) -> viewBox 24x24 (y ke bawah).
  const path = glyph.path.transform(scale, 0, 0, -scale, 0, font.ascent * scale);
  const d = path
    .toSVG()
    .replace(/-?\d+(\.\d+)?(e-?\d+)?/g, (n) => fmt(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
  if (!d) {
    missing.push(name);
    continue;
  }
  icons.push({ name, cp, d });
}

if (missing.length) {
  console.error('Tidak ditemukan di icons.dart/font:', missing.join(', '));
  process.exitCode = 1;
}

const banner = `DIBANGKITKAN oleh tools/build-icons.mjs dari Flutter ${flutterRoot}/bin/cache/artifacts/material_fonts/materialicons-regular.otf (Apache 2.0, lihat assets/LICENSE-material-icons.txt). Jangan edit manual.`;

// css/icons.css
const css = [
  `/* ${banner} */`,
  '/* Pakai: <span class="ic ic-home_outlined" aria-hidden="true"></span>. Nama kelas = nama Flutter Icons.<nama>. */',
  '/* Ukuran: kelas .ic-s10 ... .ic-s64 atau style="--ic-size:18px". Warna: properti color (currentColor). */',
  '',
  ...icons.map(
    ({ name, cp, d }) =>
      `.ic-${name}{--ic:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='${d}'/%3E%3C/svg%3E")} /* U+${cp.toString(16).toUpperCase()} */`,
  ),
  '',
].join('\n');
writeFileSync(join(root, 'css/icons.css'), css);

// assets/icons.svg
const svg = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  `<!-- ${banner} -->`,
  '<!-- Pakai lewat server http: <svg class="ic-svg"><use href="../assets/icons.svg#home_outlined"/></svg> (file:// diblokir Chrome untuk <use> eksternal; untuk file:// pakai kelas .ic dari css/icons.css). -->',
  '<svg xmlns="http://www.w3.org/2000/svg" style="display:none">',
  ...icons.map(({ name, d }) => `  <symbol id="${name}" viewBox="0 0 24 24"><path d="${d}"/></symbol>`),
  '</svg>',
  '',
].join('\n');
writeFileSync(join(root, 'assets/icons.svg'), svg);

// Galeri di components.html
const showcase = join(root, 'components.html');
if (existsSync(showcase)) {
  const html = readFileSync(showcase, 'utf8');
  const start = '<!-- ICONS:START -->';
  const end = '<!-- ICONS:END -->';
  const i = html.indexOf(start);
  const j = html.indexOf(end);
  if (i >= 0 && j > i) {
    const gallery = icons
      .map(
        ({ name }) =>
          `          <li class="icon-cell"><span class="ic ic-${name}" aria-hidden="true"></span><code>${name}</code></li>`,
      )
      .join('\n');
    const next = `${html.slice(0, i + start.length)}\n        <ul class="icon-grid" aria-label="${icons.length} ikon">\n${gallery}\n        </ul>\n        ${html.slice(j)}`;
    writeFileSync(showcase, next);
  }
}

console.log(`${icons.length} ikon ditulis ke css/icons.css dan assets/icons.svg`);
