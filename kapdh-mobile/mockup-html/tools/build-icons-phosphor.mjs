// Membangkitkan ikon Phosphor (redesain v2) untuk mockup DAN aplikasi Flutter dari satu tabel pemetaan (ADR-027).
//
// Masukan:
//   tools/icon-map-phosphor.json     Icons.<nama Material> -> nama Phosphor (Iconify "ph"; akhiran -fill = bobot fill)
//   tools/icon-list-phosphor.txt     ikon tambahan yang dipakai langsung (mis. duotone akses cepat)
//   tools/phosphor-codepoints.json   codepoint glyph di font assets/fonts/phosphor/*.ttf (Phosphor 2.1, MIT)
// Keluaran:
//   css/icons-phosphor.css           kelas .ph-<nama> (mask SVG data URI) untuk <span class="ic ph-...">
//   ../lib/design/kapdh_icons.dart   KapdhIcons.<namaMaterialCamel> = IconData(<codepoint>, fontFamily: Phosphor*)
// Duotone tetap dua nada di mockup karena mask memakai alfa (lapisan opacity 0.2 = currentColor 20 %). Di Flutter,
// paket phosphor_flutter 2.1.0 tidak dipakai karena meng-extend IconData yang final sejak Flutter 3.4x; font-nya
// dibundel langsung dan duotone digambar oleh DuotoneIcon (lib/design/duotone_icon.dart).
//
// Pakai (dari folder mockup-html, perlu internet untuk SVG):
//   node tools/build-icons-phosphor.mjs && dart format ../lib/design/kapdh_icons.dart
// Menambah ikon: tambah baris pemetaan dan codepoint-nya (lihat https://phosphoricons.com untuk nama).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const map = JSON.parse(readFileSync(join(root, 'tools/icon-map-phosphor.json'), 'utf8'));
delete map._;
const extra = readFileSync(join(root, 'tools/icon-list-phosphor.txt'), 'utf8')
  .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const cp = JSON.parse(readFileSync(join(root, 'tools/phosphor-codepoints.json'), 'utf8'));
const names = [...new Set([...Object.values(map), ...extra])].sort();

// ---------------------------------------------------------------------------------------------------- mockup (CSS)
const res = await fetch(`https://api.iconify.design/ph.json?icons=${names.join(',')}`);
if (!res.ok) throw new Error(`Iconify ${res.status}`);
const data = await res.json();
if (data.not_found?.length) throw new Error(`Tidak ditemukan: ${data.not_found.join(', ')}`);

// Hanya bentuk vektor yang boleh masuk (data dari jaringan diperlakukan sebagai data, bukan kode).
const SAFE = /^(svg|path|g|circle|rect|ellipse|line|polyline|polygon)$/;
const encode = (svg) => svg.replace(/"/g, "'").replace(/%/g, '%25').replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E');

const css = [];
for (const name of names) {
  const icon = data.icons[name];
  const body = icon.body;
  for (const [, tag] of body.matchAll(/<\/?([a-zA-Z]+)/g)) if (!SAFE.test(tag)) throw new Error(`${name}: elemen <${tag}> ditolak`);
  if (/\son\w+=|url\(|href=/i.test(body)) throw new Error(`${name}: atribut tidak aman`);
  const w = icon.width ?? data.width ?? 256;
  const h = icon.height ?? data.height ?? 256;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${body.replace(/currentColor/g, '#000')}</svg>`;
  css.push(`.ph-${name}{--ic:url("data:image/svg+xml,${encode(svg)}")}`);
}
writeFileSync(
  join(root, 'css/icons-phosphor.css'),
  `/* DIBANGKITKAN oleh tools/build-icons-phosphor.mjs dari Iconify API set "ph" (Phosphor Icons, MIT, lihat
   assets/LICENSE-phosphor.txt). Jangan edit manual; ubah tools/icon-map-phosphor.json / icon-list-phosphor.txt. */
/* Pakai: <span class="ic ph-ticket-duotone" aria-hidden="true"></span>. Ukuran dan warna sama seperti ikon Material. */

${css.join('\n')}
`,
);

// ---------------------------------------------------------------------------------------------------- Flutter (Dart)
const camel = (s) => s.replace(/[-_]([a-z0-9])/g, (_, c) => c.toUpperCase());
const dart = Object.entries(map)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([material, ph]) => {
    const fill = ph.endsWith('-fill');
    const base = fill ? ph.slice(0, -5) : ph;
    const code = (fill ? cp.fill : cp.regular)[base];
    if (!code) throw new Error(`codepoint ${ph} belum ada di phosphor-codepoints.json`);
    const family = fill ? 'PhosphorFill' : 'PhosphorRegular';
    return `  /// Icons.${material} -> ph:${ph}\n  static const IconData ${camel(material)} = IconData(${code}, fontFamily: '${family}');`;
  });
const duotone = extra
  .filter((n) => n.endsWith('-duotone'))
  .map((n) => {
    const base = n.slice(0, -8);
    const c = cp.duotone[base];
    if (!c) throw new Error(`codepoint ${n} belum ada di phosphor-codepoints.json`);
    return [
      `  /// ph:${n}`,
      `  static const DuotoneIconData ${camel(base)}Duotone = DuotoneIconData(`,
      `    IconData(${c.primary}, fontFamily: 'PhosphorDuotone'),`,
      `    IconData(${c.secondary}, fontFamily: 'PhosphorDuotone'),`,
      '  );',
    ].join('\n');
  });

const header = [
  '// DIBANGKITKAN oleh mockup-html/tools/build-icons-phosphor.mjs dari mockup-html/tools/icon-map-phosphor.json dan',
  '// phosphor-codepoints.json. Jangan edit manual: ubah tabel lalu jalankan ulang skrip.',
  "import 'package:flutter/widgets.dart';",
  '',
  "import 'duotone_icon.dart';",
  '',
  '/// Ikon aplikasi KAPDH: satu keluarga Phosphor (redesain v2, ADR-027) dari font yang dibundel di',
  '/// `assets/fonts/phosphor` (keluarga font PhosphorRegular, PhosphorFill, PhosphorDuotone di pubspec). Nama mengikuti',
  '/// nama Material lama (`Icons.home_outlined` -> `KapdhIcons.homeOutlined`); varian outlined = bobot regular, varian',
  '/// terisi = bobot fill. Ikon duotone (akhiran `Duotone`) digambar dengan [DuotoneIcon].',
  'abstract final class KapdhIcons {',
].join('\n');
writeFileSync(join(root, '../lib/design/kapdh_icons.dart'), `${header}\n${dart.join('\n')}\n\n${duotone.join('\n')}\n}\n`);
console.log(`css/icons-phosphor.css: ${css.length} ikon; lib/design/kapdh_icons.dart: ${dart.length} + ${duotone.length} duotone`);
