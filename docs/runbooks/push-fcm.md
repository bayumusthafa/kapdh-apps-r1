# Runbook: push FCM production (Firebase `kapdh-prod`)

Rujukan: F-13 (AC F13-1 s.d. F13-5), PRD 5.3 (lingkungan terpisah, secret di luar repo), ARCHITECTURE §2 butir 4
(Firebase hanya untuk FCM), §4.7 dan §4.8 (`notifications.deliver`), ADR-016 (konfigurasi build lewat `--dart-define`);
`docs/runbooks/production-init.md` langkah 5 (5.3-5.6); `kapdh-mobile/docs/BUILD.md` bagian 5.
Kode: `kapdh-platform/apps/api/src/core/adapters/push.ts` (pengirim FCM HTTP v1) dan
`kapdh-platform/apps/api/src/cli/push-selftest.ts` (uji mandiri). Pemilik: pengelola infra (PI) dan pengembang (DEV).
Proyek Firebase punya dua Owner: pemilik produk dan satu Owner kedua (pola D9).

> **Status bukti.** CLI `push-selftest` diuji terhadap server OAuth/FCM tiruan lokal
> (`apps/api/test/notifications/push-selftest.e2e.test.ts`). Terhadap FCM sungguhan CLI ini **belum pernah
> dijalankan**: CLI baru ada di image API yang dibangun dari commit yang memuatnya (bagian 5.1). Nilai FCM nyata sudah
> dipasang di Coolify oleh pemilik pada 18 Oktober 2026, dan API serta worker berjalan dengan nilai itu.

## Ringkasan nilai

| Nilai | Isi production | Rahasia? | Dipakai di |
| --- | --- | --- | --- |
| Project ID Firebase | `kapdh-prod` | tidak | `FCM_PROJECT_ID` (API dan worker), `FIREBASE_PROJECT_ID` (build aplikasi) |
| Project number = Sender ID | `931256687765` | tidak | `FIREBASE_MESSAGING_SENDER_ID` (build aplikasi) |
| App ID Android/iOS | `1:931256687765:android:...` / `1:931256687765:ios:...` | tidak | `FIREBASE_ANDROID_APP_ID`, `FIREBASE_IOS_APP_ID` |
| Kunci API klien | `AIza...` | bukan secret server (ikut tertanam di aplikasi), tetapi tidak disimpan di repo | `FIREBASE_API_KEY` |
| JSON kunci akun layanan | `{"type":"service_account",...}` | **YA** (memuat private key) | `FCM_SERVICE_ACCOUNT_JSON` di Coolify `kapdh-api` dan `kapdh-worker`; salinan di `/etc/kapdh/production/{api,worker}.env` (root, 600) |

Nilai klien production disimpan di `C:\kapdh-secure\firebase-production.json` di PC build (bagian 6), **tidak
pernah** di repo. `kapdh-mobile/config/production.json` di repo tetap kosong untuk kunci `FIREBASE_*`.

## 0. Status production (18 Oktober 2026)

Sudah dikerjakan pemilik:

- [x] Proyek Firebase `kapdh-prod` dibuat tanpa Google Analytics, dengan Owner kedua, dan Data Processing Terms
      diterima (bagian 2.1-2.2).
- [x] Aplikasi Android dan iOS `id.or.kapdh.app` terdaftar. `google-services.json` dan `GoogleService-Info.plist`
      tidak dipakai (bagian 2.4).
- [x] Firebase Cloud Messaging API (V1) aktif (bagian 2.3), dan kunci API klien sudah dipilih (bagian 2.5).
- [x] Kunci akun layanan dibuat, diringkas ke clipboard dengan Node, lalu diisi di Coolify `kapdh-api` dan
      `kapdh-worker` lewat Normal view. Kedua resource sudah di-deploy dan berjalan dengan `FCM_PROJECT_ID` serta
      `FCM_SERVICE_ACCOUNT_JSON` nyata (bagian 3-4.1).

Belum tercatat (kerjakan lalu centang di sini):

- [ ] Clipboard sudah dibersihkan dan berkas kunci yang diunduh sudah dihapus (bagian 4.1 langkah 6).
- [ ] Pemeriksaan di VPS (4.1a nama variabel, 4.2) dan penyalinan ke berkas env VPS (4.3).
- [ ] `push-selftest` LULUS di kontainer API (bagian 5). Butuh image API yang memuat CLI.
- [ ] Isi `C:\kapdh-secure\firebase-production.json` sudah diperiksa (6.1), lalu build aplikasi >= `1.0.0` dengan push
      aktif.
- [ ] Uji kirim ke perangkat nyata (`production-init.md` 5.6) dan `push-selftest --token-from-stdin` LULUS untuk
      token perangkat itu (5.3).
- [ ] Kunci APNs `.p8` untuk iOS (bagian 8). Menunggu akun Apple Developer organisasi.

## 1. Aturan

- Firebase dipakai **hanya** untuk FCM. Analytics, Crashlytics, Auth, dan layanan Firebase lain tidak diaktifkan.
- Server dan aplikasi wajib memakai **proyek Firebase yang sama**. Token dari aplikasi yang dibangun dengan proyek
  lain ditolak FCM dengan `SENDER_ID_MISMATCH`, lalu server **menonaktifkan** token itu (`classifyFcmError`,
  AC F13-4). Perangkat itu tidak menerima push sampai aplikasi yang benar dipasang dan login lagi.
- Staging memakai proyek Firebase sendiri (PRD 5.3), tidak pernah `kapdh-prod`.
- JSON kunci akun layanan tidak pernah masuk repo, chat, tiket, argumen perintah, history shell, atau layar. Satu-
  satunya jalur ke VPS adalah Coolify, sedangkan berkas env VPS disalin dari kontainer yang berjalan (4.3).
- Nilai `FCM_PROJECT_ID` dan `FCM_SERVICE_ACCOUNT_JSON` harus **identik** di `kapdh-api` dan `kapdh-worker`.
  Pengiriman push dilakukan worker, sedangkan API memvalidasi env yang sama saat start.
