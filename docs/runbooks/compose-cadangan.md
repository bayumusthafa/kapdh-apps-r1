# Runbook: Compose cadangan (panel Coolify tidak tersedia)

Rujukan: PRD 5.5 ("Panel Coolify down tidak boleh menghilangkan runbook Compose cadangan"), 5.3, 7.1, 8.4; D7, D9,
D12; N-07. Artefak: `kapdh-platform/infra/compose.production.yml`, `compose.staging.yml`, `compose.proxy.yml`,
`traefik/`, `.env.*.example`. Rilis normal: `docs/runbooks/rilis-dan-gerbang-go-live.md`.

Pelaksana: pengelola infra (D9: pemilik produk dan satu cadangan dengan akses root/SSH). Catat waktu mulai/selesai,
tag image, dan hasil pemeriksaan di log insiden.

## 0. Tentukan skenario

| Skenario | Gejala | Tindakan |
| -------- | ------ | -------- |
| A. Panel mati, kontainer aplikasi masih berjalan | situs/API normal, panel tidak dapat dibuka | Tidak memindahkan apa pun. Pulihkan panel (`docker ps` untuk kontainer coolify, log, restart). Kontainer aplikasi dapat di-restart dengan `docker restart <nama>`. Lanjut ke B hanya bila perlu deploy/restart yang tidak bisa ditunggu. |
| B. Panel mati dan harus deploy atau menjalankan ulang stack | perbaikan mendesak, kontainer aplikasi mati | Jalankan stack Compose cadangan memakai data yang SAMA (bagian 2-4). |
| C. VPS hilang/rusak | semua layanan berhenti | VPS baru → restore backup DB + berkas + deletion ledger (runbook backup/restore) → bagian 1-5 dengan volume/direktori hasil restore. |

## 1. Siapkan host (sekali; skenario B/C)

```bash
sudo mkdir -p /opt/kapdh /etc/kapdh
# Salinan repo pada tag yang sedang berjalan (atau salin folder kapdh-platform/infra saja).
sudo git clone --branch vX.Y.Z <url-repo> /opt/kapdh/repo
cd /opt/kapdh/repo/kapdh-platform
sudo cp infra/.env.production.example /etc/kapdh/production.env
sudo cp infra/traefik/proxy.env.example /etc/kapdh/proxy.env
sudo chmod 600 /etc/kapdh/*.env
sudo install -d -o 1000 -g 1000 -m 750 /srv/kapdh/production/files   # sudah ada bila sebelumnya memakai Coolify
docker network create kapdh-edge
```

Isi `/etc/kapdh/production.env` dari pengelola secret (D9). Nilai **wajib sama** dengan yang dipakai resource Coolify:
`POSTGRES_PASSWORD`, `KAPDH_*_DB_PASSWORD`, `REDIS_PASSWORD`, seluruh secret API (`JWT_ACCESS_SECRET`,
`OTP_HMAC_SECRET`, `TOTP_ENC_KEY`, `QR_SIGNING_KEYS`, `FILE_URL_SECRET`), FCM, SMTP. `TOTP_ENC_KEY` atau
`QR_SIGNING_KEYS` yang berbeda membuat TOTP admin dan QR KTA tidak dapat diverifikasi. `KAPDH_IMAGE_TAG` = tag yang
terakhir lulus gerbang.

## 2. Pakai ulang data yang ada (skenario B)

PostgreSQL TIDAK boleh berjalan dua kali di atas direktori data yang sama. Urutan:

```bash
docker ps --format '{{.Names}}\t{{.Image}}'                       # cari kontainer postgres/redis/api/worker Coolify
docker inspect -f '{{range .Mounts}}{{.Name}} {{.Destination}}{{"\n"}}{{end}}' <kontainer-postgres-coolify>
docker stop <kontainer api> <kontainer worker> <kontainer web> <kontainer admin>   # aplikasi dulu
docker stop <kontainer postgres> <kontainer redis>                                 # lalu data
```

Isi `KAPDH_PGDATA_VOLUME` dan `KAPDH_REDISDATA_VOLUME` di `/etc/kapdh/production.env` dengan nama volume dari
`docker inspect` di atas. Berkas memakai direktori host `/srv/kapdh/production/files` yang sama dengan resource Coolify.
Superuser di volume lama harus `postgres` dengan `POSTGRES_PASSWORD` yang sama; bila berbeda, sesuaikan
`ADMIN_DATABASE_URL` lewat `POSTGRES_PASSWORD`.

## 3. Job rilis

```bash
cd /opt/kapdh/repo/kapdh-platform
docker compose --env-file /etc/kapdh/production.env -f infra/compose.production.yml pull
docker compose --env-file /etc/kapdh/production.env -f infra/compose.production.yml --profile release run --rm release
```

