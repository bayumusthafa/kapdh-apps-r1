// Mengolah satu tangkapan layar mentah dari `adb exec-out screencap -p` menjadi gambar listing Play:
// PNG 24-bit tanpa alfa (screencap menghasilkan RGBA), sRGB, tanpa metadata, dengan setiap kode QR diburamkan.
//   node olah-tangkapan.mjs <mentah.png> <keluaran.png> [--ui <dump.xml>] [--samarkan x,y,w,h]... [--wajib-qr]
// --ui        hasil `uiautomator dump`; simpul yang label/teksnya memuat "QR" diburamkan otomatis, dan teks layar
//             diperiksa: data "[Contoh]", teks gembok/khusus anggota aktif, instruksi pembayaran, dan kata D13 ditolak.
// --samarkan  kotak tambahan yang diburamkan (px pada gambar mentah), boleh berulang.
// --wajib-qr  gagal bila tidak ada kotak QR yang ditemukan (dipakai untuk layar KTA).
// Keluar dengan kode 1 tanpa menulis keluaran bila ada pelanggaran.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cekTangkapanBerkas, polaTerlarang } from './cek.mjs';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(join(REPO, 'kapdh-platform/apps/api/package.json'));
const sharp = require('sharp');

const args = process.argv.slice(2);
const [masuk, keluar] = args.filter((a, i) => !a.startsWith('--') && !['--ui', '--samarkan'].includes(args[i - 1]));
if (!masuk || !keluar) {
  console.error('pakai: node olah-tangkapan.mjs <mentah.png> <keluaran.png> [--ui dump.xml] [--samarkan x,y,w,h]... [--wajib-qr]');
  process.exit(2);
}
const opsi = (nama) => args.flatMap((a, i) => (a === nama && args[i + 1] ? [args[i + 1]] : []));

const PAD = 12;
const kotak = opsi('--samarkan').map((s) => {
  const [x, y, w, h] = s.split(',').map(Number);
  if ([x, y, w, h].some((v) => !Number.isFinite(v)) || w <= 0 || h <= 0) throw new Error(`--samarkan tidak sah: ${s}`);
  return { x, y, w, h, asal: `--samarkan ${s}` };
});
const masalah = [];

// Simpul uiautomator: atribut text, content-desc, bounds="[x1,y1][x2,y2]".
const attr = (tag, nama) => (tag.match(new RegExp(`\\s${nama}="([^"]*)"`)) || [])[1] || '';
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
for (const ui of opsi('--ui')) {
  const xml = readFileSync(ui, 'utf8');
  const nodes = [...xml.matchAll(/<node\b[^>]*>/g)].map((m) => ({ text: unesc(attr(m[0], 'text')), desc: unesc(attr(m[0], 'content-desc')), bounds: attr(m[0], 'bounds') }));
  if (!nodes.length) masalah.push(`${ui}: tidak ada simpul UI (aplikasi belum tampil atau semantik belum aktif)`);
  const layar = nodes.map((nd) => [nd.text, nd.desc].filter(Boolean).join(' | ')).filter(Boolean);
  for (const nd of nodes) {
    if (!/\bQR\b/i.test(`${nd.text} ${nd.desc}`)) continue;
    const b = nd.bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    if (x2 > x1 && y2 > y1) kotak.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, asal: `"${nd.desc || nd.text}"` });
  }
  const aturan = [
    [/\[Contoh\]/i, 'data contoh "[Contoh]"'],
    [/terkunci|khusus anggota aktif|layanan untuk anggota (aktif|terverifikasi)/i, 'teks gembok/khusus anggota'],
    [/rekening|QRIS|instruksi pembayaran|bukti (transfer|pembayaran)|tujuan pembayaran/i, 'instruksi pembayaran'],
  ];
  for (const t of layar) {
    for (const [re, nama] of aturan) if (re.test(t)) masalah.push(`${nama}: "${t}"`);
    for (const p of polaTerlarang(t).filter((p) => p.startsWith('D13'))) masalah.push(`${p}: "${t}"`);
  }
}
if (args.includes('--wajib-qr') && !kotak.length) masalah.push('tidak ada kotak QR yang ditemukan; QR tidak boleh terbaca di tangkapan');

const meta = await sharp(masuk).metadata();
// Layar tidur, layar hitam, atau splash polos: hampir tanpa variasi warna.
const { channels } = await sharp(masuk).removeAlpha().stats();
if (channels.every((c) => c.stdev < 3)) masalah.push('gambar hampir polos (layar tidur, hitam, atau belum termuat)');
let img = sharp(masuk).flatten({ background: '#FFFFFF' }).removeAlpha().toColourspace('srgb');
const tempel = [];
for (const k of kotak) {
  const left = Math.max(0, k.x - PAD), top = Math.max(0, k.y - PAD);
  const width = Math.min(meta.width - left, k.w + PAD * 2), height = Math.min(meta.height - top, k.h + PAD * 2);
  // Blur kuat (sigma sepertiga sisi kotak) menghapus pola modul QR; hasilnya bidang abu yang tidak dapat dipindai.
  const sigma = Math.max(24, Math.round(Math.min(width, height) / 3));
  const buram = await sharp(masuk).flatten({ background: '#FFFFFF' }).removeAlpha().extract({ left, top, width, height }).blur(sigma).png().toBuffer();
  tempel.push({ input: buram, left, top });
  console.log(`  diburamkan ${width}x${height} di ${left},${top} (${k.asal})`);
}
if (tempel.length) img = sharp(await img.png().toBuffer()).composite(tempel).removeAlpha();

if (masalah.length) {
  console.error(`DITOLAK ${masuk}:\n  ${masalah.join('\n  ')}`);
  process.exit(1);
}
await img.png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(keluar);
const r = await cekTangkapanBerkas(keluar);
console.log(`  ${keluar}: ${r.meta.width}x${r.meta.height} ${r.meta.format}, ${r.meta.channels} kanal, layak promosi ${r.promosi ? 'ya' : 'tidak'}`);
if (r.e.length) {
  console.error(`  GAGAL: ${r.e.join('; ')}`);
  process.exitCode = 1;
}