- Di `NODE_ENV=production`, API dan worker menolak start tanpa pasangan FCM atau bila JSON tidak valid
  (`packages/config`). Rolling update Coolify lalu dibatalkan, dan kontainer lama tetap berjalan.

## 2. Proyek Firebase (sekali per lingkungan)

### 2.1 Membuat proyek

1. Buka <https://console.firebase.google.com> dengan akun Google organisasi, lalu klik 'Create a project'.
2. Nama proyek `kapdh-prod`, dan pastikan Project ID juga `kapdh-prod`. Project ID tidak dapat diubah setelah dibuat.
3. Matikan 'Enable Google Analytics for this project'. Analytics tidak dipakai (ARCHITECTURE §2 butir 4).
4. Catat **Project number** di Project settings → General. Untuk production nilainya `931256687765`, yang sama dengan
   Sender ID di tab Cloud Messaging.

### 2.2 Owner kedua dan Data Processing Terms

1. Project settings → 'Users and permissions' → 'Add member'. Tambahkan akun Google kedua dengan peran **Owner**,
   agar proyek tidak bergantung pada satu akun (pola D9).
2. Di Project settings, buka bagian privasi data. Owner meninjau dan menerima **Data Processing and Security Terms**
   Firebase atas nama organisasi.

### 2.3 Firebase Cloud Messaging API (V1)

Project settings → tab 'Cloud Messaging'. 'Firebase Cloud Messaging API (V1)' harus berstatus **Enabled**. Bila
belum, klik menu titik tiga lalu 'Manage API in Google Cloud Console' → 'Enable'. Server hanya memakai HTTP v1, jadi
API lama (legacy) tidak dibutuhkan. Bila API ini mati, `push-selftest` melaporkan `403 ... belum aktif`.

### 2.4 Mendaftarkan aplikasi Android dan iOS

1. Project overview → 'Add app' → Android. Isi package name `id.or.kapdh.app`, nickname misalnya `KAPDH Android`.
   SHA-1 tidak dibutuhkan FCM, jadi boleh kosong. Lewati langkah unduh `google-services.json` dan langkah SDK
   ('Next' sampai selesai). Berkas itu **tidak dipakai**, karena aplikasi membaca opsi Firebase dari `--dart-define`
   (`kapdh-mobile/docs/BUILD.md` bagian 5).
2. 'Add app' → iOS (Apple). Isi bundle ID `id.or.kapdh.app`, nickname `KAPDH iOS`, dan App Store ID boleh kosong.
   Lewati juga unduhan `GoogleService-Info.plist`.
3. Project settings → General → 'Your apps'. Catat **App ID** kedua aplikasi (`1:931256687765:android:...` dan
   `1:931256687765:ios:...`) ke berkas di bagian 6.1.

### 2.5 Kunci API klien (`FIREBASE_API_KEY`)

Aplikasi memakai **satu** kunci API untuk Android dan iOS (`PushConfig`).

1. Buka Google Cloud Console untuk proyek `kapdh-prod` → 'APIs & Services' → 'Credentials'. Firebase sudah membuat
   kunci otomatis, misalnya "Android key (auto created by Firebase)" dan "iOS key (auto created by Firebase)".
2. Pilih satu kunci dengan **Application restrictions = None**. Kunci yang dibatasi ke aplikasi Android (package +
   SHA-1) atau ke bundle iOS akan gagal di platform lainnya.
3. Kolom API restrictions pada kunci otomatis menampilkan "25 APIs". Itu daftar API Firebase bawaan dan **tidak perlu
   diubah**. Bila kelak dipersempit, 'Firebase Installations API' dan 'FCM Registration API' wajib tetap ada, karena
   keduanya dipakai saat aplikasi mendaftarkan token.
4. Klik 'Show key', lalu salin nilainya langsung ke `FIREBASE_API_KEY` di berkas bagian 6.1.

## 3. Kunci akun layanan dan clipboard (PC Windows)

1. Firebase Console → Project settings → tab 'Service accounts' → 'Firebase Admin SDK' → **Generate new private key**
   → 'Generate key'. Berkas `kapdh-prod-firebase-adminsdk-....json` terunduh. Akun layanan `firebase-adminsdk-...`
   bawaan proyek sudah punya izin kirim FCM (`cloudmessaging.messages.create`). Jangan memakai akun layanan dari
   proyek lain.
   - Bila tombol menolak dengan pesan kebijakan organisasi (`iam.disableServiceAccountKeyCreation`), Owner organisasi
     Google Cloud harus mengizinkan pembuatan kunci untuk proyek ini terlebih dahulu.
2. Di PowerShell, buka folder unduhan. Ringkas JSON menjadi satu baris dan salin **langsung ke clipboard**. Isinya
   tidak tampil di layar:

   ```powershell
   node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))))" <file> | Set-Clipboard
   ```

   Ganti `<file>` dengan nama berkas yang terunduh, misalnya `.\kapdh-prod-firebase-adminsdk-fbsvc-1a2b3c4d5e.json`.
   `JSON.stringify` mempertahankan `\n` di `private_key` sebagai escape JSON, sehingga kunci PEM tetap utuh setelah
   di-parse server. Jangan meringkas ulang hasilnya, jangan menambahkan tanda kutip, dan jangan menempelkannya ke
   editor atau chat.
3. Lanjutkan langsung ke 4.1, lalu bersihkan PC (4.1 langkah 6).

## 4. Coolify dan VPS

### 4.1 Mengisi nilai di Coolify (Normal view)

1. Coolify → project "KAPDH Project" → environment `production` → resource **`kapdh-api`** → sidebar 'Environment
   Variables' → **'Normal view'**. Jangan memakai 'Developer view', karena 'Save changes' di sana menghapus setiap
   variabel yang tidak ada di textarea.
2. Ubah dua variabel (jangan menambahkan variabel baru bila sudah ada):
   - `FCM_PROJECT_ID` = `kapdh-prod`
   - `FCM_SERVICE_ACCOUNT_JSON` = tempel dari clipboard (Ctrl+V), lalu simpan.

   Untuk keduanya: **tanpa tanda kutip**, **'Multiline' mati** karena JSON sudah satu baris, dan 'Runtime' tetap aktif.
   'Literal' tidak perlu diubah karena JSON Google tidak memuat `$`. Bila variabel sudah di-'Lock', hapus variabel itu
   lalu tambahkan lagi dengan nama yang sama.
