# Teks dan kategori listing Google Play (draf)

Status: **draf 25 Oktober 2026, wajib disahkan PP sebelum diisi ke Play Console.** Aplikasi hanya berbahasa Indonesia,
jadi listing dibuat untuk bahasa default **Indonesia (id)** saja.

Teks yang diisi ke Play Console ada di `teks/` (satu berkas per kolom, salin apa adanya). Hitungan di bawah berasal dari
`node docs/toko/play/sumber/cek.mjs`: titik kode Unicode, baris baru dihitung satu, tanpa baris baru penutup berkas.
Jalankan ulang setiap kali teks diubah.

| Kolom Play Console (Grow users → Store presence → Main store listing) | Berkas | Karakter | Batas |
| --------------------------------------------------------------------- | ------ | -------- | ----- |
| App name | `teks/judul.txt` | 27 | 30 |
| Short description | `teks/deskripsi-singkat.txt` | 70 | 80 |
| Full description | `teks/deskripsi-lengkap.txt` | 2.306 | 4.000 (target 1.500-2.500) |
| Alt text feature graphic | `teks/alt-feature-graphic.txt` | 125 | 140 |
| Alt text tangkapan layar | `teks/alt-tangkapan.txt` (satu baris per gambar) | 60-96 | 140 |

## Judul

Usulan utama: **KAPDH - Alumni Darel Hikmah** (27 karakter). Nama singkat di ikon peluncur tetap "KAPDH"
(`android:label`), sedangkan judul toko menambahkan siapa penggunanya agar alumni yang mencari "Darel Hikmah" menemukan
aplikasi ini. Alternatif bila PP ingin judul sama persis dengan nama aplikasi: **KAPDH** (5 karakter).

Nama lengkap "KAPDH - Alumni Pesantren Darel Hikmah" (37 karakter) melebihi batas 30.

## Deskripsi singkat

```text
KTA digital, kabar, event, dan jejaring alumni Pesantren Darel Hikmah.
```

## Deskripsi lengkap

Isi lengkap: `teks/deskripsi-lengkap.txt`. Susunannya:

1. Pembuka dengan nama badan hukum **Perkumpulan Keluarga Alumni Pesantren Darel Hikmah** (`legalName` di
   `kapdh-platform/apps/web/src/lib/organization.ts`, tanpa kata "Pondok"), kedudukan Pekanbaru, Riau, dan misi
   silaturahmi (AD Pasal 3).
2. Fitur utama, hanya yang ada di `main` 7ce1ed8 dan dijelaskan di Bantuan (`docs/legal/bantuan.html`): KTA digital
   dengan QR verifikasi dan mode tanpa internet 7 hari, Beranda dan berita, event dan tiket ber-QR untuk check-in,
   Jejaring dengan filter angkatan/kelas/kota/profesi/keahlian, pesan langsung dan grup hingga 100 anggota (foto,
   balasan, reaksi), notifikasi tanpa isi pesan, profil dan privasi profil.
3. Keanggotaan dan iuran: syarat **18 tahun ke atas**; iuran sebagai iuran organisasi yang dibayar di luar aplikasi
   dan **diverifikasi pengurus**; status keanggotaan diperbarui pengurus; direktori, pesan, dan pendaftaran event
   sebagai layanan perkumpulan bagi anggota aktif (bahasa runbook bagian 2); aplikasi tidak memproses pembayaran.
4. Keamanan dan komunitas: laporkan dan blokir, sesi perangkat, **hapus akun** di aplikasi dan
   `https://kapdh.or.id/delete-account`.
5. Tautan **kebijakan privasi** `https://kapdh.or.id/kebijakan-privasi` dan email bantuan.

Hal yang sengaja tidak disebut: nominal iuran (dapat berubah dan tampil di aplikasi), nama bank atau rekening, fitur
yang belum ada (video call, versi web anggota), dan klaim jumlah anggota.

Perbedaan nama untuk diputuskan PP: draf deskripsi 4 kalimat yang sudah disahkan di
`docs/runbooks/app-store-submission.md` bagian 2 menulis "Keluarga Alumni Pondok Pesantren Darel Hikmah", sedangkan
draf ini memakai nama badan hukum seperti situs. Draf ini tidak mengubah teks bagian 2.

## Pemeriksaan kebijakan teks

- **D13** (runbook bagian 2): tidak ada "upgrade", "premium", "langganan", "berlangganan", "pro", "terkunci",
  "buka/membuka (kembali) fitur", "mengaktifkan fitur/KTA", "terbuka setelah", "fitur alumni". Diperiksa dua cara pada
  25 Oktober 2026, keduanya tanpa temuan:
  - `cek.mjs` (pola D13 dan klaim, berlaku juga untuk teks feature graphic dan teks alternatif);
  - pola grep runbook bagian 2 tanpa syarat kutip tunggal:

    ```sh
    grep -rniE "terkunci|terbuka setelah KTA|membuka (kembali )?fitur|membuka kembali percakapan|membukanya kembali|kembali membuka|fitur alumni|mengaktifkan (kembali )?KTA|upgrade|premium|langganan|buka fitur|\bpro\b" docs/toko/play/teks
    ```

- **Metadata Play**: tanpa klaim peringkat, harga, atau promosi ("terbaik", "#1", "top", "gratis", "baru", "diskon",
  "unduh sekarang"), tanpa testimoni, tanpa nama atau logo pihak ketiga, tanpa huruf kapital berlebihan.
- **Nada**: "aplikasi keanggotaan" (bukan "aplikasi resmi") agar tidak bergantung pada nama akun pengembang. Bila
  akun Play Console atas nama perkumpulan, PP boleh memilih "aplikasi resmi".

## Kategori dan tag

- Jenis aplikasi: **App**. Kategori: **Social / Sosial** (inti aplikasi adalah jejaring dan pesan antaranggota).
  Kategori Sosial mewajibkan deklarasi Child safety standards (lihat lembar jawaban App content di runbook).
- Tag (maksimal 5, hanya dari daftar Google di Store settings → App category → Manage tags). Usulan sesuai fungsi:

  | Tag usulan | Alasan |
  | ---------- | ------ |
  | Social | Jejaring anggota |
  | Text messaging | Pesan langsung dan grup |
  | Events | Event alumni dan tiket |
  | Professional network service | Direktori menurut profesi dan keahlian |
  | Communication | Komunikasi alumni dan pengurus |

  Nama tag di atas diambil dari daftar pihak ketiga (AppTweak), bukan halaman resmi Google; cocokkan dengan nama di
  Console saat mengisi dan pilih yang paling dekat. Hindari tag berita (dapat memicu deklarasi aplikasi berita),
  "Meet new people" (berkonotasi kencan), dan tag keagamaan (aplikasi tidak memuat teks keagamaan).
