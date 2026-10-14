# ADR-017: QR KTA = token bertanda tangan di fragmen URL dengan rotasi kunci; QR tiket = kode acak di database

- Status: Diterima (Fase B)
- Tanggal dicatat: 14 Oktober 2026
- Rujukan: PRD 3.5, 3.6, 3.9; F-05, F-06, F-09; AC F05-1..F05-6, F06-1..F06-4, F09-5, F09-6; ARCHITECTURE §3.2
- Bukti di kode: `kapdh-platform/apps/api/src/core/qr/qr-token.service.ts` (`QR_MAX_TTL_SECONDS`, `qrBindingMatches`),
  `apps/api/src/modules/membership/kta-verify.service.ts` (`EXPIRED_IDENTITY_WINDOW_MS`), env `QR_SIGNING_KEYS`
  (`packages/config`), `apps/web/src/pages/kta/index.astro`, `infra/nginx-web.conf` (`location ~ ^/kta/...`)

## Konteks

KTA digital ditampilkan sebagai QR yang dapat dipindai siapa saja (PRD 3.6) dan juga tersedia offline sampai 7 hari
(AC F05-2). Verifikasi publik harus menampilkan status **terkini** dari database, menolak QR palsu atau lama setelah
koreksi nomor (AC F05-6), dan tidak membocorkan data lebih dari minimum. Tiket event dipindai pengurus sekali saat
check-in dan tidak perlu dapat diverifikasi offline.

## Keputusan

1. Token KTA = JWT HS256 dengan header `kid`; klaim `iss=kapdh-api`, `aud=kapdh-kta`, `sub=<user_id>`, `seq=<N>`,
   `iat`, `exp=min(iat+7 hari, expires_at)`. `QR_SIGNING_KEYS` berisi `key_id:secret` dipisah koma: kunci pertama
   menandatangani, semua kunci memverifikasi (rotasi tanpa memutus QR lama). Production menolak `key_id` berawalan
   `dev` atau secret placeholder.
2. Isi QR = `${PUBLIC_WEB_URL}/kta/${member_number}#t=${token}`. Token berada di fragmen sehingga tidak terkirim ke
   nginx/Traefik dan tidak tercatat; halaman statis `/kta/<nomor>` membaca fragmen lalu memanggil
   `POST /api/v1/public/kta/verify`.
3. Verifikasi memeriksa tanda tangan, iss/aud/exp, ikatan `sub` + `seq` dengan akun, nomor yang diminta sama dengan
   nomor **saat ini** (`qrBindingMatches`), lalu status keanggotaan terkini dari database. Token kedaluwarsa lebih dari
   30 hari menjawab `expired` tanpa identitas.
4. QR tiket = kode acak 128 bit tersimpan unik di `tickets.qr_code`, diverifikasi lewat lookup database saat
   check-in; pemindaian hanya sekali (`checked_in_at IS NULL AND status = 'paid'`).

## Alternatif yang dipertimbangkan

- **QR KTA berisi nomor anggota saja**: ditolak; mudah dipalsukan.
- **Token acak tersimpan di database untuk KTA**: ditolak; butuh penulisan setiap pembaruan kartu dan tidak memberi
  manfaat offline dibanding token bertanda tangan.
- **Token tiket bertanda tangan**: tidak perlu; check-in selalu online dan kode acak lebih sederhana dicabut.

## Konsekuensi

- Rotasi kunci QR: tambahkan kunci baru di depan `QR_SIGNING_KEYS`, pertahankan kunci lama minimal 7 hari (TTL
  maksimum token), lalu hapus. Mengganti seluruh daftar sekaligus membuat semua QR yang tersimpan offline tidak sah.
- Batas 30 hari untuk identitas pada token kedaluwarsa adalah keputusan teknis kontrak C2 yang menunggu konfirmasi
  pemilik produk (handoff `phase-b-contract-C2-membership.md`).