Production memakai mode gerbang `enforce` (bawaan): bila gerbang menolak, jangan lanjut ke `up`; hal ini berarti data
production tidak lagi memenuhi syarat go-live (lihat tabel penolakan di runbook rilis). Job idempoten bila skema
sudah mutakhir.

## 4. Jalankan stack dan proxy

```bash
docker compose --env-file /etc/kapdh/production.env -f infra/compose.production.yml up -d
docker compose --env-file /etc/kapdh/production.env -f infra/compose.production.yml ps    # semua healthy
# Proxy Coolify (biasanya kontainer coolify-proxy) dan Traefik cadangan sama-sama butuh 80/443:
docker stop coolify-proxy
docker compose --env-file /etc/kapdh/proxy.env -f infra/compose.proxy.yml up -d
```

Traefik cadangan menerbitkan sertifikat Let's Encrypt baru (TLS-ALPN-01, port 443) ke volume `kapdh-edge-letsencrypt`
dan merutekan `kapdh.or.id`/`www`, `admin.`, `api.` ke `kapdh-production-{web,admin,api}-1`. Staging hanya ikut
dirutekan bila `KAPDH_STAGING_DOMAIN_*` diisi dan stack staging dijalankan:

```bash
sudo install -d -o 1000 -g 1000 -m 750 /srv/kapdh/staging/files
docker compose --env-file /etc/kapdh/staging.env -f infra/compose.production.yml -f infra/compose.staging.yml \
  --profile release run --rm release
docker compose --env-file /etc/kapdh/staging.env -f infra/compose.production.yml -f infra/compose.staging.yml up -d
```

Staging memiliki project `kapdh-staging`, `NODE_ENV=staging`, volume `kapdh-staging-*` dan direktori
`/srv/kapdh/staging/files` yang dipatok overlay, sehingga berkas env yang tertukar tidak memasang data production.

## 5. Verifikasi

```bash
docker exec kapdh-production-worker-1 wget -qO- http://127.0.0.1:3001/healthz
docker run --rm --network kapdh-edge \
  curlimages/curl:8.21.0@sha256:7c12af72ceb38b7432ab85e1a265cff6ae58e06f95539d539b654f2cfa64bb13 \
  -fsS http://kapdh-production-api-1:3000/api/v1/health/ready
# Dari luar VPS:
KAPDH_WEB=kapdh.or.id KAPDH_ADMIN=admin.kapdh.or.id KAPDH_API=api.kapdh.or.id KAPDH_VPS_HOST=<ip> \
  sh infra/scripts/staging-smoke.sh
```

Periksa juga login admin + TOTP, pembayaran menunggu, dan kartu/verifikasi KTA (PRD 8.3 langkah 3 dalam skala kecil).
Outbox yang tertunda selama gangguan dikirim ulang otomatis oleh worker (PRD 5.1); pantau umur outbox di `/healthz`.

## 6. Perintah operasional

| Keperluan | Perintah (dari `kapdh-platform/`, tambahkan `--env-file /etc/kapdh/production.env -f infra/compose.production.yml`) |
| --------- | ------ |
| Log satu layanan | `docker compose ... logs -f --tail 200 api` |
| Restart | `docker compose ... restart worker` |
| Bootstrap Super Admin (PRD 8.2 langkah 3) | `docker compose ... exec api node dist/cli/bootstrap-admin.js --email <email> --name "<nama>"` |
| Gerbang go-live saja | `docker compose ... --profile release run --rm --entrypoint sh release -c 'DATABASE_URL="$MIGRATOR_DATABASE_URL" node dist/cli/golive-check.js'` |
| Seed referensi saja (idempoten) | `docker compose ... --profile release run --rm --entrypoint sh release -c 'DATABASE_URL="$MIGRATOR_DATABASE_URL" node node_modules/@kapdh/database/dist/bin/seed-reference.js'` |
| Ganti tag image | ubah `KAPDH_IMAGE_TAG`, lalu `pull`, job rilis, `up -d` |
| Hentikan tanpa menghapus data | `docker compose ... down` (JANGAN `down -v`: menghapus volume database) |

## 7. Kembali ke Coolify

1. Pulihkan panel Coolify. Hentikan Traefik cadangan (`docker compose -f infra/compose.proxy.yml down`) lalu jalankan
   kembali `coolify-proxy`.
2. Hentikan stack Compose (`docker compose ... down`, tanpa `-v`).
3. Resource Coolify harus memakai data yang sama: volume PostgreSQL/Redis yang dipakai Compose (bila skenario C,
   arahkan resource ke volume hasil restore) dan direktori `/srv/kapdh/production/files`. Deploy tag yang sama.
4. Verifikasi seperti bagian 5. Catat penutupan insiden.
