# Pemeriksaan transport dan header 2026-10 (gerbang `go-live.md` 2.4)

Prosedur: `docs/runbooks/go-live.md` bagian 2.4. Konfigurasi yang diperiksa: HSTS dan pengalihan HTTP → HTTPS
(`docs/runbooks/rilis-dan-gerbang-go-live.md` bagian 7), pengalihan host lama (bagian 7.1), dan port
(`docs/runbooks/production-init.md` 1.1). Ini pemeriksaan pertama pada production, dijalankan tepat setelah domain
dipindah ke VPS. Gerbang tetap diulang pada kandidat rilis sebelum go-live.

| Butir | Nilai |
| ----- | ----- |
| Tanggal | 21 Oktober 2026. Pemeriksaan dari mesin build 13:56-15:24 UTC (cap waktu respons API); blok gerbang lengkap 15:23:24 UTC. Pemindaian `nmap` dan perubahan di VPS dilakukan pada hari yang sama (jamnya tidak dicatat) |
| Pelaksana / saksi | Bayu Musthafa (pemilik produk; DNS, Coolify dan VPS) / …… |
| Lingkungan | production: VPS IDCloudHost, Coolify v4.4.6, Traefik `coolify-proxy`; DNS Cloudflare, semua record "DNS only" |
| Commit yang berjalan | web, admin dan API `2e25d719ea75d0fb8d2e6b8a831d71de81226823` (`/version.json`, `GET /api/v1/health`) |
| DNS | `kapdh.or.id`, `admin`, `api`, `baru`, `admin-baru`: record A ke VPS; `www`: CNAME ke `kapdh.or.id`; tidak ada record AAAA untuk keenam host (DoH Cloudflare) |
| Titik pemeriksaan header, CORS, WSS | mesin build di balik VPN berbasis TUN, `curl --resolve <host>:443:<IP VPS>` karena cache DNS lokal masih menyimpan record lama. `curl` memverifikasi sertifikat Let's Encrypt tiap host, dan jawaban memuat commit yang berjalan, jadi permintaan HTTPS dan WSS memang sampai ke VPS. VPN itu hanya mengacaukan pemindaian port mentah (temuan 3) |
| Titik pemeriksaan port | `nmap -Pn -sV` dari VPS lain, serta `ss`, `docker ps` dan `iptables -S DOCKER-USER` di VPS |

## Urutan pindah domain

1. DNS `kapdh.or.id`, `www` dan `admin` diarahkan ke VPS (`admin` dari CNAME situs lama menjadi record A). Sampai
   langkah 2 selesai, Traefik menjawab ketiga host dengan sertifikat bawaan `TRAEFIK DEFAULT CERT`, sehingga peramban
   menampilkan peringatan sertifikat. Pada pindah domain berikutnya, ubah DNS dan domain resource Coolify dalam satu
   jendela kerja.
2. Domain ditambahkan ke resource `kapdh-web` (`kapdh.or.id`, `www`, `baru`, dengan Direction "Redirect to non-www")
   dan `kapdh-admin` (`admin`, `admin-baru`). Sertifikat Let's Encrypt baru terbit untuk `kapdh.or.id`, `www` dan `admin`; `api`, `baru` dan `admin-baru` sudah
   bersertifikat sejak sebelumnya.
3. `PUBLIC_WEB_URL` (API dan worker) diubah dari `https://baru.kapdh.or.id` menjadi `https://kapdh.or.id`, dan
   `ADMIN_ORIGIN` (API) dari `https://admin-baru.kapdh.or.id` menjadi `https://admin.kapdh.or.id`, lalu Redeploy.
4. Pengalihan `www`, `baru` dan `admin-baru` dipasang lewat berkas dinamis `kapdh-pengalihan.yaml`
   (`rilis-dan-gerbang-go-live.md` 7.1), karena "Redirect to non-www" memakai pengalihan sementara (teramati `307` untuk HEAD; untuk GET Traefik
   menjawab `302`). Domain resource
   dirampingkan menjadi alamat utama saja: `kapdh-web` hanya `https://kapdh.or.id`, `kapdh-admin` hanya
   `https://admin.kapdh.or.id` (dikonfirmasi pemilik dari layar Coolify). Ketiga host lama kini dilayani router berkas
   dinamis (GET `301` dan HEAD `308`, bukan pengalihan sementara).

## Hasil

