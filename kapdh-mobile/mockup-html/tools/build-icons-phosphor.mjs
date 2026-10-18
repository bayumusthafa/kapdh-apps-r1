// Membangkitkan kelas ikon Phosphor (redesain v2) untuk mockup dari Iconify API (set "ph", Phosphor Icons, MIT).
//
// Keluaran: css/icons-phosphor.css berisi kelas .ph-<nama> yang mengisi --ic (mask SVG data URI), dipakai bersama
// kelas .ic seperti ikon Material:  <span class="ic ph-ticket-duotone" aria-hidden="true"></span>
// Duotone tetap dua nada karena mask memakai alfa: lapisan opacity 0.2 Phosphor menjadi currentColor 20 %.
//
// Pakai (dari folder mockup-html, perlu internet):  node tools/build-icons-phosphor.mjs
// Menambah ikon: tulis nama Iconify-nya di tools/icon-list-phosphor.txt lalu jalankan ulang skrip.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const names = readFileSync(join(root, 'tools/icon-list-phosphor.txt'), 'utf8')
  .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

const res = await fetch(`https://api.iconify.design/ph.json?icons=${names.join(',')}`);
if (!res.ok) throw new Error(`Iconify ${res.status}`);
const data = await res.json();
if (data.not_found?.length) throw new Error(`Tidak ditemukan: ${data.not_found.join(', ')}`);

// Hanya bentuk vektor yang boleh masuk (data dari jaringan diperlakukan sebagai data, bukan kode).
const SAFE = /^(svg|path|g|circle|rect|ellipse|line|polyline|polygon)$/;
const encode = (svg) => svg.replace(/"/g, "'").replace(/%/g, '%25').replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E');

const lines = [];
for (const name of names) {
  const icon = data.icons[name];
  const body = icon.body;
  for (const [, tag] of body.matchAll(/<\/?([a-zA-Z]+)/g)) if (!SAFE.test(tag)) throw new Error(`${name}: elemen <${tag}> ditolak`);
  if (/\son\w+=|url\(|href=/i.test(body)) throw new Error(`${name}: atribut tidak aman`);
  const w = icon.width ?? data.width ?? 256;
  const h = icon.height ?? data.height ?? 256;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${body.replace(/currentColor/g, '#000')}</svg>`;
  lines.push(`.ph-${name}{--ic:url("data:image/svg+xml,${encode(svg)}")}`);
}

const header = `/* DIBANGKITKAN oleh tools/build-icons-phosphor.mjs dari Iconify API set "ph" (Phosphor Icons, MIT, lihat
   assets/LICENSE-phosphor.txt). Jangan edit manual; ubah tools/icon-list-phosphor.txt lalu jalankan ulang. */
/* Pakai: <span class="ic ph-ticket-duotone" aria-hidden="true"></span>. Ukuran dan warna sama seperti ikon Material. */
`;
writeFileSync(join(root, 'css/icons-phosphor.css'), `${header}\n${lines.join('\n')}\n`);
console.log(`css/icons-phosphor.css: ${lines.length} ikon`);