3. Ulangi langkah 1-2 untuk resource **`kapdh-worker`** dengan nilai yang **identik** (clipboard yang sama).
4. Klik 'Deploy' `kapdh-api`, tunggu sampai "New container is healthy." / "Rolling update completed.", lalu 'Deploy'
   `kapdh-worker`. Bila log menampilkan `... gagal start` (hanya nama variabel), perbaiki nilai di Normal view lalu
   deploy lagi. Kontainer lama tetap melayani selama itu.
5. Jalankan 4.1a, 4.2, bagian 5, lalu 4.3.
6. **Bersihkan PC** setelah nilai tersimpan di Coolify:

   ```powershell
   Set-Clipboard -Value ' '
   Remove-Item .\<file>
   ```

   `Remove-Item` menghapus permanen tanpa Recycle Bin. Bila berkas sempat dihapus lewat Explorer, kosongkan Recycle
   Bin. Bila riwayat clipboard Windows aktif (Win+V), buka Settings → System → Clipboard → 'Clear clipboard data'.
   Berkas kunci tidak perlu disimpan, karena kunci yang hilang cukup diganti dengan kunci baru (bagian 7). Bila
   organisasi tetap ingin menyimpan salinan, simpan hanya di password manager organisasi (D9).
7. Opsional setelah 4.3 lulus: 'Lock' kedua variabel di kedua resource. Nilainya lalu tersembunyi permanen di UI.

### 4.1a Pemeriksaan nama variabel saja

Jalankan sebelum 4.2, juga kapan pun ragu variabel mana yang terpasang. Blok ini hanya membaca dan hanya mencetak
**nama** variabel push di kontainer API dan worker production, ditambah penanda `(KOSONG)`, `HILANG` dan status
`NODE_ENV`. Tidak ada nilai yang tampil, jadi aman ditempel utuh di shell root VPS. Bila resource Coolify tidak
ditemukan, blok mencoba nama kontainer jalur Compose cadangan (`kapdh-production-<api|worker>-1`).

```sh
for r in api worker; do
  c=$(docker ps --filter "label=coolify.resourceName=kapdh-$r" --filter "label=coolify.environmentName=production" --format '{{.Names}}' | head -n1)
  [ -n "$c" ] || c=$(docker ps --format '{{.Names}}' | grep -x "kapdh-production-$r-1" || true)
  if [ -z "$c" ]; then echo "kapdh-$r: BERHENTI, kontainer production tidak ditemukan"; continue; fi
  echo "== kapdh-$r ($c)"
  docker exec "$c" node -e 'const p=/^(NODE_ENV|FCM_[A-Z_]*|FIREBASE_[A-Z_]*|APNS_[A-Z_]*|GOOGLE_APPLICATION_CREDENTIALS)$/;const ks=Object.keys(process.env).filter(k=>p.test(k)).sort();for(const k of ks)console.log("  "+k+(String(process.env[k]).trim()?"":" (KOSONG)"));for(const k of ["FCM_PROJECT_ID","FCM_SERVICE_ACCOUNT_JSON"])if(!ks.includes(k))console.log("  HILANG: "+k);console.log("  NODE_ENV=production: "+(process.env.NODE_ENV==="production"?"ya":"TIDAK"))'
done
```

Hasil yang diharapkan (baris di bawah header identik untuk kedua resource; di dalam kurung tercetak nama kontainer
yang diperiksa):

```
== kapdh-api (<kontainer api>)
  FCM_PROJECT_ID
  FCM_SERVICE_ACCOUNT_JSON
  NODE_ENV
  NODE_ENV=production: ya
== kapdh-worker (<kontainer worker>)
  FCM_PROJECT_ID
  FCM_SERVICE_ACCOUNT_JSON
  NODE_ENV
  NODE_ENV=production: ya
```

- `(KOSONG)` di belakang nama: variabel ada tetapi isinya kosong atau hanya spasi. `HILANG: ...`: variabel tidak sampai
  ke kontainer (nama salah ketik, belum ditambahkan, atau 'Runtime' mati). Perbaiki di Normal view resource itu (4.1),
  lalu deploy.
- Nama lain (`FIREBASE_*`, `APNS_*`, `GOOGLE_APPLICATION_CREDENTIALS`) tidak dibaca server. Nilai `FIREBASE_*` hanya
  untuk build aplikasi (bagian 6), dan kunci APNs hanya di Firebase (bagian 8). Hapus variabel itu dari resource di
  Normal view, lalu deploy.
- `NODE_ENV=production: TIDAK`: image API/worker sudah memasang `NODE_ENV=production`, jadi nilainya ditimpa variabel
  `NODE_ENV` di resource. Penolakan start tanpa pasangan FCM (bagian 1) tidak berlaku selama itu. Hapus variabel itu
  di Normal view, lalu deploy.
- Bila nama di dalam kurung `kapdh-production-api-1`/`kapdh-production-worker-1`, yang diperiksa adalah kontainer
  jalur Compose cadangan. Perbaikan di atas lalu dilakukan di `/etc/kapdh/production.env` dan kontainer dibuat ulang
  (`compose-cadangan.md`), bukan di Coolify.
- `BERHENTI`: kontainer tidak ditemukan. Lihat nama, label Coolify, dan image setiap kontainer yang berjalan (tanpa
  nilai env):

  ```sh
  docker ps --format '{{.Names}}\t{{.Label "coolify.resourceName"}}\t{{.Label "coolify.environmentName"}}\t{{.Image}}'
  ```

  API dan worker production harus tampil dengan resource `kapdh-api`/`kapdh-worker`, lingkungan `production`, dan
  image dari repositori `ghcr.io/<org>/kapdh-api`/`ghcr.io/<org>/kapdh-worker`. Tag image boleh `sha-<commit>`,
  `vX.Y.Z` atau `production`; yang menentukan adalah repositorinya. Bila nama resource atau lingkungan berbeda,
  sesuaikan filter di blok ini serta di 4.2 dan 4.3.