| Host / butir | Target `go-live.md` 2.4 | Hasil |
| ------------ | ----------------------- | ----- |
| `kapdh.or.id` | 200, HSTS max-age >= 31536000, CSP `frame-ancestors 'none'`, `nosniff`, `no-referrer` | lulus |
| `www.kapdh.or.id` | pengalihan permanen ke `https://kapdh.or.id/kebijakan-privasi` | lulus: GET `301`, HEAD `308`, `location` sama |
| `admin.kapdh.or.id` | 200, HSTS, CSP `frame-ancestors 'none'` dan `connect-src` ke API, `X-Frame-Options: DENY`, `nosniff`, `no-referrer` | lulus |
| `api.kapdh.or.id` | 200, HSTS, `nosniff`, `no-referrer` | lulus; HSTS `max-age=31536000` tanpa `includeSubDomains`, dari proxy. `HSTS_ENABLED` pada resource API tidak diperiksa, jadi butir `production-init.md` 1.2 "API: `HSTS_ENABLED=true`" belum terbukti oleh catatan ini |
| WSS `api.kapdh.or.id/socket.io/` | `101 Switching Protocols` | lulus |
| Port 5432/6379, panel Coolify (8000/6001/6002), 8080 | tidak ada layanan yang menjawab dari luar | lulus menurut pemeriksaan di VPS (temuan 1 dan 3) |

- [x] Sertifikat Let's Encrypt: `kapdh.or.id`, `www`, `admin` (berlaku sampai 19 Januari 2027), `api`, `baru`,
      `admin-baru` (sampai 13 Januari 2027).
- [x] HTTP → HTTPS: GET `301`, HEAD/POST `308`, path dan query sama.
- [x] Host lama, GET: `www.kapdh.or.id/kebijakan-privasi?x=1` → `301 https://kapdh.or.id/kebijakan-privasi?x=1`;
      `baru.kapdh.or.id/kta/<nomor>` → `301 https://kapdh.or.id/kta/<nomor>`; `admin-baru.kapdh.or.id/login` →
      `301 https://admin.kapdh.or.id/login`. HEAD dan POST `308` dengan `location` yang sama. Ketiganya memuat HSTS.
- [ ] Token `#t=` pada QR KTA lama ikut terbawa saat `baru` dialihkan. Ini perilaku standar peramban (`location` tidak
      memuat fragmen), tetapi belum diuji langsung. Uji: buka `https://baru.kapdh.or.id/kta/<nomor>#t=<token>` dari
      QR KTA yang sah, lalu pastikan alamat akhirnya `https://kapdh.or.id/kta/<nomor>#t=<token>` dengan status terkini.
- [x] CORS API: hanya `https://kapdh.or.id` dan `https://admin.kapdh.or.id` yang menerima
      `access-control-allow-origin`; `www`, `baru` dan `admin-baru` tidak.
- [x] Readiness API: `status=ok`, `database=ok redis=ok storage=ok deletion_ledger=ok`.
- [x] Situs: `/`, `/kebijakan-privasi`, `/ketentuan`, `/ketentuan-komunitas`, `/bantuan`, `/tentang`, `/kontak`,
      `/unduh`, `/delete-account` dan `/kta/<nomor>` menjawab 200. Di peramban, isi Kebijakan Privasi (dibaca dari API)
      tampil tanpa galat konsol.
- [x] Naskah terbit (`GET /public/pages/{slug}`): Kebijakan Privasi v3, Ketentuan v2, Ketentuan Komunitas v2, Bantuan
      v2, Tentang v3. Tidak ada yang menautkan `baru.kapdh.or.id` atau situs lama.
- [x] Admin: halaman login tampil di `https://admin.kapdh.or.id/login`, commit sama dengan API.
- [x] Port dari luar, dipindai sebelum DROP 8080 dipasang. Port 80 (Go net/http) dan 443 (jawaban
      `503 no available server` untuk permintaan ke IP) dikenali sebagai Traefik. Dari port gerbang (3000, 5432, 6379,
      6001, 6002, 8000, 8080) tidak ada yang dikenali layanannya: 3000, 5432, 6379, 8080 dan port kontrol 9999
      sama-sama `tcpwrapped`. Port 6001/6002 hanya ditebak `X11` dan 8000 `http-alt?` tanpa versi: itu nama dari
      tabel port `nmap`, bukan layanan yang dikenali. Saat itu 8080 masih dipublikasikan `coolify-proxy` tanpa DROP
      dan tanpa pendengar di dalam kontainer, tetapi tetap tampak `tcpwrapped`. Jadi pemindaian dari luar pada
      jaringan ini tidak dapat membedakan port yang dipublikasikan dari port kosong; kepastiannya datang dari
      pemeriksaan di VPS. Pemindaian dari luar belum diulang setelah DROP 8080.
- [x] Port di VPS: PostgreSQL, Redis, API, worker, web dan admin tidak dipublikasikan ke host. Port 8000/6001/6002
      (Coolify) dan 8080 (`coolify-proxy`) dipublikasikan, tetapi paket dari `ens3` ke port itu di-DROP `DOCKER-USER`
      (skrip unit `kapdh-docker-user-fw`). Panel Coolify tetap dilayani Traefik lewat 443 di subdomain panel. `ss`
      tidak menunjukkan pendengar IPv6.

## Temuan

