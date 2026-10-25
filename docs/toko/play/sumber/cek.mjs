// Pemeriksaan aset dan teks listing Google Play terhadap spesifikasi Play Console (Help: "Add preview assets to
// showcase your app", diperiksa 25 Oktober 2026) dan aturan teks D13 (docs/runbooks/app-store-submission.md bagian 2).
//   node docs/toko/play/sumber/cek.mjs                     gambar, teks, dan tangkapan layar bila sudah ada
//   node docs/toko/play/sumber/cek.mjs --wajib-tangkapan   gagal juga bila tangkapan layar belum lengkap
//   node docs/toko/play/sumber/cek.mjs --tangkapan <dir>   tangkapan di folder lain (bawaan docs/toko/play/tangkapan)
// Butuh sharp dari kapdh-platform (pnpm install), sama dengan generate.mjs. Keluar dengan kode 1 bila ada pelanggaran.
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(join(REPO, 'kapdh-platform/apps/api/package.json'));
const sharp = require('sharp');
const PLAY = join(REPO, 'docs/toko/play');

// Batas Play Console.
export const SPEK = {
  ikon: { berkas: 'ikon-512.png', w: 512, h: 512, format: 'png', kanal: 4, maksByte: 1024 * 1024 },
  feature: { berkas: 'feature-graphic-1024x500.jpg', w: 1024, h: 500, format: 'jpeg', kanal: 3, maksByte: 15 * 1024 * 1024 },
  tangkapan: { min: 2, maks: 8, sisiMin: 320, sisiMaks: 3840, rasioMaks: 2, promosiMin: 1080, promosiJumlah: 4, maksByte: 8 * 1024 * 1024 },
  teks: {
    'judul.txt': { maks: 30 },
    'deskripsi-singkat.txt': { maks: 80 },
    'deskripsi-lengkap.txt': { min: 1500, maks: 2500, batasPlay: 4000 },
    'alt-feature-graphic.txt': { maks: 140 },
  },
};

// D13: kata yang mengaitkan pembayaran dengan membuka fitur. KLAIM: peringkat, harga, promosi, ajakan unduh
// (kebijakan metadata Play; juga dihindari di feature graphic dan tangkapan layar).
const D13 = /upgrade|premium|berlangganan|langganan|buka fitur|membuka (kembali )?fitur|terkunci|mengaktifkan (kembali )?(fitur|KTA)|kembali membuka|membukanya kembali|terbuka setelah|fitur alumni|\bpro\b/i;
const KLAIM = /terbaik|terpopuler|ter-?laris|nomor ?(1|satu)|#1|\btop\b|\bbest\b|\bfree\b|gratis|diskon|promo|\bsale\b|\bbaru\b|\bnew\b|unduh sekarang|download now|juara|peringkat|bintang 5|jutaan/i;
export function polaTerlarang(str) {
  const hasil = [];
  for (const [nama, re] of [['D13', D13], ['klaim', KLAIM]]) {
    const g = new RegExp(re.source, 'gi');
    for (const m of str.matchAll(g)) hasil.push(`${nama} "${m[0]}"`);
  }
  return hasil;
}

// Hitungan karakter seperti kolom Play Console: titik kode Unicode, baris baru dihitung 1, tanpa baris baru penutup.
export const bacaTeks = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
export const hitung = (s) => [...s].length;

const ok = (m) => console.log(`  OK    ${m}`);
const gagal = (m) => { console.log(`  GAGAL ${m}`); return false; };

async function info(file) {
  const meta = await sharp(file).metadata();
  const stats = await sharp(file).stats();
  return { meta, opaque: stats.isOpaque, bytes: statSync(file).size };
}

export async function cekGambar(dir = PLAY) {
  console.log('Gambar listing');
  let lulus = true;
  for (const key of ['ikon', 'feature']) {
    const s = SPEK[key], file = join(dir, s.berkas);
    if (!existsSync(file)) { lulus = gagal(`${s.berkas} tidak ada`); continue; }
    const { meta, opaque, bytes } = await info(file);
    const ringkas = `${s.berkas}: ${meta.width}x${meta.height} ${meta.format}, ${meta.channels} kanal (${meta.channels * 8}-bit), ruang ${meta.space}, alfa ${meta.hasAlpha ? 'ada' : 'tidak'}, buram penuh ${opaque}, ${(bytes / 1024).toFixed(1)} KB`;
    const e = [];
    if (meta.width !== s.w || meta.height !== s.h) e.push(`ukuran harus ${s.w}x${s.h}`);
    if (meta.format !== s.format) e.push(`format harus ${s.format}`);
    if (meta.channels !== s.kanal) e.push(`harus ${s.kanal} kanal`);
    if (meta.space !== 'srgb') e.push('ruang warna harus sRGB');
    if (key === 'ikon' && !opaque) e.push('ikon harus persegi penuh tanpa piksel transparan');
    if (key === 'feature' && meta.hasAlpha) e.push('feature graphic tidak boleh beralfa');
    if (meta.exif) e.push('ada EXIF');
    if (bytes > s.maksByte) e.push(`melebihi ${s.maksByte / 1024} KB`);
    if (e.length) lulus = gagal(`${ringkas}: ${e.join('; ')}`); else ok(ringkas);
  }
  return lulus;
}