### 4.2 Pemeriksaan di VPS tanpa mencetak nilai

Blok ini aman ditempel utuh di shell root VPS. Teks setelah `#` adalah hasil yang diharapkan. Tidak ada nilai FCM
yang dicetak, termasuk `FCM_PROJECT_ID`: bila JSON akun layanan keliru tertempel di variabel itu, mencetaknya berarti
mencetak private key. Bila salah satu kontainer tidak ditemukan, blok hanya mencetak `BERHENTI` (tanpa hasil palsu
"sama" atau `0`) dan shell tetap terbuka.

```sh
CA=$(docker ps --filter label=coolify.resourceName=kapdh-api --filter label=coolify.environmentName=production --format '{{.Names}}' | head -n1)
CW=$(docker ps --filter label=coolify.resourceName=kapdh-worker --filter label=coolify.environmentName=production --format '{{.Names}}' | head -n1)
echo "api=$CA worker=$CW"                                                       # dua nama kontainer Coolify
if [ -n "$CA" ] && [ -n "$CW" ]; then
for c in "$CA" "$CW"; do docker exec "$c" node -e 'const j=JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON);const k=String(j.private_key);console.log(typeof j.client_email,k.includes("BEGIN PRIVATE KEY"),k.includes("\n"),j.project_id===process.env.FCM_PROJECT_ID)'; done   # string true true true (dua kali)
for k in FCM_PROJECT_ID FCM_SERVICE_ACCOUNT_JSON; do [ "$(docker exec "$CA" printenv $k | sha256sum)" = "$(docker exec "$CW" printenv $k | sha256sum)" ] && echo "$k sama" || echo "$k BEDA"; done   # dua baris "sama"
for c in "$CA" "$CW"; do [ "$(docker exec "$c" printenv FCM_PROJECT_ID)" = kapdh-prod ] && echo "FCM_PROJECT_ID kapdh-prod" || echo "FCM_PROJECT_ID BUKAN kapdh-prod"; done   # dua baris "FCM_PROJECT_ID kapdh-prod"
for c in "$CA" "$CW"; do docker exec "$c" printenv FCM_PROJECT_ID FCM_SERVICE_ACCOUNT_JSON | grep -cE 'belum-dikonfigurasi|\.invalid'; done   # 0 dan 0
docker logs "$CA" 2>&1 | grep -c 'gagal start'; docker logs "$CW" 2>&1 | grep -c 'gagal start'   # 0 dan 0
else echo "BERHENTI: kontainer api/worker production tidak ditemukan (periksa nama resource dan label Coolify)"; fi
```

- `true` ketiga berarti `\n` di JSON sudah menjadi baris baru sungguhan, sehingga kunci PEM utuh. `false` biasanya
  berarti nilai diberi kutip atau diringkas dua kali. Ulangi bagian 3 dan 4.1.
- `true` keempat berarti `project_id` di JSON sama dengan `FCM_PROJECT_ID` (perbandingan nilai mentah, jadi spasi di
  akhir pun membuatnya `false`).
- Baris `BEDA` berarti nilai API dan worker berbeda. Tempel ulang nilai yang sama di kedua resource, lalu deploy
  keduanya.
- Baris `FCM_PROJECT_ID BUKAN kapdh-prod` berarti nilainya salah ketik, memuat spasi, atau berisi isi variabel lain
  (misalnya JSON akun layanan). Jangan mencetak nilainya untuk memeriksa. Isi ulang `kapdh-prod` di Normal view kedua
  resource (4.1), lalu deploy. Bila JSON akun layanan sempat tertempel di variabel itu dan nilainya pernah tercetak di
  layar atau log, rotasi kuncinya (bagian 7).

### 4.3 Menyalin nilai ke berkas env VPS

`/etc/kapdh/production/api.env` dan `worker.env` adalah salinan cadangan konfigurasi. Berkas ini dipakai jalur
Compose cadangan dan pemeriksaan "BEDA" pasca-deploy, sedangkan Coolify tetap menjadi sumber nilai runtime. Jalankan
blok ini **setelah** bagian 5 LULUS, supaya berkas masih memuat nilai lama selama kunci baru belum terbukti (bagian 9).
Nilai mengalir lewat env proses (`ENVIRON` di awk), bukan lewat argumen. Blok hanya mencetak nama variabel.

```sh
( set -eu
umask 077
D=/etc/kapdh/production
CA=$(docker ps --filter label=coolify.resourceName=kapdh-api --filter label=coolify.environmentName=production --format '{{.Names}}' | head -n1)
CW=$(docker ps --filter label=coolify.resourceName=kapdh-worker --filter label=coolify.environmentName=production --format '{{.Names}}' | head -n1)
[ -n "$CA" ] && [ -n "$CW" ] || { echo "BERHENTI: kontainer api/worker tidak ditemukan"; exit 1; }
salin() {
f=$1; c=$2; shift 2
for k in "$@"; do
grep -q "^$k=" "$f" || { echo "BERHENTI: $k tidak ada di $f"; exit 1; }
V=$(docker exec "$c" printenv "$k") || { echo "BERHENTI: $k tidak ada di kontainer"; exit 1; }
[ -n "$V" ] || { echo "BERHENTI: $k kosong di kontainer"; exit 1; }
[ "$(printf '%s' "$V" | wc -l)" -eq 0 ] || { echo "BERHENTI: $k lebih dari satu baris"; exit 1; }
V="$V" awk -v k="$k" 'BEGIN{FS=OFS="="} $1==k{print k "=" ENVIRON["V"]; next} {print}' "$f" > "$f.tmp"
mv "$f.tmp" "$f"
echo "OK $k -> ${f##*/}"
done
}
salin $D/api.env "$CA" FCM_PROJECT_ID FCM_SERVICE_ACCOUNT_JSON
salin $D/worker.env "$CW" FCM_PROJECT_ID FCM_SERVICE_ACCOUNT_JSON
)
```