1. **Port 8080 `coolify-proxy`** dipublikasikan ke `0.0.0.0` tanpa aturan DROP. Tidak ada layanan yang menjawab
   (Traefik tidak membuka entrypoint di sana), tetapi port ditutup agar dashboard Traefik tidak langsung terbuka bila
   kelak diaktifkan. 21 Oktober 2026: `8080` ditambahkan ke daftar port skrip `kapdh-docker-user-fw`, lalu skrip
   dijalankan, dan `DOCKER-USER` kini memuat DROP untuk 8080. Situs, admin dan API tetap 200. Status: ditutup.
2. **Login sandi SSH masih aktif.** `50-cloud-init.conf` (`PasswordAuthentication yes`) terbaca lebih dulu daripada
   `60-cloudimg-settings.conf` (`no`). Tidak ada login bersandi yang tercatat dalam 30 hari terakhir. 21 Oktober
   2026: dibuat `/etc/ssh/sshd_config.d/00-kapdh-hardening.conf` (`PasswordAuthentication no`,
   `KbdInteractiveAuthentication no`). Konfigurasi efektif (`sshd -T`) kini hanya mengizinkan kunci publik; root tetap
   `prohibit-password`. Status: ditutup.
3. **Pemeriksaan port mentah menyesatkan.** Dari mesin build yang lalu lintasnya lewat VPN berbasis TUN, semua port
   (termasuk port acak) tampak terbuka tanpa jawaban layanan. Dari VPS lain, port yang tidak dipakai tampak
   `tcpwrapped`. `go-live.md` 2.4 sekarang mewajibkan `nmap -sV`, port kontrol 9999, dan pemeriksaan dari dalam VPS.
   `infra/scripts/staging-smoke.sh` dulu menilai port dengan `nc -z` saja, sehingga pada jaringan seperti ini
   hasilnya positif palsu. Sekarang port hanya dinilai bila `<ip>:443` terjangkau dan port kontrol
   (`KAPDH_PORT_CONTROL`, bawaan 9999) tidak; selain itu port tidak dinilai dan skrip merujuk prosedur 2.4
   (`KAPDH_REQUIRE_PORTS=true` keluar 3; uji: `infra/scripts/staging-smoke.test.sh`). Status: ditutup.
4. **Coolify "Redirect to non-www" memakai pengalihan sementara** (`302` untuk GET, `307` untuk HEAD/POST). Ini tidak memenuhi target pengalihan
   permanen, sehingga diganti berkas dinamis (`rilis-dan-gerbang-go-live.md` 7.1), dan domain resource dirampingkan.
   Status: ditutup.

## Keluaran blok gerbang 2.4 (15:23 UTC)

```text
== https://kapdh.or.id/
HTTP/1.1 200 OK
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' https://*.kapdh.or.id; connect-src 'self' https://*.kapdh.or.id; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'
Permissions-Policy: accelerometer=(), autoplay=(), browsing-topics=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(), usb=(), xr-spatial-tracking=()
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
== https://www.kapdh.or.id/kebijakan-privasi
HTTP/1.1 308 Permanent Redirect
Location: https://kapdh.or.id/kebijakan-privasi
Strict-Transport-Security: max-age=31536000
== https://admin.kapdh.or.id/
HTTP/1.1 200 OK
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob: https://api.kapdh.or.id; media-src 'self' blob:; connect-src 'self' https://api.kapdh.or.id; manifest-src 'self'; worker-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'
Permissions-Policy: accelerometer=(), autoplay=(), browsing-topics=(), camera=(self), display-capture=(), encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(), usb=(), xr-spatial-tracking=()
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
== https://api.kapdh.or.id/api/v1/health
HTTP/1.1 200 OK
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=31536000
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
HTTP/1.1 101 Switching Protocols
```

`curl -sI` mengirim HEAD, sehingga baris `www` di atas menunjukkan `308`. Dengan GET (peramban), jawabannya `301` (nomor KTA uji disamarkan):

```text
GET 301 https://www.kapdh.or.id/kebijakan-privasi?x=1 -> https://kapdh.or.id/kebijakan-privasi?x=1
GET 301 https://baru.kapdh.or.id/kta/<nomor> -> https://kapdh.or.id/kta/<nomor>
GET 301 https://admin-baru.kapdh.or.id/login -> https://admin.kapdh.or.id/login
GET 301 http://kapdh.or.id/tentang -> https://kapdh.or.id/tentang
```

Header host lama dan record AAAA (DoH Cloudflare), sesudah blok di atas:

```text
== https://baru.kapdh.or.id/kta/<nomor>
HTTP/1.1 308 Permanent Redirect
Location: https://kapdh.or.id/kta/<nomor>
Strict-Transport-Security: max-age=31536000
== https://admin-baru.kapdh.or.id/login
HTTP/1.1 308 Permanent Redirect
Location: https://admin.kapdh.or.id/login
Strict-Transport-Security: max-age=31536000
kapdh.or.id, www, admin, api, baru, admin-baru: tidak ada AAAA
```