export async function cekTangkapanBerkas(file) {
  const s = SPEK.tangkapan;
  const { meta, bytes } = await info(file);
  const pendek = Math.min(meta.width, meta.height), panjang = Math.max(meta.width, meta.height);
  const e = [];
  if (!['png', 'jpeg'].includes(meta.format)) e.push('format harus PNG atau JPEG');
  if (meta.hasAlpha || meta.channels !== 3) e.push('harus 24-bit tanpa alfa');
  if (pendek < s.sisiMin || panjang > s.sisiMaks) e.push(`sisi harus ${s.sisiMin}-${s.sisiMaks} px`);
  if (panjang > s.rasioMaks * pendek) e.push('sisi panjang lebih dari 2x sisi pendek');
  if (bytes > s.maksByte) e.push('melebihi 8 MB');
  const promosi = pendek >= s.promosiMin && panjang * 9 === pendek * 16;
  return { meta, bytes, e, promosi };
}

export async function cekTangkapan(dir = join(PLAY, 'tangkapan'), wajib = false) {
  console.log('Tangkapan layar ponsel');
  const s = SPEK.tangkapan;
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort() : [];
  if (!files.length) {
    if (wajib) return gagal(`belum ada berkas di ${dir} (prosedur: docs/toko/play/tangkapan-layar.md)`);
    console.log(`  -     belum ada berkas di ${dir}; ikuti docs/toko/play/tangkapan-layar.md`);
    return true;
  }
  let lulus = true, promosi = 0;
  for (const f of files) {
    const r = await cekTangkapanBerkas(join(dir, f));
    if (r.promosi) promosi++;
    const ringkas = `${f}: ${r.meta.width}x${r.meta.height} ${r.meta.format}, ${r.meta.channels} kanal, ${(r.bytes / 1024).toFixed(0)} KB, layak promosi ${r.promosi ? 'ya' : 'tidak'}`;
    if (r.e.length) lulus = gagal(`${ringkas}: ${r.e.join('; ')}`); else ok(ringkas);
  }
  if (files.length < s.min || files.length > s.maks) lulus = gagal(`jumlah ${files.length}, harus ${s.min}-${s.maks}`);
  if (promosi < s.promosiJumlah) lulus = gagal(`hanya ${promosi} gambar 9:16 >= 1080 px; rekomendasi Play butuh minimal ${s.promosiJumlah}`);
  else ok(`${promosi} gambar 9:16 >= 1080x1920 (rekomendasi Play: minimal ${s.promosiJumlah})`);
  return lulus;
}

export function cekTeks(dir = join(PLAY, 'teks')) {
  console.log('Teks listing (hitungan titik kode, baris baru dihitung)');
  let lulus = true;
  for (const [nama, b] of Object.entries(SPEK.teks)) {
    const file = join(dir, nama);
    if (!existsSync(file)) { lulus = gagal(`${nama} tidak ada`); continue; }
    const t = bacaTeks(file), c = hitung(t);
    const e = [];
    if (b.min && c < b.min) e.push(`kurang dari ${b.min}`);
    if (c > b.maks) e.push(`lebih dari ${b.maks}`);
    if (nama !== 'deskripsi-lengkap.txt' && t.includes('\n')) e.push('harus satu baris');
    e.push(...polaTerlarang(t));
    const batas = b.min ? `${b.min}-${b.maks}, batas Play ${b.batasPlay}` : `maks ${b.maks}`;
    if (e.length) lulus = gagal(`${nama}: ${c} karakter (${batas}): ${e.join('; ')}`); else ok(`${nama}: ${c} karakter (${batas})`);
  }
  // Teks alternatif tangkapan layar: satu baris per gambar "<berkas>: <teks>", masing-masing maks 140.
  const altFile = join(dir, 'alt-tangkapan.txt');
  if (existsSync(altFile)) {
    for (const baris of bacaTeks(altFile).split('\n').filter(Boolean)) {
      const i = baris.indexOf(': ');
      const nama = baris.slice(0, i), t = baris.slice(i + 2), c = hitung(t);
      const e = [...(c > 140 ? ['lebih dari 140'] : []), ...polaTerlarang(t)];
      if (i < 1) lulus = gagal(`alt-tangkapan.txt: baris tanpa "<berkas>: ": ${baris}`);
      else if (e.length) lulus = gagal(`alt ${nama}: ${c} karakter: ${e.join('; ')}`);
      else ok(`alt ${nama}: ${c} karakter (maks 140)`);
    }
  } else lulus = gagal('alt-tangkapan.txt tidak ada');
  return lulus;
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || '')) {
  const argv = process.argv.slice(2);
  const wajib = argv.includes('--wajib-tangkapan');
  const i = argv.indexOf('--tangkapan');
  const dirTangkapan = i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : undefined;
  const hasil = [await cekGambar(), cekTeks(), await cekTangkapan(dirTangkapan, wajib)];
  if (hasil.includes(false)) process.exitCode = 1;
  else console.log('Semua pemeriksaan lulus.');
}