Hasilnya dua baris `OK ... -> api.env` dan dua baris `OK ... -> worker.env`. Lalu validasi:

```sh
D=/etc/kapdh/production
CA=$(docker ps --filter label=coolify.resourceName=kapdh-api --filter label=coolify.environmentName=production --format '{{.Names}}' | head -n1)
CW=$(docker ps --filter label=coolify.resourceName=kapdh-worker --filter label=coolify.environmentName=production --format '{{.Names}}' | head -n1)
stat -c '%U:%G %a %n' $D/api.env $D/worker.env                                   # root:root 600 untuk keduanya
grep -c '=$' $D/api.env $D/worker.env                                            # ...:0 dan ...:0
grep -cE 'belum-dikonfigurasi|\.invalid' $D/api.env $D/worker.env                # ...:0 dan ...:0
for k in FCM_PROJECT_ID FCM_SERVICE_ACCOUNT_JSON; do for p in "api $CA" "worker $CW"; do set -- $p; [ "$(grep "^$k=" $D/$1.env | cut -d= -f2- | sha256sum)" = "$(docker exec "$2" printenv "$k" | sha256sum)" ] && echo "$k $1 sama" || echo "$k $1 BEDA"; done; done   # empat baris "sama"
```

Blok ini hanya mengganti dua baris yang sudah ada, jadi jumlah baris kedua berkas tidak berubah.

## 5. Uji mandiri `push-selftest`

CLI ini membuktikan kredensial server tanpa mengirim notifikasi:

1. Isi JSON diperiksa dan hanya dilaporkan sebagai boolean: `type`, `project_id` = `FCM_PROJECT_ID`, dan
   `private_key` terbaca sebagai kunci RSA PKCS8 oleh `node:crypto`. `client_email` hanya tampil tersamar, dan
   `private_key_id` hanya 8 karakter awal (untuk mencocokkan kunci di IAM saat rotasi).
2. Token akses OAuth ditukar dengan kode yang **sama** dengan pengirim push (`fetchFcmAccessToken` di `push.ts`).
3. FCM HTTP v1 `messages:send` dipanggil dengan `"validate_only": true` ke token dummy yang jelas tidak sah.
   FCM memeriksa kredensial dan izin dulu, lalu menolak token dummy. Tidak ada perangkat yang menerima apa pun.

Keluaran tidak pernah memuat private key, token akses, atau token FCM.

### 5.1 Prasyarat: image yang memuat CLI

CLI ada di image API `sha-<commit>` yang dibangun dari commit yang memuat `apps/api/src/cli/push-selftest.ts`
(Dockerfile.api memeriksa `dist/cli/push-selftest.js` saat build). Image dibangun CI (`docs/runbooks/ci-cd.md`), lalu
dipasang mengikuti `docs/runbooks/rilis-dan-gerbang-go-live.md` bagian 5, tanpa jalur pintas. Selama production
memakai jalur manual (tanpa `release.yml`), urutannya bagian 5 langkah 2-3: job rilis
`run-release.sh production ghcr.io/<org>/kapdh-release:sha-<commit>` **[bukti]** (cek versi skema, migrasi bila ada,
`roles.sql`, gerbang go-live), lalu tag `kapdh-api` dan `kapdh-worker` di Coolify diganti ke `sha-<commit>` yang
sama, deploy API dulu lalu worker, dan uji asap. Bila gerbang go-live merah karena hal yang tidak terkait, pakai
pengecualian bagian 5.3 (alasan dan penyetuju tercatat). Mengganti tag saja tanpa job rilis hanya untuk rollback
(bagian 6.1). Periksa:

```sh
CA=$(docker ps --filter label=coolify.resourceName=kapdh-api --filter label=coolify.environmentName=production --format '{{.Names}}' | head -n1)
docker exec "$CA" sh -c 'test -f dist/cli/push-selftest.js && echo ada || echo "belum ada (image lama)"'   # ada
```

Sebelum image itu terpasang, pakai 4.2 saja, lalu buktikan push lewat uji kirim sungguhan di perangkat nyata
(`production-init.md` 5.6). Pengirim push di image lama sudah memakai nilai FCM yang sama; yang belum ada hanya CLI ini
(termasuk 5.3).

### 5.2 Menjalankan uji kredensial

```sh
CA=$(docker ps --filter label=coolify.resourceName=kapdh-api --filter label=coolify.environmentName=production --format '{{.Names}}' | head -n1)
docker exec "$CA" node dist/cli/push-selftest.js; echo "exit=$?"
```

Contoh keluaran yang lulus:

```
Uji mandiri push FCM KAPDH (F-13) - 2026-10-18T03:00:00.000Z
Mode validate_only: FCM hanya memvalidasi pesan; tidak ada notifikasi yang dikirim ke perangkat.

  FCM_PROJECT_ID: kapdh-prod
  client_email: fir***@kapdh-prod.iam.gserviceaccount.com
  private_key_id (8 karakter awal): 1a2b3c4d
  type = service_account: ya
  project_id JSON = FCM_PROJECT_ID: ya
  private_key PKCS8 terbaca: ya
  oauth: ok
  fcm: ok, HTTP 400 INVALID_ARGUMENT untuk token dummy (diharapkan: token ditolak, kredensial dan izin FCM diterima)

LULUS: kredensial akun layanan dan izin FCM benar untuk proyek kapdh-prod.
exit=0
```

| Kode keluar | Arti |
| --- | --- |
| 0 | LULUS. Kredensial dan izin FCM benar, dan bila token stdin diberikan, token itu juga valid. |
| 1 | GAGAL. Baris bertanda `GAGAL` menyebut penyebabnya, dan baris di bawahnya menyebut perbaikannya. |
| 2 | Argumen salah, env FCM kosong, atau stdin tidak berisi tepat satu token. |
| 3 | Galat teknis: jaringan, batas waktu, atau 429/5xx dari Google. Belum ada keputusan, jadi ulangi nanti. |

| Baris | Penyebab | Perbaikan |
| --- | --- | --- |
| `fcm: ok, HTTP 400 INVALID_ARGUMENT` atau `HTTP 404 UNREGISTERED` | Diharapkan untuk token dummy (FCM menyebut token registrasi tidak sah) | Tidak ada |
| `FCM_PROJECT_ID: tidak berbentuk Project ID Firebase (isi tidak ditampilkan)` | Nilai memuat spasi (mis. di akhir), berisi JSON akun layanan, atau berupa nama tampilan/nomor proyek. Pengirim push memakai nilai apa adanya, jadi push juga gagal | 4.1 (`kapdh-prod`, tanpa spasi), lalu 4.2 |
| `fcm: GAGAL, HTTP 400 INVALID_ARGUMENT: INVALID_ARGUMENT tidak menyebut token` | FCM menolak pesan uji itu sendiri, jadi kredensial dan izin belum terbukti | Laporkan ke pengembang beserta keluarannya |
| `private_key PKCS8 terbaca: tidak` | JSON diberi kutip, diringkas dua kali, atau bukan berkas kunci Google | Bagian 3 dan 4.1 |
| `oauth: GAGAL, HTTP 400 invalid_grant` | Kunci dihapus atau dinonaktifkan di IAM, akun layanan dihapus, atau jam VPS melenceng | Bagian 7, `timedatectl` |
| `fcm: GAGAL, HTTP 401 ...` | Token akses ditolak FCM | Bagian 7 |
| `fcm: GAGAL, HTTP 403 ...: izin IAM kurang atau FCM_PROJECT_ID salah` | Kunci dari proyek lain, atau akun layanan tanpa izin FCM | Bagian 3 (akun `firebase-adminsdk` proyek `kapdh-prod`) |
| `fcm: GAGAL, HTTP 403 ...: Firebase Cloud Messaging API (V1) belum aktif` | API V1 mati | Bagian 2.3 |
| `fcm: GAGAL, HTTP 404 ...: FCM_PROJECT_ID salah` | Project ID salah ketik, atau yang dipakai nama tampilan/nomor proyek | 4.1 (`kapdh-prod`) |
| `PERINGATAN: project_id di JSON berbeda` | Kunci dibuat di proyek lain | Buat kunci di `kapdh-prod` (bagian 3) |

### 5.3 Memvalidasi token perangkat nyata (opsional)

`--token-from-stdin` membaca **satu** token FCM dari stdin. Token tidak pernah diterima dari argumen dan tidak pernah
ditampilkan. Token divalidasi dengan `validate_only`, jadi tidak ada notifikasi yang terkirim. Cara termudah adalah
mengambil token terbaru dari database dan mengalirkannya lewat pipa, sehingga token tidak pernah tampil di layar.
Syaratnya, aplikasi build production (bagian 6) sudah login di perangkat uji.

```sh
CA=$(docker ps --filter label=coolify.resourceName=kapdh-api --filter label=coolify.environmentName=production --format '{{.Names}}' | head -n1)
PG=$(docker ps --format '{{.Names}}' | grep -x 2ohiu7mobeihyqhthcqyix6o)        # kontainer PostgreSQL production
docker exec "$PG" psql -U postgres -d kapdh -XAt -c "select platform, count(*) from app.device_tokens where revoked_at is null group by platform"   # mis. android|1
docker exec "$PG" psql -U postgres -d kapdh -XAt -c "select token from app.device_tokens where revoked_at is null and platform = 'android' order by last_seen_at desc limit 1" | docker exec -i "$CA" node dist/cli/push-selftest.js --token-from-stdin; echo "exit=$?"
```

Filter `platform = 'android'` dipakai sampai kunci APNs terpasang (bagian 8). Tanpa filter itu, token iOS terbaru
akan menghasilkan `GAGAL ... THIRD_PARTY_AUTH_ERROR` walaupun push Android sehat. Bila kueri tidak mengembalikan
baris, CLI berhenti dengan `token dari stdin kosong` (kode 2): belum ada perangkat Android production yang login dengan
izin notifikasi.

Hasil yang lulus menampilkan `token stdin: ok, valid untuk proyek kapdh-prod ...` dan `exit=0`. Arti hasil lain:

- `tidak terdaftar (UNREGISTERED)`: aplikasi dihapus atau tokennya kedaluwarsa. Buka aplikasi dan login lagi.
- `milik proyek Firebase lain (SENDER_ID_MISMATCH)`: build aplikasi memakai `FIREBASE_*` dari proyek lain. Bangun
  ulang dengan berkas bagian 6. Saat pengiriman nyata, server menonaktifkan token seperti ini.
- `kredensial APNs ditolak (THIRD_PARTY_AUTH_ERROR)`: token iOS, tetapi kunci APNs belum ada (bagian 8).

Token dari sumber lain, misalnya log build debug, ditempel lewat TTY. Mode raw membuat ketikan tidak tampil, lalu
akhiri dengan Enter:

```sh
docker exec -it "$CA" node dist/cli/push-selftest.js --token-from-stdin
```

`push-selftest` tidak menggantikan uji kirim sungguhan. Tetap jalankan `production-init.md` 5.6: akun uji di perangkat
nyata menerima push, dan kegagalan terlihat di web admin Notifikasi → Pengiriman.

## 6. Build aplikasi: berkas dart-define `C:\kapdh-secure\firebase-production.json`

### 6.1 Isi berkas

Folder `C:\kapdh-secure\` berada di luar repo, di PC build tepercaya. Berkas ini hanya memuat kunci push. URL API dan
`KAPDH_ENV` tetap berasal dari `kapdh-mobile/config/production.json`.

```json
{
  "PUSH_ENABLED": "true",
  "FIREBASE_PROJECT_ID": "kapdh-prod",
  "FIREBASE_MESSAGING_SENDER_ID": "931256687765",
  "FIREBASE_API_KEY": "<kunci API dari 2.5>",
  "FIREBASE_ANDROID_APP_ID": "1:931256687765:android:<...>",
  "FIREBASE_IOS_APP_ID": "1:931256687765:ios:<...>"
}
```

`FIREBASE_PROJECT_ID` **wajib sama** dengan `FCM_PROJECT_ID` server (`kapdh-prod`). Bila berbeda, setiap token yang
didaftarkan aplikasi ditolak FCM dengan `SENDER_ID_MISMATCH` dan dinonaktifkan server (bagian 1). Periksa tanpa
menampilkan kunci API:

```powershell
node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const s=j.FIREBASE_MESSAGING_SENDER_ID;console.log(j.FIREBASE_PROJECT_ID,s,j.PUSH_ENABLED,String(j.FIREBASE_API_KEY).startsWith('AIza'),String(j.FIREBASE_ANDROID_APP_ID).startsWith('1:'+s+':android:'),String(j.FIREBASE_IOS_APP_ID).startsWith('1:'+s+':ios:'),Object.keys(j).length)" C:\kapdh-secure\firebase-production.json   # kapdh-prod 931256687765 true true true true 6
```

### 6.2 Build

Gabungkan `config/production.json` dengan berkas ini (berkas kedua menimpa `PUSH_ENABLED` dan `FIREBASE_*` yang kosong),
lalu build. Perintah gabung Node ada di `kapdh-mobile/docs/BUILD.md` bagian 2 (`/aman/firebase-production.json` =
`C:\kapdh-secure\firebase-production.json`). Perintah build ada di bagian 3.2 untuk AAB toko, atau 3.4 untuk APK uji
internal dengan push. Hapus berkas gabungan sementara setelah build.

- Versi build wajib **>= `1.0.0`** (`pubspec.yaml`). Server menolak setiap mutasi kecuali logout dari versi di bawah
  `min_app_version` (`1.0.0`) dengan 426 `UPGRADE_REQUIRED` (`apps/api/src/core/http/request-gate.ts`). Akibatnya,
  build lama tidak bisa login maupun mendaftarkan token push.
- Build tanpa berkas ini (atau dengan `PUSH_ENABLED=false`) tetap berjalan, tetapi tanpa push (AC F13-2).

## 7. Rotasi kunci akun layanan

Lakukan minimal setahun sekali, saat pemegang akses berganti, atau **segera** bila kunci diduga bocor. Kunci lama
tetap berlaku sampai dihapus, jadi push tidak terputus selama rotasi.

1. Buat kunci **baru** untuk akun layanan yang sama (bagian 3 langkah 1). Kunci lama jangan dihapus dulu.
2. Ringkas ke clipboard (bagian 3 langkah 2). Isi `FCM_SERVICE_ACCOUNT_JSON` di `kapdh-api` **dan** `kapdh-worker`
   (4.1 langkah 1-3). `FCM_PROJECT_ID` tidak berubah.
3. Deploy `kapdh-api`, lalu `kapdh-worker` (4.1 langkah 4).
4. Jalankan 4.2 (dua baris "sama"), lalu `push-selftest` (5.2) sampai LULUS. Nilai `private_key_id (8 karakter
   awal)` harus sama dengan awal Key ID kunci baru di Google Cloud Console → 'IAM & Admin' → 'Service accounts' →
   `firebase-adminsdk-...@kapdh-prod.iam.gserviceaccount.com` → tab 'Keys'.
5. Jalankan 4.3 (berkas env VPS).
6. Di tab 'Keys' yang sama, **hapus kunci lama**. Kunci lama dikenali dari Key ID yang berbeda dari langkah 4 dan
   tanggal pembuatan yang lebih lama. Jalankan `push-selftest` sekali lagi, hasilnya harus tetap LULUS.
7. Bersihkan PC (4.1 langkah 6).

**Kunci bocor:** hapus kunci yang bocor di tab 'Keys' **lebih dulu**, lalu kerjakan langkah 1-5 dan 7. Selama jeda
itu, push gagal OAuth (`auth_error`, dicoba ulang oleh worker). Notifikasi tetap tercatat di inbox dan email tidak
terdampak. Token akses yang sudah diterbitkan dari kunci itu kedaluwarsa paling lama 1 jam.

## 8. iOS: kunci APNs (`.p8`) — nanti

Push iOS butuh kunci APNs di proyek Firebase. Kunci itu dibuat setelah akun Apple Developer organisasi aktif
(`docs/runbooks/app-store-submission.md`). Entitlement `aps-environment` sudah ada di repo
(`kapdh-mobile/ios/Runner/Runner.entitlements`, bersama `applinks:kapdh.or.id`). Build iOS yang ditandatangani tim
Apple organisasi diharapkan mendaftarkan token push setelah pengguna login, asalkan dibangun dengan
`PUSH_ENABLED=true` dan nilai `FIREBASE_*` lengkap termasuk `FIREBASE_IOS_APP_ID` (bagian 6). Perilaku ini belum diuji
di perangkat; buktikan di iPhone nyata (langkah 5, `production-init.md` 5.6).

Bila token APNs belum tiba saat login (galat `apns-token-not-set`, umum pada izin pertama atau peluncuran dingin),
aplikasi mencoba `getToken` lagi beberapa kali selama sekitar 30 detik dan tetap mendengarkan pembaruan token. Log
debug-nya: `push: token APNs belum tersedia, dicoba lagi dalam N detik`, lalu
`push: token APNs belum tersedia setelah N percobaan, menunggu pembaruan token` bila semua percobaan habis. Galat lain
(mis. konfigurasi `FIREBASE_*` salah) tidak dicoba ulang dan dicatat dengan kodenya.

**Urutan aman:** unggah `.p8` **lebih dulu** (langkah 1-2) ke proyek Firebase yang dipakai build itu
(`FIREBASE_PROJECT_ID` build): `kapdh-prod` untuk build production, proyek Firebase staging untuk build staging yang
dibagikan lewat TestFlight (ADR-016). Berkas `.p8` yang sama boleh diunggah ke kedua proyek. Baru setelah itu bagikan
build iOS apa pun yang membawa entitlement itu, termasuk TestFlight. Tanpa kunci di proyek build itu, setiap
pengiriman ke token iOS gagal dan tidak dicoba ulang. Notifikasi tetap ada di inbox, tetapi push iOS hilang dan alert
penyedia push (`monitoring.md` monitor 10) dapat menyala.

1. Apple Developer → 'Certificates, Identifiers & Profiles' → 'Keys' → '+'. Centang 'Apple Push Notifications service
   (APNs)', unduh berkas `AuthKey_<KEYID>.p8` (hanya bisa diunduh sekali), lalu catat Key ID dan Team ID.
2. Firebase Console → Project settings → 'Cloud Messaging' → 'Apple app configuration' (aplikasi iOS
   `id.or.kapdh.app`) → 'APNs Authentication Key' → 'Upload'. Isi berkas `.p8`, Key ID, dan Team ID. Ulangi di proyek
   Firebase staging bila build staging iOS akan dibagikan (urutan aman di atas).
3. Aktifkan capability 'Push Notifications' pada App ID `id.or.kapdh.app` (`production-init.md` 5.4).
4. Simpan `.p8` di password manager organisasi, lalu hapus dari folder unduhan (seperti 4.1 langkah 6).
5. Uji di iPhone nyata dengan build production (5.3 dan `production-init.md` 5.6). Sebelum langkah 2 selesai, FCM
   menolak pengiriman ke token iOS dengan `THIRD_PARTY_AUTH_ERROR` dan pengiriman itu tidak dicoba ulang. Android
   tidak terdampak.

Server tidak perlu diubah. Kunci APNs hanya ada di Firebase, tidak di Coolify.

**Membedakan galat APNs dari galat akun layanan.** Penolakan APNs disimpan sebagai `error_class` `AUTH_ERROR`, kelas
yang sama dengan kegagalan OAuth atau izin akun layanan (bagian 7). Bedanya terlihat dari platform token. Di web admin
Notifikasi → Pengiriman, saring 'Kelas galat' `AUTH_ERROR` dan lihat kolom 'Kanal'. Bila hanya `Push (iOS)`, kunci
APNs belum ada atau salah di Firebase (bagian ini). Bila `Push (Android)` juga ada, masalahnya kunci akun layanan
(bagian 7, lalu `push-selftest` 5.2). Lewat SQL, tanpa token:

```sh
PG=$(docker ps --format '{{.Names}}' | grep -x 2ohiu7mobeihyqhthcqyix6o)        # kontainer PostgreSQL production
docker exec "$PG" psql -U postgres -d kapdh -XAt -c "select t.platform, count(*) from app.notification_deliveries d join app.device_tokens t on t.id = d.device_token_id where d.channel = 'push' and d.error_class = 'AUTH_ERROR' and d.updated_at > now() - interval '24 hours' group by t.platform"   # hanya ios|<n> = kunci APNs
```

Bila tidak ada pengiriman Android dalam rentang itu, hasil "hanya iOS" belum cukup. `push-selftest` (5.2) yang LULUS
membuktikan akun layanan sehat, sehingga `AUTH_ERROR` di iOS berasal dari kunci APNs.

## 9. Rollback dan gangguan

| Gejala | Tindakan |
| --- | --- |
| Deploy gagal: log `... gagal start`, Coolify membatalkan rolling update | Kontainer lama tetap berjalan. Perbaiki nilai di Normal view (tanpa kutip, Multiline mati, satu baris), lalu deploy lagi. |
| `push-selftest` GAGAL setelah kunci baru dipasang | Kunci lama masih berlaku karena belum dihapus (bagian 7 langkah 6). Perbaiki sesuai tabel 5.2, atau buat kunci baru lagi. Ini cara tercepat dan tidak perlu menampilkan secret. |
| Harus kembali ke nilai sebelumnya, dan Firebase Console tidak dapat diakses | Berkas env VPS masih memuat nilai lama, karena 4.3 baru dijalankan setelah LULUS. Salin nilai itu ke Normal view kedua resource dengan kehati-hatian yang sama seperti saat secret ditampilkan (tanpa berbagi layar, lalu `clear; printf '\033[3J'`), kemudian deploy API, lalu worker. |
| Push gagal massal di web admin Notifikasi → Pengiriman, sementara `push-selftest` LULUS | Periksa kelas galat per pengiriman. `UNREGISTERED` dan `SENDER_ID_MISMATCH` berasal dari token aplikasi (bagian 6), bukan dari server. |
| Push harus dimatikan darurat | Production menolak start tanpa pasangan FCM, jadi variabel tidak boleh dikosongkan. Di Normal view **kedua** resource, isi nilai placeholder dari tabel di bawah persis (satu baris, tanpa kutip tambahan, Multiline mati), lalu deploy API dan worker. Push gagal lokal (kunci placeholder ditolak sebelum permintaan jaringan apa pun), sedangkan inbox dan email tetap berjalan. **Bukti push benar-benar mati:** log deploy kedua resource tidak memuat `gagal start` dan berakhir "Rolling update completed." (bila deploy dibatalkan, kontainer lama tetap mengirim push dengan kunci nyata), lalu baris `grep -c 'belum-dikonfigurasi...'` di 4.2 menampilkan `2` dan `2` (bukan `0`). Catat sebagai insiden (`incident-response.md`). Untuk menyalakan lagi, isi kembali nilai nyata (bagian 3-4.1, atau berkas env VPS yang belum ditimpa) lalu jalankan 4.2 dan bagian 5. |

Nilai placeholder untuk mematikan push (tidak rahasia):

| Variabel | Nilai persis |
| --- | --- |
| `FCM_PROJECT_ID` | `kapdh-fcm-belum-dikonfigurasi` |
| `FCM_SERVICE_ACCOUNT_JSON` | `{"client_email":"belum-dikonfigurasi@kapdh.invalid","private_key":"belum-dikonfigurasi"}` |

JSON ini sengaja memuat `client_email` dan `private_key` bertipe string. Bila salah satunya hilang, API dan worker
menolak start (`parseFcmServiceAccount`), deploy dibatalkan, dan push tetap menyala diam-diam. Jangan menjalankan 4.3
selama placeholder terpasang, agar berkas env VPS tetap memuat nilai nyata.

Rollback image API/worker tidak mengubah env Coolify (`rilis-dan-gerbang-go-live.md` bagian 6.1). Image lama tanpa
`push-selftest` tetap memakai nilai FCM yang sama.
