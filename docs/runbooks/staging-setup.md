# Runbook: Penyiapan staging pertama (VPS + Coolify + Tailscale + secrets GitHub)

Rujukan: PRD 5.3, 5.4, 5.5, 8.2, 9.3; D7, D9, D10, D12; ADR-024. Detail dan alasan ada di runbook induk:
`docs/runbooks/ci-cd.md` bagian 4-6 dan 9, `docs/runbooks/rilis-dan-gerbang-go-live.md` bagian 2,
`docs/runbooks/production-init.md` langkah 1-5 dan 7. Workflow: `.github/workflows/deploy-staging.yml` yang memanggil
`.github/workflows/_deploy.yml`.

> Tujuan: membawa VPS staging yang Coolify-nya **sudah** terpasang sampai run "Deploy staging <sha>" pertama hijau,
> lalu pemeriksaan sesudah deploy. Keadaan awal per 15 Oktober 2026: run terakhir (38654879656, commit
> `ebbd0c5e8654ebafdaca696e03f80dcbd0ad5d44`) gagal hanya di langkah pemeriksaan secrets. Dokumen ini tidak memuat
> secret apa pun; setiap `<...>` diisi saat eksekusi. Tidak ada tanda tangan yang dianggap sudah diberikan (PRD 9.3).

## Cara memakai

- Kerjakan tahap 1-8 berurutan. Setiap tahap ditutup blok **Periksa**; jangan lanjut sebelum hasilnya sesuai.
- Tempat menjalankan perintah:
  - **[VPS]** shell admin (sudo) di VPS staging, lewat konsol penyedia atau SSH admin lewat Tailscale (tahap 2);
    perintah `docker` juga lewat `sudo`. Jangan menambahkan admin ke grup `docker` (setara root, D9);
  - **[PC]** Git Bash di PC pengelola, dari akar clone repo (checkout `main`);
  - **[panel]** panel Coolify, admin console Tailscale, atau halaman GitHub.
- Secret (sandi, token, kunci privat, URL bersandi) hanya diketik/ditempel di prompt tersembunyi, di editor, atau
  dibaca dari berkas; tidak pernah sebagai argumen perintah, di URL yang tercetak ke log, di riwayat shell, chat, atau
  tiket (PRD 5.3). Simpan setiap nilai di password manager (D9) saat dibuat. Pengecualian: kunci privat SSH CI
  (`DEPLOY_SSH_PRIVATE_KEY`) tidak disimpan di password manager; sesudah tahap 8 satu-satunya salinannya adalah secret
  GitHub (rotasi = kunci baru). Simpan hanya sidik jarinya (`ssh-keygen -lf ~/.ssh/kapdh-ci-staging.pub`).
- Label menu Coolify dan Tailscale dapat berbeda per versi (verifikasi saat penyiapan); yang mengikat adalah nilai di
  dokumen ini dan perilaku kode yang dirujuk.

Nilai tetap repo ini:

| Butir                                         | Nilai                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Repo GitHub                                   | `bayumusthafa/kapdh-apps-r1` (privat), environment `staging`                                                        |
| Image                                         | `ghcr.io/bayumusthafa/kapdh-{api,release,worker,web,admin}` (paket GHCR privat)                                     |
| `<commit>` (HEAD `main` saat dokumen ditulis) | `ebbd0c5e8654ebafdaca696e03f80dcbd0ad5d44`; image `sha-<commit>` sudah ada di GHCR                                  |
| User CI di VPS                                | `kapdh-ci-staging`, forced command `/usr/local/bin/kapdh-ci-migrate staging`                                        |
| Domain                                        | web `https://staging.kapdh.or.id`, admin `https://staging-admin.kapdh.or.id`, API `https://staging-api.kapdh.or.id` |
| Jalur SSH CI                                  | runner GitHub `ubuntu-24.04` + Tailscale (`tag:ci`) ke IP tailnet VPS; port 22 tidak dibuka ke internet             |

## 0. Keadaan awal dan pemblokir yang diketahui

| Butir                                                                        | Status         | Keterangan                                                         |
| ---------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------ |
| GitHub environment `staging`, deployment branch hanya `main`, tanpa reviewer | **SUDAH**      | `ci-cd.md` 4.1                                                     |
| Variables environment `API_BASE_URL`, `WEB_URL`, `ADMIN_URL`                 | **SUDAH**      | nilai di tahap 7.3                                                 |
| Variable repo `DEPLOY_RUNS_ON`                                               | kosong (benar) | jalur Tailscale memakai runner bawaan `ubuntu-24.04`; jangan diisi |
| Image commit `ebbd0c5…` di GHCR                                              | **SUDAH**      | tujuh job image run 38654879656 sukses                             |
| Secrets environment `staging` (8)                                            | BELUM          | tahap 7                                                            |
| Tailscale: policy tailnet, VPS bertag, OAuth client CI                       | BELUM          | tahap 2                                                            |
| PostgreSQL/Redis staging, role dan sandi database                            | BELUM          | tahap 3-4                                                          |
| User CI, forced command, `/etc/kapdh/ci-migrate/staging.env`, login GHCR     | BELUM          | tahap 5                                                            |
| Resource aplikasi Coolify dan token API                                      | BELUM          | tahap 6                                                            |
| Kanal `:staging` di GHCR                                                     | belum ada      | dibuat CI pertama kali saat run lolos langkah migrasi              |

Pemblokir yang **pasti** menggagalkan run pertama bila dilewati:

1. **Sandi role database.** Job migrasi CI (`kapdh-platform/infra/ci/remote-migrate.sh`) menjalankan `roles.sql`, yang
   membuat `kapdh_migrator`, `kapdh_app` dan `kapdh_worker` sebagai role LOGIN **tanpa sandi**, lalu langsung login
   sebagai `kapdh_migrator`. Job itu tidak pernah menjalankan `role-passwords.sql` (hanya `release-job.sh` jalur
   manual yang melakukannya). Tanpa tahap 4 run berhenti di `migrasi gagal; image baru JANGAN dideploy`; uji asap
   readiness juga butuh login `kapdh_app`.
2. **Metode HTTP deploy Coolify (sudah diperbaiki di kode).** Sejak Coolify v4.2.0 `GET /api/v1/deploy` dijawab `405`
   `{"message":"This endpoint has changed to a POST request."}`; v4.0.x-v4.1.x menerima GET dan POST.
   `coolify-deploy.mjs` kini memicu deploy dengan `POST` (diuji di `infra/ci/test/coolify-deploy.test.mjs`). Run
   dari commit sebelum perbaikan itu (termasuk run 38654879656, commit `ebbd0c5…`) masih memakai GET: jangan di-re-run;
   jalankan run baru untuk HEAD `main` (tahap 8.1).
3. **`TS_OAUTH_CLIENT_ID` dan `TS_OAUTH_SECRET`** tidak tercantum di pesan galat run terakhir, tetapi diperiksa tepat
   sesudahnya (`Jalur SSH tidak tepercaya`) dan wajib untuk runner milik GitHub.
4. **Kanal `:staging` belum ada.** Resource Coolify yang di-deploy manual dengan tag `staging` sebelum run pertama
   gagal menarik image; uji resource dengan tag `sha-<commit>` dahulu (tahap 6.4).

## Urutan ringkas

| Tahap | Isi                                              | Di mana           | Lulus bila                                                                                                        |
| ----- | ------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1     | Prasyarat VPS dan PC                             | VPS, PC           | `x86_64`, DNS tiga domain dan panel ke VPS, panel lewat HTTPS, alat PC siap                                       |
| 2     | Tailscale dan firewall                           | panel, VPS, PC    | VPS bertag `tag:kapdh-staging`, SSH admin lewat tailnet, dari internet hanya 80/443 terbuka                       |
| 3     | PostgreSQL, Redis, direktori berkas              | panel, VPS        | PostgreSQL 17 database `kapdh` terjangkau dari jaringan Docker                                                    |
| 4     | Role dan sandi database                          | PC, VPS           | `kapdh_migrator`/`kapdh_app`/`kapdh_worker` bersandi dan dapat login                                              |
| 5     | User CI, forced command, konfigurasi, login GHCR | VPS, PC           | uji manual: penolakan silang keluar 1, migrasi pertama `selesai`                                                  |
| 6     | Resource aplikasi dan token API Coolify          | panel, PC         | HTTP → HTTPS 301/308; uji asap commit lulus dengan tag `sha-…`; dry-run URL deploy lulus; versi Coolify diketahui |
| 7     | `known_hosts`, uji SSH dari PC, secrets GitHub   | VPS, PC           | penolakan silang lewat SSH; `gh secret list` memuat 8 nama                                                        |
| 8     | Run "Deploy staging"                             | PC                | run hijau, status `kapdh/staging` = `success`                                                                     |
| 9     | Pemeriksaan sesudah deploy                       | PC, VPS, peramban | `staging-smoke.sh` lulus tanpa `PERINGATAN` port (atau port dibuktikan dengan `go-live.md` 2.4); langkah lanjutan tercatat |

---

## Tahap 1. Prasyarat VPS dan PC

- [ ] **[VPS]** Arsitektur dan sshd (image hanya dibangun `linux/amd64`; VPS ARM gagal di `docker pull`):

  ```bash
  uname -m                                             # x86_64
  sudo docker version --format '{{.Server.Version}}'   # daemon Docker (dipakai Coolify) berjalan
  sudo sshd -T | grep -Ei -e '^(usepam|allowusers|allowgroups|pubkeyauthentication|authenticationmethods) ' \
    -e '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '
  ```

  Catat nilai `usepam` dan baris `allowusers`/`allowgroups` bila ada (dipakai tahap 5.1). Wajib (D9):
  `passwordauthentication no` dan `kbdinteractiveauthentication no` (dengan `usepam yes`, keyboard-interactive tetap
  menerima sandi lewat PAM); `permitrootlogin` bukan `yes` (`prohibit-password`/`without-password` bila Coolify login
  root dengan kunci).

- [ ] **DNS** (D12): record A/AAAA `staging`, `staging-admin`, `staging-api` (`kapdh.or.id`) dan
      `<domain-panel-coolify>` (subdomain panel) ke IP publik VPS, tanpa proxy CDN (`TRUST_PROXY_HOPS=1`
      mengasumsikan tepat satu proxy, yaitu Traefik).
- [ ] **[panel]** Panel Coolify di subdomain HTTPS sendiri, bukan `http://<ip>:8000`: Settings → domain instance
      `https://<domain-panel-coolify>`, lalu buka panel lewat alamat itu; 2FA aktif untuk setiap akun panel. Catat
      `<domain-panel-coolify>` dan **nomor versi Coolify** (tahap 6.5). Port 8000/6001/6002 baru ditutup di tahap 2.4
      setelah panel lulus lewat domain.
- [ ] **[PC]** `gh` login sebagai pemilik repo, OpenSSH, Node 24 (skrip `infra/ci` tanpa dependensi npm), klien
      Tailscale Windows.

**Periksa [PC]:**

```bash
gh auth status
gh api repos/bayumusthafa/kapdh-apps-r1 --jq .permissions.admin   # true
nslookup staging.kapdh.or.id; nslookup staging-admin.kapdh.or.id; nslookup staging-api.kapdh.or.id   # IP VPS
nslookup <domain-panel-coolify>                                    # IP VPS
curl -sI https://<domain-panel-coolify>/ | head -1                 # 200 atau 302 (kosong = DNS/sertifikat salah)
node --version                                                     # v24.x
```

## Tahap 2. Tailscale dan firewall

Jalur `_deploy.yml`: runner GitHub bergabung ke tailnet sebagai node sementara bertag `tag:ci` (OAuth client, tag
dipatok di workflow), lalu `ssh` ke `DEPLOY_SSH_HOST` port `DEPLOY_SSH_PORT` (bawaan 22). Port 22 tidak dibuka ke
internet maupun ke rentang IP GitHub Actions (`ci-cd.md` 4.4).

### 2.1 Policy tailnet [panel]

Admin console Tailscale → Access controls. Usulan (`tag:kapdh-staging` adalah nama usulan; `tag:ci` dipatok):

```json
{
  "tagOwners": {
    "tag:ci": ["autogroup:admin"],
    "tag:kapdh-staging": ["autogroup:admin"]
  },
  "grants": [
    { "src": ["tag:ci"], "dst": ["tag:kapdh-staging"], "ip": ["tcp:22"] },
    {
      "src": ["autogroup:admin"],
      "dst": ["tag:kapdh-staging"],
      "ip": ["tcp:22"]
    }
  ],
  "tests": [
    {
      "src": "tag:ci",
      "proto": "tcp",
      "accept": ["tag:kapdh-staging:22"],
      "deny": [
        "tag:kapdh-staging:80",
        "tag:kapdh-staging:443",
        "tag:kapdh-staging:8000",
        "tag:kapdh-staging:5432",
        "tag:kapdh-staging:6379"
      ]
    }
  ]
}
```

- Hapus aturan izinkan-semua bawaan tailnet baru (`"src": ["*"]`, `"dst": ["*"]`); tanpa itu setiap runner `tag:ci`
  menjangkau semua port semua perangkat. Tambahkan grant lain yang memang dibutuhkan perangkat tailnet yang sudah ada.
- `tag:ci` wajib ada di `tagOwners` sebelum OAuth client dibuat (2.3).
- Runner staging dan production sama-sama memakai `tag:ci` (dipatok `_deploy.yml`); pemisahan lingkungan ada di kunci
  SSH dan forced command per user (tahap 5), bukan di ACL. OAuth client tetap satu per environment (2.3) agar dapat
  dicabut terpisah.

### 2.2 VPS dan PC bergabung ke tailnet

- [ ] **[VPS]** Pasang Tailscale dari paket resmi (`https://tailscale.com/download/linux`), lalu:

  ```bash
  sudo tailscale up --advertise-tags=tag:kapdh-staging --hostname=kapdh-staging
  # buka URL login yang tercetak sebagai admin tailnet; JANGAN memakai --ssh
  sudo tailscale set --ssh=false
  tailscale ip -4      # 100.x.y.z = <ip-tailnet-vps>, nilai DEPLOY_SSH_HOST
  ```

  Tailscale SSH mengambil alih port 22 pada IP tailnet: `authorized_keys` beserta forced command dilewati dan host key
  berbeda dari `known_hosts`. Biarkan sshd biasa yang melayani. Bila VPS sudah ada di tailnet atas nama user, beri tag
  lewat Machines → Edit ACL tags (kunci perangkat bertag tidak kedaluwarsa).

- [ ] **[PC]** Klien Tailscale Windows login sebagai admin tailnet yang sama.

### 2.3 OAuth client CI [panel]

- [ ] Admin console → Settings → Trust credentials (`https://login.tailscale.com/admin/settings/trust-credentials`) →
      credential baru jenis **OAuth**, khusus staging (production kelak memakai client sendiri), scope
      **Auth Keys: Write**, tag **`tag:ci`** → Generate.
- [ ] Salin Client ID dan Secret ke password manager sekarang (secret tidak dapat ditampilkan ulang). Keduanya menjadi
      `TS_OAUTH_CLIENT_ID` dan `TS_OAUTH_SECRET` (tahap 7.3).
- Jangan memakai workload identity federation (client id + audience tanpa secret): `_deploy.yml` hanya mengaktifkan
  Tailscale bila `TS_OAUTH_CLIENT_ID` **dan** `TS_OAUTH_SECRET` terisi, dan job tidak meminta izin `id-token`.

### 2.4 Tutup port 22 dan port panel publik

Pastikan SSH admin lewat tailnet berhasil **sebelum** menutup port 22 publik, dan panel berjalan lewat domain
**sebelum** menutup port panel 8000/6001/6002.

- [ ] **[PC]** `ssh <admin>@<ip-tailnet-vps>` berhasil. Pada koneksi pertama cocokkan sidik jari host dengan keluaran
      `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` dari konsol penyedia.
- [ ] **[panel]** Panel terbuka lewat `https://<domain-panel-coolify>` (tahap 1), dan pembaruan langsung (realtime)
      serta terminal server `localhost` di panel berfungsi (keduanya lewat proxy 80/443, bukan 6001/6002).
- [ ] Pilihan utama: firewall penyedia VPS dengan inbound publik hanya TCP 80 dan 443. Trafik Tailscale (antarmuka
      `tailscale0`) dan jaringan Docker internal tidak terdampak. Port panel 8000/6001/6002 juga tidak dibuka.
- [ ] Bila hanya ada firewall host (mis. ufw): izinkan 22 pada `tailscale0` dan dari subnet jaringan Docker Coolify
      (Coolify mengelola server `localhost` lewat SSH dari kontainernya), lalu hapus izin 22 umum. Jangan mengubah
      `ListenAddress` sshd menjadi IP tailnet saja. Contoh (verifikasi pada VPS ini):

  ```bash
  sudo docker network inspect coolify -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}'   # <subnet-coolify>
  sudo ufw allow in on tailscale0 to any port 22 proto tcp
  sudo ufw allow from <subnet-coolify> to any port 22 proto tcp
  sudo ufw delete allow 22/tcp      # hanya bila aturan umum ini ada
  sudo ufw status verbose           # wajib "Status: active" dan "Default: deny (incoming)"
  ```

  Port yang dipublikasikan Docker (Coolify `8000`, `6001`, `6002`, dan `8080` milik `coolify-proxy`) **melewati** ufw:
  aturan ufw tidak menutupnya.
  Tutup di rantai `DOCKER-USER`, mis. lewat alat `ufw-docker` yang dirujuk dokumentasi firewall Coolify, atau aturan
  berikut (`<iface-publik>` = antarmuka ber-IP publik dari `ip -br addr`, mis. `eth0`):

  ```bash
  for p in 8000 6001 6002 8080; do
    sudo iptables -I DOCKER-USER -i <iface-publik> -p tcp -m conntrack --ctorigdstport "$p" --ctdir ORIGINAL -j DROP
  done
  ```

  Ulangi dengan `ip6tables` bila VPS punya IPv6 publik, dan buat aturan persisten (aturan `DOCKER-USER` manual hilang
  saat reboot). Bila ini tidak dapat dilakukan, firewall penyedia wajib.

**Periksa:**

- [panel] Machines: VPS bertag `tag:kapdh-staging` dengan kedaluwarsa kunci nonaktif; policy (termasuk blok `tests`)
  tersimpan tanpa galat.
- Dari mesin di luar VPS, bukan lewat VPN: `nmap -Pn -sV -p 22,80,443,3000,3001,5432,6001,6002,6379,8000,8080,9999
  <ip-publik-vps>` → hanya 80 dan 443 (dan 22 selama belum ditutup) yang dikenali layanannya; port lain `filtered`
  atau sama dengan port kontrol 9999 (`tcpwrapped`). Cara membaca hasil dan pemeriksaan pelengkap di VPS (`ss`,
  `docker ps`, `iptables -S DOCKER-USER`): `go-live.md` 2.4. Ulangi dengan alamat IPv6 publik bila ada (`nmap -6`).
- [panel] Server `localhost` di Coolify tetap terjangkau (validasi server di menu Servers).
- [PC] `ssh <admin>@<ip-tailnet-vps>` masih berhasil.

## Tahap 3. PostgreSQL, Redis dan direktori berkas staging

Resource staging terpisah penuh dari production: project/environment Coolify, database, role, Redis, direktori berkas
(PRD 5.3). Detail: `rilis-dan-gerbang-go-live.md` bagian 2 butir 2-3.

- [ ] **[panel]** Project/environment Coolify khusus staging, di **team** Coolify yang tidak memuat resource
      production: hak token API Coolify berlaku per team, bukan per project (6.5).
- [ ] **[panel]** Resource PostgreSQL: image `postgres:17.11-alpine3.24`, user `postgres`, sandi acak heksadesimal
      (`openssl rand -hex 32`; bila sandi bawaan Coolify dipakai, karakter khususnya wajib di-percent-encode di URL
      tahap 5.3), database `kapdh`, **tanpa** port publik. PostgreSQL >= 16 wajib (`roles.sql` memakai
      `GRANT ... WITH INHERIT FALSE, SET TRUE`). Tuning staging (opsional untuk run pertama): argumen
      `postgres -c ...` layanan `postgres` di `kapdh-platform/infra/compose.staging.yml`.
- [ ] **[panel]** Resource Redis: image `redis:7.4.11-alpine3.21`, sandi heksadesimal, `appendonly yes`,
      `maxmemory 64mb`, `maxmemory-policy noeviction` (wajib untuk BullMQ), tanpa port publik.
- [ ] **[VPS]** Direktori berkas (dipasang ke API **dan** worker di tahap 6):

  ```bash
  sudo install -d -o 1000 -g 1000 -m 750 /srv/kapdh/staging/files
  ```

- [ ] **[VPS]** Nama kontainer dan jaringan Docker resource PostgreSQL dan Redis:

  ```bash
  sudo docker ps --format '{{.Names}}\t{{.Image}}\t{{.Networks}}'
  ```

  `<kontainer-postgres>` = kontainer resource PostgreSQL; `<jaringan-docker>` = jaringannya (biasanya `coolify`; lain
  bila destination Coolify berbeda); `<host-postgres>` = nama host internal resource itu pada jaringan tersebut (nama
  kontainer, atau host internal yang ditampilkan panel). Catat juga `<host-redis>`.

- [ ] Bila database `kapdh` belum ada (database awal Coolify bernama lain):

  ```bash
  sudo docker exec -i <kontainer-postgres> psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 \
    -c 'create database kapdh'
  ```

**Periksa [VPS]:**

```bash
sudo docker exec <kontainer-postgres> psql -U postgres -d kapdh -X -At -c 'show server_version'   # 17.x
sudo docker run --rm --network <jaringan-docker> \
  postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24 \
  pg_isready -h <host-postgres> -p 5432 -d kapdh     # <host-postgres>:5432 - accepting connections
stat -c '%u:%g %a' /srv/kapdh/staging/files         # 1000:1000 750
```

## Tahap 4. Role dan sandi database (sebelum run CI pertama)

Versi staging dari `production-init.md` langkah 2.1-2.2. Sandi role diatur pengelola infra, bukan CI
(`ci-cd.md` bagian 5, "Inisialisasi pertama").

- [ ] Tiga sandi heksadesimal di password manager: `<sandi-migrator>`, `<sandi-app>`, `<sandi-worker>`
      (`openssl rand -hex 32`; heksadesimal aman di URL tanpa percent-encoding). Berbeda dari production.
- [ ] **[PC]** Salin berkas dari commit yang sama dengan image ke VPS lewat tailnet:

  ```bash
  git rev-parse HEAD     # ebbd0c5e8654ebafdaca696e03f80dcbd0ad5d44
  scp kapdh-platform/infra/db/roles.sql kapdh-platform/infra/ci/remote-migrate.sh <admin>@<ip-tailnet-vps>:/tmp/
  ```

- [ ] **[VPS]** Cocokkan isi (nilai untuk commit `ebbd0c5…`; untuk commit lain bandingkan dengan `sha256sum` di PC):

  ```bash
  sha256sum /tmp/roles.sql /tmp/remote-migrate.sh
  # 0696299e44923ce613a9569e7714ca7f17e959ee8d07217d3cb6732d985bde47  /tmp/roles.sql
  # fb4464bac442207b04789095635e13fbdc6234e3adb9e97c29fb3431dfda5843  /tmp/remote-migrate.sh
  ```

- [ ] **[VPS] 4.1 Role** (superuser resource):

  ```bash
  sudo docker exec -i <kontainer-postgres> psql -U postgres -d kapdh -X -v ON_ERROR_STOP=1 -f - < /tmp/roles.sql
  ```

  Pada database kosong muncul `NOTICE:  Skema app belum ada; jalankan migrasi lalu ulangi berkas ini ...` (normal).

- [ ] **[VPS] 4.2 Sandi** (interaktif; psql meminta setiap sandi dua kali, tidak tercetak dan tidak masuk riwayat):

  ```bash
  sudo docker exec -it <kontainer-postgres> psql -U postgres -d kapdh -X
  \password kapdh_migrator
  \password kapdh_app
  \password kapdh_worker
  \q
  ```

  `kapdh_backup` dan `kapdh_monitor` menyusul saat backup/monitoring dipasang (`production-init.md` 2.2). Bila memakai
  `role-passwords.sql`, jangan mengekspor variabel `KAPDH_*_DB_PASSWORD` kosong: `\getenv` tetap mengisi variabel psql
  sehingga sandi role dikosongkan.

**Periksa [VPS]:**

```bash
sudo docker exec <kontainer-postgres> psql -U postgres -d kapdh -X -At \
  -c "select rolname, rolcanlogin, rolpassword is not null from pg_authid where rolname like 'kapdh%' order by 1"
# kapdh_app|t|t, kapdh_audit_purge|f|f, kapdh_backup|t|f, kapdh_migrator|t|t, kapdh_monitor|t|f, kapdh_worker|t|t
sudo docker run --rm -it --network <jaringan-docker> \
  postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24 \
  psql -h <host-postgres> -U kapdh_migrator -d kapdh -X -At -c 'select current_user'   # sandi → kapdh_migrator
```

Ulangi uji login untuk `kapdh_app` dan `kapdh_worker`. Sandi yang diubah kemudian tidak disinkronkan CI: ubah
`ALTER ROLE`, `/etc/kapdh/ci-migrate/staging.env` dan `DATABASE_URL` di Coolify bersamaan.

## Tahap 5. Job migrasi CI di VPS (forced command)

Ringkasan `ci-cd.md` bagian 5 untuk staging; `kapdh-ci-production` disiapkan nanti untuk production.

### 5.1 User CI [VPS]

```bash
sudo useradd --create-home --shell /bin/sh kapdh-ci-staging
sudo usermod -aG docker kapdh-ci-staging
```

- Shell wajib shell nyata (`/bin/sh`): sshd menjalankan forced command lewat shell login user; dengan
  `/usr/sbin/nologin` SSH berakhir `This account is currently not available.`
- Tanpa sandi (akun terkunci bawaan `useradd`). Bila `sshd -T` di tahap 1 menunjukkan `usepam no`, sshd menolak akun
  bersandi `!`: jalankan `sudo usermod -p '*' kapdh-ci-staging`. Bila ada `AllowUsers`/`AllowGroups`, tambahkan user
  ini.
- Grup `docker` setara root di host; user ini dibatasi forced command dan dicatat sebagai pemegang akses D9.

### 5.2 Forced command [VPS]

```bash
sudo install -o root -g root -m 0755 /tmp/remote-migrate.sh /usr/local/bin/kapdh-ci-migrate
```

### 5.3 Konfigurasi `/etc/kapdh/ci-migrate/staging.env` [VPS]

Lokasi dipatok di skrip (`CONFIG_DIR=/etc/kapdh/ci-migrate`, tidak dapat dialihkan). Berkas ini **di-source sebagai
kode sh** (bukan `--env-file` Docker): setiap nilai diapit kutip tunggal dan tidak boleh memuat kutip tunggal.

```bash
sudo install -d -o root -g root -m 0755 /etc/kapdh/ci-migrate
sudo install -o kapdh-ci-staging -g kapdh-ci-staging -m 0600 /dev/null /etc/kapdh/ci-migrate/staging.env
sudoedit /etc/kapdh/ci-migrate/staging.env       # isi templat di bawah; sandi diketik di editor
sudo chmod 0400 /etc/kapdh/ci-migrate/staging.env
```

```sh
KAPDH_ENVIRONMENT='staging'
KAPDH_DOCKER_NETWORK='<jaringan-docker>'
KAPDH_API_REPOSITORY='ghcr.io/bayumusthafa/kapdh-api'
KAPDH_PSQL_IMAGE='postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'
KAPDH_MIGRATOR_DATABASE_URL='postgres://kapdh_migrator:<sandi-migrator>@<host-postgres>:5432/kapdh'
KAPDH_ADMIN_DATABASE_URL='postgres://postgres:<sandi-postgres>@<host-postgres>:5432/kapdh'
```

- `KAPDH_API_REPOSITORY` persis huruf kecil, tanpa tag dan tanpa garis miring akhir: CI mengirim
  `migrate staging ghcr.io/bayumusthafa/kapdh-api@sha256:<64 hex>` dan skrip menolak repositori lain.
- `KAPDH_DOCKER_NETWORK` tidak punya nilai bawaan di skrip CI (berbeda dengan `run-release.sh` yang bawaan `coolify`).
- `KAPDH_ADMIN_DATABASE_URL` memakai superuser resource (`postgres`): `roles.sql` menjalankan `CREATE ROLE`,
  `GRANT pg_read_all_data`, keanggotaan role, dan `ALTER DEFAULT PRIVILEGES FOR ROLE kapdh_migrator` (yang terakhir
  diam-diam dilewati bila pemanggil bukan anggota); pemilik database biasa tidak cukup.
- Repo tidak menetapkan `sslmode`; koneksi di jaringan Docker tanpa TLS. Tambahkan `?sslmode=require` di keempat URL
  (admin, migrator, `DATABASE_URL` API dan worker) hanya bila resource PostgreSQL mewajibkan TLS.
- Gerbang go-live: biarkan `KAPDH_RELEASE_GATE` tidak diisi (bawaan staging `report`). Nama tanpa awalan
  (`RELEASE_GATE`, `RELEASE_GATE_REASON`, `RELEASE_GATE_APPROVER`) membuat job berhenti.
- Dump pra-migrasi opsional di staging: `KAPDH_BACKUP_DIR='<direktori>'` hanya bila direktori sudah ada, milik
  `kapdh-ci-staging`, mode `0700` (dump berisi data pribadi). Bila server PostgreSQL lebih baru dari 17, `pg_dump`
  image psql 17.11 gagal.
- Jangan tertukar dengan `/etc/kapdh/staging/release.env` jalur manual (`run-release.sh`: milik root, nama
  `ADMIN_DATABASE_URL`/`MIGRATOR_DATABASE_URL`/`RELEASE_GATE*`, dibaca sebagai `--env-file`).

### 5.4 Kunci SSH CI

- [ ] **[PC]** Kunci khusus staging, **tanpa passphrase** (CI memakai `BatchMode=yes` tanpa agent):

  ```bash
  ssh-keygen -t ed25519 -N '' -C github-actions-kapdh-staging -f ~/.ssh/kapdh-ci-staging
  ssh-keygen -y -f ~/.ssh/kapdh-ci-staging >/dev/null && echo tanpa-passphrase
  grep -c $'\r' ~/.ssh/kapdh-ci-staging      # 0 (tanpa CRLF)
  cat ~/.ssh/kapdh-ci-staging.pub            # kunci publik (bukan secret)
  ```

- [ ] **[VPS]** `authorized_keys` dengan forced command terikat staging (ganti `AAAA...` dengan kunci publik):

  ```bash
  sudo install -d -o kapdh-ci-staging -g kapdh-ci-staging -m 0700 /home/kapdh-ci-staging/.ssh
  sudo install -o kapdh-ci-staging -g kapdh-ci-staging -m 0600 /dev/null /home/kapdh-ci-staging/.ssh/authorized_keys
  sudo tee /home/kapdh-ci-staging/.ssh/authorized_keys >/dev/null <<'EOF'
  restrict,from="100.64.0.0/10",command="/usr/local/bin/kapdh-ci-migrate staging" ssh-ed25519 AAAA... github-actions-kapdh-staging
  EOF
  ```

  Satu baris: bentuk `ci-cd.md` bagian 5 butir 4 ditambah `from=`. `from=` membatasi kunci ke alamat tailnet
  Tailscale (runner `tag:ci` dan uji 7.2 dari PC lewat tailnet); kunci yang bocor tidak dapat dipakai dari jaringan
  Docker atau internet. Jangan menambahkan `AcceptEnv`/`PermitUserEnvironment`.

### 5.5 Login GHCR [VPS]

Token: personal access token (classic) dengan scope `read:packages` saja, milik akun mesin/bot khusus yang hanya
diberi akses baca ke paket `ghcr.io/bayumusthafa/kapdh-*` (kolaborator baca repo `bayumusthafa/kapdh-apps-r1` bila
paket mewarisi akses repo, atau Package settings → Manage access); jangan memakai token akun pribadi pemilik repo
(scope classic berlaku untuk semua paket yang dapat dibaca akunnya). Bertanggal kedaluwarsa; catat pemilik dan tanggal
(D9). Akses diverifikasi lewat `docker pull` di 5.6.

Coolify menarik image dengan kredensial Docker milik user server yang dipakainya: **[panel]** Servers →
`localhost` → User (bawaan `root`). Login untuk user CI dan untuk user server itu:

```bash
# user CI: kredensial ke /home/kapdh-ci-staging/.docker/config.json; tempel token lalu Enter (tanpa gema)
sudo -u kapdh-ci-staging -H sh -c \
  'stty -echo; read -r t; stty echo; printf %s "$t" | docker login ghcr.io -u <akun-token> --password-stdin'
# user server Coolify (bawaan root): dipakai Coolify menarik image (rilis-dan-gerbang-go-live.md bagian 2 butir 7)
sudo sh -c 'stty -echo; read -r t; stty echo; printf %s "$t" | docker login ghcr.io -u <akun-token> --password-stdin'
# bila user server Coolify bukan root: sudo -u <user-server-coolify> -H sh -c '<perintah login yang sama>'
```

### 5.6 Uji manual forced command [VPS]

```bash
id kapdh-ci-staging                                   # ... (docker)
getent passwd kapdh-ci-staging | cut -d: -f7          # /bin/sh
sudo -u kapdh-ci-staging test -r /etc/kapdh/ci-migrate/staging.env && echo terbaca
sudo stat -c '%U:%G %a %n' /etc/kapdh/ci-migrate /etc/kapdh/ci-migrate/staging.env /usr/local/bin/kapdh-ci-migrate \
  /home/kapdh-ci-staging/.ssh /home/kapdh-ci-staging/.ssh/authorized_keys
# root:root 755, kapdh-ci-staging:kapdh-ci-staging 400, root:root 755, kapdh-ci-staging:... 700, ... 600
sudo -u kapdh-ci-staging -H docker pull ghcr.io/bayumusthafa/kapdh-api:sha-ebbd0c5e8654ebafdaca696e03f80dcbd0ad5d44
sudo -u kapdh-ci-staging -H docker image inspect --format '{{index .RepoDigests 0}}' \
  ghcr.io/bayumusthafa/kapdh-api:sha-ebbd0c5e8654ebafdaca696e03f80dcbd0ad5d44
# ghcr.io/bayumusthafa/kapdh-api@sha256:<64 hex>   = <ref-api>
```

Bila `terbaca` tidak muncul padahal mode berkas benar, direktori induk `/etc/kapdh` tidak dapat dilalui user CI
(`sudo chmod 0755 /etc/kapdh`).

1. Penolakan silang (berhenti sebelum perintah docker apa pun):

   ```bash
   sudo -u kapdh-ci-staging -H /usr/local/bin/kapdh-ci-migrate staging migrate production <ref-api> v1.0.0
   echo "kode $?"
   # <waktu> kapdh-ci-migrate: GAGAL: kunci ini terikat ke lingkungan staging; permintaan untuk production ditolak
   # kode 1
   ```

2. Migrasi pertama. Ini migrasi **sungguhan** (8 migrasi dan seed referensi), lewat jalur argumen yang sama dengan
   forced command; run CI berikutnya idempoten (`Diterapkan: 0`):

   ```bash
   sudo -u kapdh-ci-staging -H /usr/local/bin/kapdh-ci-migrate staging migrate staging <ref-api>
   echo "kode $?"
   ```

   Keluaran yang diharapkan (diringkas):

   ```
   <waktu> kapdh-ci-migrate: lingkungan staging, image ghcr.io/bayumusthafa/kapdh-api@sha256:<12 hex>
   <waktu> kapdh-ci-migrate: mode gerbang go-live report
   <waktu> kapdh-ci-migrate: versi skema: migrasi tercatat 0, journal image 8
   <waktu> kapdh-ci-migrate: 1/6 roles.sql (sebelum migrasi)
   <waktu> kapdh-ci-migrate: 2/6 gerbang pra-migrasi dilewati (mode laporan)
   <waktu> kapdh-ci-migrate: 3/6 migrasi skema sebagai kapdh_migrator (advisory lock)
   [migrate] Migrasi selesai. Diterapkan: 8. Total tercatat: 8.
   <waktu> kapdh-ci-migrate: 4/6 roles.sql (grant objek skema terbaru)
   <waktu> kapdh-ci-migrate: 5/6 seed referensi (idempoten, tanpa fixture)
   [seed:reference] selesai: {"settings_inserted":10,"professions_inserted":24,...}
   <waktu> kapdh-ci-migrate: 6/6 gerbang go-live penuh (mode report)
   HASIL: DITOLAK (6 pemeriksaan gagal). Jangan go-live atau mempromosikan image ke production sebelum diperbaiki.
   <waktu> kapdh-ci-migrate: gerbang menolak, tetapi mode laporan: job dilanjutkan. Belum boleh go-live.
   <waktu> kapdh-ci-migrate: selesai
   kode 0
   ```

**Periksa:** penolakan silang `kode 1`; migrasi pertama `kode 0` dengan baris `selesai`. Jangan menjalankan uji manual
ini bersamaan dengan run deploy staging: migrasi aman berkat advisory lock, tetapi GRANT `roles.sql` yang berjalan
paralel dapat gagal `tuple concurrently updated` (ulangi saja).

## Tahap 6. Resource aplikasi dan token API Coolify

### 6.1 Secret aplikasi

Buat di password manager (nilai staging, berbeda dari production; aturan di `production-init.md` 1.4):

| Nilai                                  | Cara                                                                                                       | Resource    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------- |
| `FILE_URL_SECRET`                      | `openssl rand -hex 32`                                                                                     | API, worker |
| `JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET` | `openssl rand -hex 32` (masing-masing)                                                                     | API         |
| `TOTP_ENC_KEY`                         | `openssl rand -hex 32` (tepat 64 hex); simpan juga salinan cetak: hilang = reset MFA semua admin           | API         |
| `QR_SIGNING_KEYS`                      | `stg-2027a:<openssl rand -hex 32>`                                                                         | API         |
| `SMTP_URL`                             | sub-akun provider D10 khusus staging, `smtps://<user>:<sandi>@<host>:465` (percent-encode karakter khusus) | API, worker |
| Sandi Redis                            | dari resource Redis tahap 3                                                                                | API, worker |

### 6.2 Empat resource aplikasi [panel]

Jenis **"Docker Image"**. Resource jenis "service"/Compose tidak mengembalikan `deployment_uuid` sehingga CI
menilainya GAGAL. `<commit>` = `ebbd0c5e8654ebafdaca696e03f80dcbd0ad5d44`.

| Resource       | Image                               | Tag uji (6.4)          | Tag tetap | Port | Domain                              | Healthcheck (host `127.0.0.1`)       | Mount                                      | Batas          |
| -------------- | ----------------------------------- | ---------------------- | --------- | ---- | ----------------------------------- | ------------------------------------ | ------------------------------------------ | -------------- |
| `kapdh-api`    | `ghcr.io/bayumusthafa/kapdh-api`    | `sha-<commit>`         | `staging` | 3000 | `https://staging-api.kapdh.or.id`   | `GET /api/v1/health/ready` port 3000 | `/srv/kapdh/staging/files` → `/data/files` | 0.75 CPU, 448m |
| `kapdh-worker` | `ghcr.io/bayumusthafa/kapdh-worker` | `sha-<commit>`         | `staging` | 3001 | tanpa domain                        | `GET /healthz` port 3001             | `/srv/kapdh/staging/files` → `/data/files` | 0.5 CPU, 384m  |
| `kapdh-web`    | `ghcr.io/bayumusthafa/kapdh-web`    | `sha-<commit>-staging` | `staging` | 8080 | `https://staging.kapdh.or.id`       | `GET /healthz` port 8080             | -                                          | 0.1 CPU, 48m   |
| `kapdh-admin`  | `ghcr.io/bayumusthafa/kapdh-admin`  | `sha-<commit>-staging` | `staging` | 8080 | `https://staging-admin.kapdh.or.id` | `GET /healthz` port 8080             | -                                          | 0.1 CPU, 48m   |

- Repositori `kapdh-web`/`kapdh-admin` tidak berakhiran `-staging`; akhiran hanya ada di tag `sha-<commit>-staging`.
  Kanal tetapnya `:staging` (bukan `kapdh-web-staging`, bukan `:staging-staging`).
- Ports Mappings (port host) kosong di semua resource; opsi publik PostgreSQL/Redis mati.
- Healthcheck memakai host `127.0.0.1`: nginx web/admin hanya mendengar IPv4 (`listen 8080;`), sehingga `localhost`
  yang menjadi `::1` gagal. Healthcheck API wajib `/api/v1/health/ready`, bukan `/api/v1/health`
  (`production-init.md` 1.3).
- Pre/post-deployment command dan start command kosong: migrasi hanya lewat forced command (PRD 5.5).
- `https://staging.kapdh.or.id/` dan `https://staging-admin.kapdh.or.id/` menjawab 200 langsung, tanpa pengalihan
  (uji asap memakai `redirect: "manual"`; 3xx = gagal). Pengalihan HTTP → HTTPS 301/308 dipasang di proxy (6.2a).
- Hardening, wajib bila versi Coolify mendukung (Custom Docker Options; bila tidak, catat sebagai selisih dari
  production): keempat resource `--cap-drop=ALL --security-opt=no-new-privileges=true`; api/worker juga `--init`;
  web/admin juga `--read-only --tmpfs /tmp:size=16m` (sama dengan `kapdh-platform/infra/compose.production.yml`;
  nginx menulis pid dan berkas sementara hanya ke `/tmp`). Stop grace API >= 30 detik, worker >= 40 detik.

### 6.2a Pengalihan HTTP → HTTPS permanen [panel]

Label Traefik yang dibuat Coolify untuk domain `https://` memakai middleware `redirectscheme` tanpa `permanent`,
sehingga `http://` dijawab `302`, sedangkan `staging-smoke.sh` (9.3) hanya menerima 301/308. Pasang pengalihan
permanen di entrypoint proxy, setara `kapdh-platform/infra/compose.proxy.yml` (jalur Compose cadangan):

- [ ] Servers → `localhost` → Proxy → konfigurasi Traefik: di bawah `command:` tambahkan dua baris berikut. Nama
      entrypoint `http`/`https` harus sama dengan baris `--entrypoints.http.address=:80` dan
      `--entrypoints.https.address=:443` yang sudah ada.

  ```yaml
  - "--entrypoints.http.http.redirections.entrypoint.to=https"
  - "--entrypoints.http.http.redirections.entrypoint.scheme=https"
  ```

- [ ] Klik **Save changes** di bilah mengambang bawah layar dan tunggu penanda 'Changes pending', lalu **Restart
      Proxy** (semua aplikasi dan panel lewat domain terputus sesaat). Restart tidak menyimpan isi editor, dan Coolify
      v4.4.6 memakai salinan di basis datanya, bukan berkas di disk (`rilis-dan-gerbang-go-live.md` bagian 7).
      Pengaturan ini berlaku untuk semua aplikasi di server. `permanent` bawaan `true` untuk pengalihan entrypoint;
      tantangan ACME HTTP tetap dilayani karena router ACME Traefik berprioritas lebih tinggi. Sertifikat ketiga domain
      staging terbit sesudah ini (deploy 6.4) dan dibuktikan uji asap 6.4.
- [ ] **Server yang sama dengan production:** langkah ini sudah terpasang sejak 17 Oktober 2026, bersama baris ketiga
      `--entrypoints.https.http.middlewares=kapdh-hsts@file` (HSTS global, `rilis-dan-gerbang-go-live.md` bagian 7).
      Jangan menambahkannya lagi; cukup jalankan pemeriksaan di bawah. Host staging ikut mendapat
      `strict-transport-security: max-age=31536000` dari proxy; dengan `KAPDH_EXPECT_HSTS=false` uji asap hanya
      mencatatnya sebagai `info`.

**Periksa [PC]:**

```bash
for u in http://staging.kapdh.or.id/ http://staging-admin.kapdh.or.id/ http://staging-api.kapdh.or.id/api/v1/health
do curl -sI "$u" | head -1; done      # 301 atau 308 (bukan 302) untuk ketiganya
curl -sI https://<domain-panel-coolify>/ | head -1                      # panel tetap 200/302
```

### 6.3 Environment variable [panel]

Sumber: `kapdh-platform/infra/.env.staging.example` bagian A, "API saja", "worker saja" dan B. Tulis per resource,
bukan sebagai variabel bersama lingkungan (secret API tidak boleh sampai ke worker, PRD 5.1).

| Variabel                                                                                                                  | API | Worker    | Nilai staging                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- | --- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                                                                | ya  | ya        | `staging`, wajib eksplisit: image berbawaan `production`, dan aturan production mewajibkan `REDIS_URL`, `FCM_PROJECT_ID` dan (worker) `DELETION_LEDGER_S3_BUCKET`                      |
| `DATABASE_URL`                                                                                                            | ya  | ya        | API `postgres://kapdh_app:<sandi-app>@<host-postgres>:5432/kapdh`; worker `postgres://kapdh_worker:<sandi-worker>@<host-postgres>:5432/kapdh`                                          |
| `REDIS_URL`                                                                                                               | ya  | ya        | `redis://:<sandi-redis>@<host-redis>:6379/0`; tanpa ini readiness `redis` = `skipped` dan worker memakai antrean inline (tidak setara production)                                      |
| `SMTP_URL`                                                                                                                | ya  | ya        | wajib agar API/worker mau start di `staging`; email baru terkirim dengan kredensial provider nyata                                                                                     |
| `MAIL_FROM`                                                                                                               | ya  | ya        | `KAPDH Staging <noreply-staging@kapdh.or.id>` (tanpa tanda kutip)                                                                                                                      |
| `PUBLIC_WEB_URL`, `API_PUBLIC_URL`, `ADMIN_ORIGIN`                                                                        | ya  | ya        | `https://staging.kapdh.or.id`, `https://staging-api.kapdh.or.id`, `https://staging-admin.kapdh.or.id`; bawaan kode adalah domain production (CORS, tautan undangan, QR KTA salah arah) |
| `STORAGE_DRIVER`, `STORAGE_LOCAL_ROOT`                                                                                    | ya  | ya        | `local`, `/data/files`                                                                                                                                                                 |
| `FILE_URL_SECRET`                                                                                                         | ya  | ya        | 6.1                                                                                                                                                                                    |
| `LOG_LEVEL`                                                                                                               | ya  | ya        | `debug`                                                                                                                                                                                |
| `PORT`, `TRUST_PROXY_HOPS`, `HSTS_ENABLED`                                                                                | ya  | -         | `3000`, `1`, `false`                                                                                                                                                                   |
| `JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET`, `TOTP_ENC_KEY`, `QR_SIGNING_KEYS`                                                 | ya  | **tidak** | 6.1                                                                                                                                                                                    |
| `JWT_ISSUER`, `BCRYPT_COST`                                                                                               | ya  | -         | `https://staging-api.kapdh.or.id`, `12`                                                                                                                                                |
| `WORKER_CONCURRENCY`, `WORKER_HEALTH_PORT`, `WORKER_HEALTH_HOST`, `OUTBOX_POLL_INTERVAL_MS`, `WORKER_SHUTDOWN_TIMEOUT_MS` | -   | ya        | `2`, `3001`, `0.0.0.0`, `2000`, `25000`                                                                                                                                                |
| `NODE_OPTIONS`                                                                                                            | ya  | ya        | API `--max-old-space-size=320`, worker `--max-old-space-size=256` (`compose.staging.yml`)                                                                                              |
| `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON`, `SENTRY_DSN`, `DELETION_LEDGER_S3_*`                                        |     |           | kosong untuk run pertama; menyusul (proyek Firebase, GlitchTip dan bucket staging sendiri; `DELETION_LEDGER_S3_*` hanya worker)                                                        |

Jangan mengisi `KAPDH_COMMIT` (dibakar di image; menimpanya menggagalkan uji asap commit). Web dan admin tidak membaca
env runtime: URL API dibakar saat build dari `kapdh-platform/infra/ci/images.json`.

### 6.4 Deploy uji dengan tag `sha-<commit>` [panel]

- [ ] Deploy `kapdh-api` dan `kapdh-worker` dahulu, lalu `kapdh-web` dan `kapdh-admin`. Tarikan image yang gagal
      `unauthorized` = login GHCR user server Coolify (bawaan root, 5.5) belum benar.

**Periksa [PC]** (pemeriksaan yang sama dengan langkah uji asap CI):

```bash
node kapdh-platform/infra/ci/smoke.mjs --timeout 300 --expect-commit ebbd0c5e8654ebafdaca696e03f80dcbd0ad5d44 \
  "api=https://staging-api.kapdh.or.id/api/v1/health/ready" "web=https://staging.kapdh.or.id/" \
  "admin=https://staging-admin.kapdh.or.id/"
# OK    api https://staging-api.kapdh.or.id/api/v1/health/ready (commit ebbd0c5e8654)   (juga web dan admin)
```

**Periksa [VPS]:**

```bash
sudo docker exec <kontainer-worker> wget -qO- http://127.0.0.1:3001/healthz      # "status":"ok"
sudo docker inspect -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' <kontainer-api>
# /srv/kapdh/staging/files -> /data/files   (sama untuk <kontainer-worker>)
sudo docker inspect \
  -f '{{.Name}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.ReadonlyRootfs}}' \
  <kontainer-api> <kontainer-worker> <kontainer-web> <kontainer-admin>
# [ALL] dan no-new-privileges di keempatnya; ReadonlyRootfs true untuk web/admin (hardening 6.2)
```

- [ ] Setelah lulus, ubah tag keempat resource ke `staging` dan simpan **tanpa** deploy: kanal `:staging` baru ada
      setelah run CI memindahkannya (tahap 8).

### 6.5 Versi, token API, dan `COOLIFY_DEPLOY_URL`

- [ ] **[panel]** Aktifkan akses API Coolify (Settings). Runner GitHub tidak punya IP keluar tetap, sehingga daftar IP
      API (Allowed API IPs) harus kosong (= semua sumber); jangan mengisi rentang IP GitHub Actions (rentang Azure
      bersama). Akibatnya token adalah satu-satunya kontrol: izin hanya deploy + read, team tanpa resource production,
      berkedaluwarsa/dirotasi, dan dicatat sebagai risiko yang diterima (D9).
- [ ] **[panel]** Keys & Tokens → API tokens: token baru (mis. `github-actions-kapdh-staging`) dibuat admin/owner
      team, izin **deploy dan read**: centang `deploy` dahulu, lalu `read` (memilih `deploy` mengosongkan pilihan
      lain). `read` dibutuhkan polling `GET /api/v1/deployments/<uuid>`; token deploy saja berakhir
      `timeout (http_403)` setelah 900 detik. Jangan memberi `root`. Token dibuat saat team Coolify yang **hanya
      memuat resource staging** aktif (token milik user dan team yang aktif saat dibuat). Resource production
      (aplikasi, PostgreSQL, Redis) WAJIB berada di instance Coolify lain (VPS production) atau team lain;
      project/environment Coolify bukan batas hak token (`deploy` juga dapat me-restart, menghentikan dan membatalkan
      deployment). Catat pemilik dan tanggal token (D9).
- [ ] **[panel]** UUID keempat resource aplikasi: segmen terakhir URL halaman resource (`.../application/<uuid>`) atau
      dari Webhooks → Deploy Webhook (`...?uuid=<uuid>&force=false`). Bukan UUID project/environment, bukan
      PostgreSQL/Redis (tanpa `deployment_uuid` = GAGAL).
- [ ] Susun `COOLIFY_DEPLOY_URL` (urutan api, worker, web, admin; https lewat subdomain panel, bukan port 8000):
      `https://<domain-panel-coolify>/api/v1/deploy?uuid=<uuid-api>,<uuid-worker>,<uuid-web>,<uuid-admin>&force=false`

**Periksa [PC]:**

```bash
# versi Coolify + token (izin read) + akses API; token tanpa gema, header lewat stdin (tidak di argumen proses)
read -rs t && printf 'Authorization: Bearer %s\n' "$t" | curl -fsS -H @- https://<domain-panel-coolify>/api/v1/version
echo
# resource yang terjangkau token: hanya staging (empat aplikasi, PostgreSQL dan Redis staging), tanpa production
for p in applications databases; do
  printf 'Authorization: Bearer %s\n' "$t" | curl -fsS -H @- "https://<domain-panel-coolify>/api/v1/$p" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>JSON.parse(s).forEach(r=>console.log(r.name)))'
done
unset t
# validasi format URL deploy tanpa jaringan (--dry-run tidak mengirim permintaan; token tiruan cukup)
read -rs COOLIFY_DEPLOY_URL && export COOLIFY_DEPLOY_URL && \
  COOLIFY_API_TOKEN=x node kapdh-platform/infra/ci/coolify-deploy.mjs --dry-run; unset COOLIFY_DEPLOY_URL
# Deploy Coolify di <domain-panel-coolify>: 4 resource.
# --dry-run: URL dan token valid; tidak ada permintaan yang dikirim.
```

Versi Coolify (pemblokir 2 di bagian 0): `triggerDeploy` memakai `POST`, yang diterima semua versi v4; catat versi
panel saja untuk paket bukti. Jangan menguji URL deploy dengan permintaan manual (`curl -X POST ...`): permintaan itu
langsung memicu deploy.

## Tahap 7. `known_hosts`, uji SSH, dan secrets GitHub

### 7.1 `DEPLOY_SSH_KNOWN_HOSTS`

- [ ] **[VPS]** Sidik jari host key: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` (catat `SHA256:...`).
- [ ] **[PC]**

  ```bash
  ssh-keyscan -t ed25519 <ip-tailnet-vps> > ~/.ssh/kapdh-staging.known_hosts
  ssh-keygen -lf ~/.ssh/kapdh-staging.known_hosts                       # SHA256:... sama dengan di VPS
  ssh-keygen -F <ip-tailnet-vps> -f ~/.ssh/kapdh-staging.known_hosts    # baris ditemukan untuk host persis ini
  ```

  Kolom host wajib sama persis dengan nilai `DEPLOY_SSH_HOST` (CI memakai `StrictHostKeyChecking=yes`): IP tailnet,
  atau nama MagicDNS bila nama itu yang dipakai keduanya. Port selain 22: `ssh-keyscan -p <port>` menghasilkan
  `[host]:port`, dan variable environment `DEPLOY_SSH_PORT` diisi.

### 7.2 Uji SSH ujung ke ujung dari PC [PC]

Opsi yang sama dengan langkah migrasi `_deploy.yml`. Membuktikan kunci tanpa passphrase, user, forced command dan
`known_hosts`; keluar 1 sebelum perintah docker apa pun (tanpa efek samping). Jalur ACL `tag:ci` baru terbukti di run.

```bash
zero=$(printf '0%.0s' {1..64})
ssh -i ~/.ssh/kapdh-ci-staging -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$HOME/.ssh/kapdh-staging.known_hosts" -o ConnectTimeout=20 \
  kapdh-ci-staging@<ip-tailnet-vps> "migrate production ghcr.io/bayumusthafa/kapdh-api@sha256:$zero v1.0.0"
# <waktu> kapdh-ci-migrate: GAGAL: kunci ini terikat ke lingkungan staging; permintaan untuk production ditolak
```

### 7.3 Secrets dan variables environment `staging` [PC]

Variables (tidak diubah):

| Variable          | Nilai                                                                                                          | Status                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `API_BASE_URL`    | `https://staging-api.kapdh.or.id/api/v1` (wajib sama dengan `images.json` `environments.staging.api_base_url`) | **SUDAH**                    |
| `WEB_URL`         | `https://staging.kapdh.or.id`                                                                                  | **SUDAH**                    |
| `ADMIN_URL`       | `https://staging-admin.kapdh.or.id`                                                                            | **SUDAH**                    |
| `DEPLOY_SSH_PORT` | tidak diisi (bawaan 22)                                                                                        | hanya bila sshd di port lain |

Secrets (Git Bash):

```bash
R=bayumusthafa/kapdh-apps-r1
gh secret set DEPLOY_SSH_PRIVATE_KEY --env staging -R "$R" < ~/.ssh/kapdh-ci-staging
gh secret set DEPLOY_SSH_KNOWN_HOSTS --env staging -R "$R" < ~/.ssh/kapdh-staging.known_hosts
gh secret set DEPLOY_SSH_USER --env staging -R "$R" --body kapdh-ci-staging
for name in DEPLOY_SSH_HOST COOLIFY_DEPLOY_URL COOLIFY_API_TOKEN TS_OAUTH_CLIENT_ID TS_OAUTH_SECRET; do
  printf '%s: ' "$name"; read -rs v; echo
  printf '%s' "$v" | gh secret set "$name" --env staging -R "$R"; unset v
done
```

- `read -s` tidak menggemakan nilai dan membuang spasi di awal/akhir (spasi ekor di token merusak header Bearer, di
  host merusak SSH); `printf` adalah builtin bash sehingga nilai tidak muncul di argumen proses; `gh` membaca stdin
  dan hanya membuang CR/LF di akhir. Secret tidak pernah diberikan lewat `--body` (nama user CI bukan secret).
- Alternatif PowerShell untuk nilai ketik: `gh secret set DEPLOY_SSH_HOST --env staging -R bayumusthafa/kapdh-apps-r1`
  menampilkan prompt tersamar `Paste your secret:`. PowerShell 5.1 tidak mendukung pengalihan `<`; berkas kunci dan
  `known_hosts` diset dari Git Bash.
- `TS_OAUTH_*` WAJIB secret environment (`staging` di sini); jangan dijadikan secret repo (secret repo terbaca setiap
  workflow, termasuk `ci.yml` pada pull request dari branch mana pun). Production memakai OAuth client Tailscale
  **sendiri** (tag tetap `tag:ci` karena dipatok `_deploy.yml`) agar dapat dicabut terpisah.

**Periksa [PC]:**

```bash
gh secret list --env staging -R "$R"     # 8 nama (tabel "Daftar periksa akhir")
gh variable list --env staging -R "$R"   # ADMIN_URL, API_BASE_URL, WEB_URL
gh variable list -R "$R"                 # tanpa DEPLOY_RUNS_ON
```

## Tahap 8. Run "Deploy staging" pertama

### 8.1 Pemicu

Menyimpan secret tidak memicu run apa pun; `workflow_run` hanya terpicu CI yang selesai pada push ke `main`.

| Keadaan                                     | Pemicu                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Tanpa perubahan kode sejak secrets diisi | run baru untuk HEAD `main` (sudah memuat perbaikan `POST` Coolify): `gh workflow run deploy-staging.yml --ref main -R bayumusthafa/kapdh-apps-r1` (`-f sha=<40 hex>` untuk commit `main` lain yang sudah lulus CI pada push dan memuat perbaikan itu). Jangan `gh run rerun 38654879656`: commit `ebbd0c5…` masih memicu Coolify dengan GET |
| B. Ada perubahan kode baru                  | merge ke `main` → CI → "Deploy staging" otomatis untuk commit baru. Re-run run lama tidak memakai perbaikan, karena `_deploy.yml` menjalankan skrip dari commit yang dideploy (`ref: inputs.sha`)                                                                                                                                           |

Dispatch wajib `--ref main` (selain itu `jalankan dari branch main`). Tag `sha-<commit>` sekali tulis: run baru untuk
commit yang sama tidak membangun ulang image, tetapi uji asap image dan pindai grype tetap berjalan.

### 8.2 Pantau [PC]

```bash
gh run list --workflow deploy-staging.yml -R bayumusthafa/kapdh-apps-r1 --limit 3
gh run watch <run-id> -R bayumusthafa/kapdh-apps-r1
gh run view <run-id> -R bayumusthafa/kapdh-apps-r1 --log-failed      # bila gagal; lihat bagian Troubleshooting
```

| Langkah job "Migrasi, rollout dan uji asap (staging)"                   | Log yang diharapkan                                                                                                                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Periksa secrets, variabel dan jalur jaringan environment staging`      | lulus tanpa `::error`                                                                                                                                                          |
| `URL API environment sama dengan URL yang dibakar ke image web/admin`   | lulus                                                                                                                                                                          |
| `Resolusi digest image`                                                 | lima baris `<nama>: <sumber> -> sha256:...` (api, release, worker, web, admin)                                                                                                 |
| `VPN ke host deploy (Tailscale; wajib untuk runner milik GitHub)`       | node `github-...` bergabung bertag `tag:ci`; di admin console node itu berlabel Ephemeral dan hilang setelah run                                                               |
| `Job migrasi tunggal dan gerbang go-live (sebelum image baru dideploy)` | `versi skema: migrasi tercatat 8, journal image 8`, `Diterapkan: 0`, laporan gerbang, `gerbang menolak, tetapi mode laporan: job dilanjutkan. Belum boleh go-live.`, `selesai` |
| `Pindahkan kanal :staging ke digest yang sama`                          | lima baris `<nama> -> ghcr.io/bayumusthafa/kapdh-<nama>:staging (sha256:...)`                                                                                                  |
| `Deploy Coolify (webhook rahasia) dan tunggu selesai`                   | `Deploy Coolify di <domain-panel-coolify>: 4 resource.`, `4 deployment diantrekan; ...`, empat `OK    resource <8 karakter>: finished`                                         |
| `Uji asap HTTP (termasuk commit image yang berjalan)`                   | `OK    api ...`, `OK    web ...`, `OK    admin ...`, masing-masing `(commit <12 hex>)`                                                                                         |

Coolify melewati UUID yang tidak dikenal tanpa galat selama UUID lain ditemukan: jumlah di `deployment diantrekan`
harus 4. Bila kurang, perbaiki `COOLIFY_DEPLOY_URL` (worker yang terlewat tidak tertangkap uji asap).

**Periksa (lulus tahap 8) [PC]:**

```bash
gh run view <run-id> -R bayumusthafa/kapdh-apps-r1 --json conclusion --jq .conclusion      # success
gh api repos/bayumusthafa/kapdh-apps-r1/commits/<sha>/statuses \
  --jq '[.[] | select(.context == "kapdh/staging")][0].state'                              # success
```

Run sukses dari `main` berjudul "Deploy staging <sha>" adalah bukti staging yang dibaca `release.yml`
(`kapdh-platform/infra/ci/staging-evidence.mjs`); status commit hanya informasi. Sesudah hijau: hapus salinan kunci
privat `~/.ssh/kapdh-ci-staging` dari PC (rotasi = kunci baru, `authorized_keys` dan secret baru) dan berkas `/tmp`
tahap 4.

## Tahap 9. Pemeriksaan sesudah deploy

### 9.1 Cakupan run hijau

Sudah terbukti: migrasi, `roles.sql`, seed referensi dan laporan gerbang; kanal `:staging` menunjuk digest commit;
keempat deployment Coolify `finished`; readiness API `status` = `ok`; web dan admin mengirim CSP dan
`X-Content-Type-Options: nosniff`; commit yang dilaporkan `/api/v1/health` dan `/version.json` sama dengan commit run.

Belum terbukti (uji asap CI hanya HTTP): TLS, pengalihan HTTP, WSS dan port tertutup; worker selain status deployment
Coolify; Super Admin, data referensi, email dan push; smoke test per peran; backup/restore; monitoring.

### 9.2 Laporan gerbang (mode report)

Pada database baru laporan diharapkan `HASIL: DITOLAK (6 pemeriksaan gagal)`: `payment_methods`, `super_admins`,
`payment_deciders`, `legal_pages`, `masters`, `support_contact` gagal; `schema`, `settings`, `fees`, `dev_fixtures`
lulus. Job tetap hijau. Kode 3 (galat teknis) tetap menghentikan job, juga di staging. Perbaikan per pemeriksaan:
`rilis-dan-gerbang-go-live.md` bagian 4, tabel penyebab penolakan.

### 9.3 Uji asap lingkungan dari luar VPS [PC]

```bash
KAPDH_WEB=staging.kapdh.or.id KAPDH_ADMIN=staging-admin.kapdh.or.id KAPDH_API=staging-api.kapdh.or.id \
  KAPDH_VPS_HOST=<ip-publik-vps> sh kapdh-platform/infra/scripts/staging-smoke.sh
# ... Uji asap lingkungan lulus. Lanjutkan dengan SSL Labs untuk grade TLS.
```

- `KAPDH_VPS_HOST` = IP **publik** (dengan IP tailnet pemeriksaan port tidak bermakna).
- Tanpa `nc` (Git Bash bawaan) pemeriksaan port dilewati dengan `PERINGATAN`; jalankan dari mesin yang punya `nc`,
  atau pakai prosedur port `go-live.md` 2.4 (`nmap -Pn -sV` dengan port kontrol 9999). Skrip tidak memeriksa port 22.
- Port hanya dinilai bila dua pembanding terpenuhi: `KAPDH_VPS_HOST:443` terjangkau (host, `nc -z` dan jaringan
  pemeriksa berfungsi) dan port kontrol `KAPDH_PORT_CONTROL` (bawaan 9999, harus tidak dipakai di VPS) tidak
  terjangkau (jaringan atau VPN di jalur tidak menerima semua port). Bila salah satunya gagal, skrip mencetak
  `PERINGATAN`, tidak menilai port, dan merujuk prosedur `go-live.md` 2.4. `KAPDH_REQUIRE_PORTS=true` membuat port yang
  belum terbukti keluar 3; pakai untuk run bukti.
- HSTS hanya baris `info` (`HSTS_ENABLED=false`, belum diwajibkan; `rilis-dan-gerbang-go-live.md` bagian 7).
- SSL Labs untuk ketiga domain.

### 9.4 API, worker dan berkas

```bash
curl -s https://staging-api.kapdh.or.id/api/v1/health          # "status":"ok", "commit":"<sha>"
curl -s https://staging-api.kapdh.or.id/api/v1/health/ready    # checks database/redis/storage/deletion_ledger "ok"
curl -s https://staging-api.kapdh.or.id/api/v1/public/config   # support.email bantuan@kapdh.or.id, whatsapp null
curl -s -X POST https://staging-api.kapdh.or.id/api/v1/public/kta/verify -H 'content-type: application/json' \
  -d '{"member_number":"20.01.01.1","token":"xxxxxxxxxxxxxxxxxxxx"}'   # "result":"invalid_token"
REALTIME_URL=https://staging-api.kapdh.or.id node kapdh-platform/infra/monitoring/realtime-probe.mjs   # PASS realtime
```

**[VPS]** `sudo docker exec <kontainer-worker> wget -qO- http://127.0.0.1:3001/healthz` → `"status":"ok"`, antrean
`"driver":"bullmq"` (dengan `REDIS_URL`). Setelah unggahan pertama (mis. sampul berita di web admin), berkasnya ada di
bawah `/srv/kapdh/staging/files`; readiness saja tidak membuktikan mount.

### 9.5 Langkah lanjutan (urutan)

1. **Email** (`production-init.md` 5.1-5.2): kredensial provider D10 staging di `SMTP_URL`; SPF/DKIM untuk pengirim
   `noreply-staging@kapdh.or.id`. Wajib sebelum undangan admin (3.4-3.6).
2. **Super Admin pertama** (`production-init.md` langkah 3) **[VPS]**:

   ```bash
   sudo docker exec -it <kontainer-api> node dist/cli/bootstrap-admin.js \
     --email <email-super-admin-1> --name "Bayu Musthafa"
   ```

   Tautan harus berawalan `https://staging-admin.kapdh.or.id/invite#t=`; bila `https://admin.kapdh.or.id`,
   `ADMIN_ORIGIN` belum diisi. Tautan tidak disimpan. Lanjut 3.2-3.7 di `https://staging-admin.kapdh.or.id`. Backup
   "database kosong" PRD 8.2 harus sebelum bootstrap; buktinya diambil pada gladi langkah 7 yang membuat ulang
   database.

3. **Data referensi** (`production-init.md` langkah 4) lewat web admin staging.
4. **Backup staging** (`backup-restore.md` bagian 3): `KAPDH_ENV=staging`, `RESTIC_HOST=kapdh-staging`,
   `FILES_ROOT=/srv/kapdh/staging/files`, repo restic dan bucket staging sendiri.
5. **Monitoring** (`monitoring.md` bagian 2.1) dengan nilai staging (`REALTIME_URL`, `PG_EXEC`, `FILES_ROOT`) dan
   kanal alert `[STAGING]`.
6. **Aplikasi Flutter staging** (`kapdh-mobile/docs/BUILD.md`, `--dart-define-from-file=config/staging.json`): build
   `1.1.0+2` (pubspec saat ini) lolos `min_app_version` seed `1.0.0`; build di bawah `min_app_version` staging ditolak
   426 `UPGRADE_REQUIRED` pada setiap mutasi sampai versi build dinaikkan atau `min_app_version` staging diturunkan
   (catat di laporan; `production-init.md` langkah 7).
7. **Gladi** (`production-init.md` langkah 7) dengan gerbang `enforce`: tulis `KAPDH_RELEASE_GATE='enforce'` di
   `/etc/kapdh/ci-migrate/staging.env` (`sudo chmod 0600`, `sudoedit`, `sudo chmod 0400`) hanya selama gladi, lalu
   hapus; selama aktif setiap deploy staging gagal bila konfigurasi pengurus belum lengkap.

### 9.6 Merah atau tidak ada karena desain (bukan kegagalan)

- Laporan gerbang `DITOLAK` pada setiap deploy sampai langkah 3-4 selesai; gerbang pra-migrasi dilewati (mode
  laporan).
- Tanpa HSTS dari API (`HSTS_ENABLED=false`); bila staging berada di server Coolify yang sama dengan production, proxy
  tetap mengirim `max-age=31536000` (tanpa `includeSubDomains`) dan uji asap mencatatnya sebagai `info`. Tanpa host
  `www` di staging.
- Registrasi anggota 409 sampai kebijakan privasi dan ketentuan terbit.
- Push nonaktif (FCM kosong, `PUSH_ENABLED=false` di `config/staging.json`); `store_links` kosong sehingga `/unduh`
  tanpa tautan dan `min_app_version` tidak dapat dinaikkan.
- Tanpa event GlitchTip (`SENTRY_DSN` kosong); tanpa dump pra-migrasi bila `KAPDH_BACKUP_DIR` tidak diisi.

---

## Daftar periksa akhir: secrets GitHub environment `staging`

`R=bayumusthafa/kapdh-apps-r1`; perintah dari Git Bash (tahap 7.3). "prompt" = pola `read -rs` + `printf | gh secret
set` di tahap 7.3, atau prompt `Paste your secret:` di PowerShell.

| Selesai | Secret                   | Asal nilai                                                                                                    | Perintah set                                                                                    |
| ------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [ ]     | `DEPLOY_SSH_HOST`        | `tailscale ip -4` di VPS (tahap 2.2), `100.x.y.z`; bukan IP/nama publik                                       | prompt: `gh secret set DEPLOY_SSH_HOST --env staging -R "$R"`                                   |
| [ ]     | `DEPLOY_SSH_USER`        | `kapdh-ci-staging` (tahap 5.1; bukan secret)                                                                  | `gh secret set DEPLOY_SSH_USER --env staging -R "$R" --body kapdh-ci-staging`                   |
| [ ]     | `DEPLOY_SSH_PRIVATE_KEY` | `~/.ssh/kapdh-ci-staging`, ed25519 tanpa passphrase (tahap 5.4)                                               | `gh secret set DEPLOY_SSH_PRIVATE_KEY --env staging -R "$R" < ~/.ssh/kapdh-ci-staging`          |
| [ ]     | `DEPLOY_SSH_KNOWN_HOSTS` | `~/.ssh/kapdh-staging.known_hosts`, sidik jari dicocokkan (tahap 7.1)                                         | `gh secret set DEPLOY_SSH_KNOWN_HOSTS --env staging -R "$R" < ~/.ssh/kapdh-staging.known_hosts` |
| [ ]     | `COOLIFY_DEPLOY_URL`     | `https://<domain-panel-coolify>/api/v1/deploy?uuid=<api>,<worker>,<web>,<admin>&force=false` (tahap 6.5)      | prompt: `gh secret set COOLIFY_DEPLOY_URL --env staging -R "$R"`                                |
| [ ]     | `COOLIFY_API_TOKEN`      | token API Coolify izin deploy + read (tahap 6.5)                                                              | prompt: `gh secret set COOLIFY_API_TOKEN --env staging -R "$R"`                                 |
| [ ]     | `TS_OAUTH_CLIENT_ID`     | OAuth client Tailscale khusus staging, Auth Keys: Write, `tag:ci` (tahap 2.3); secret environment, bukan repo | prompt: `gh secret set TS_OAUTH_CLIENT_ID --env staging -R "$R"`                                |
| [ ]     | `TS_OAUTH_SECRET`        | OAuth client yang sama (tahap 2.3)                                                                            | prompt: `gh secret set TS_OAUTH_SECRET --env staging -R "$R"`                                   |

Nilai yang **tidak** disimpan di GitHub: `/etc/kapdh/ci-migrate/staging.env` (URL database), token baca-paket GHCR di
VPS (user CI dan user server Coolify), dan env aplikasi di Coolify.

## Troubleshooting run pertama

Pesan dikutip dari kode. Galat `remote-migrate.sh` dari `die` tercetak `<waktu> kapdh-ci-migrate: GAGAL: <pesan>`.
Variabel wajib yang kosong atau hilang di berkas konfigurasi, dan galat sintaks saat berkas itu di-source, dicetak
langsung oleh shell tanpa awalan waktu/`GAGAL:`, mis. di dash (`/bin/sh` Debian/Ubuntu)
`/usr/local/bin/kapdh-ci-migrate: <baris>: <NAMA>: wajib di /etc/kapdh/ci-migrate/staging.env`, kode keluar 2. Galat
skrip Node tercetak sebagai anotasi `::error title=...::<pesan>`.

### Pemeriksaan awal `_deploy.yml`

| Pesan                                                                                                              | Penyebab                                                             | Perbaikan                                         |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------- |
| `Konfigurasi environment staging belum lengkap` + daftar nama, mis. `DEPLOY_SSH_HOST ... (docs/runbooks/ci-cd.md)` | secret/variable kosong atau diset di environment lain                | tahap 7.3; periksa `gh secret list --env staging` |
| `Jalur SSH tidak tepercaya` / `runner github-hosted tanpa Tailscale (TS_OAUTH_CLIENT_ID/TS_OAUTH_SECRET)...`       | salah satu `TS_OAUTH_*` kosong                                       | set keduanya (tahap 2.3, 7.3)                     |
| `API_BASE_URL tidak cocok` / `vars.API_BASE_URL=..., images.json staging=https://staging-api.kapdh.or.id/api/v1`   | variable berbeda (perbandingan persis, hanya satu `/` akhir dibuang) | kembalikan ke nilai katalog                       |
| Job tidak mulai, galat `fromJSON` pada `runs-on`                                                                   | `DEPLOY_RUNS_ON` diisi bukan JSON                                    | hapus variable repo itu (jalur Tailscale)         |
| `<n> dari 5 image teresolusi` atau `crane digest` gagal                                                            | image `sha-<commit>` belum ada untuk commit itu                      | jalankan untuk commit yang job image-nya sukses   |

### Tailscale dan SSH

| Pesan                                                                                               | Penyebab                                                                                                                                                                                                                                                                   | Perbaikan                                                      |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Langkah `VPN ke host deploy ...` gagal, mis. `requested tags [tag:ci] are invalid or not permitted` | OAuth client tanpa tag `tag:ci`/scope Auth Keys: Write, `tag:ci` tidak ada di `tagOwners`, atau secret salah                                                                                                                                                               | tahap 2.1 dan 2.3; buat ulang client, set ulang kedua secret   |
| `ssh: connect to host <host> port 22: Connection timed out`                                         | `DEPLOY_SSH_HOST` berisi IP publik; grant `tag:ci` → `tcp:22` tidak ada; firewall host menolak `tailscale0`; atau node runner belum tersebar ke VPS (sesekali pada run pertama; `ConnectTimeout=20` tanpa ulang)                                                           | periksa 2.1/2.4 dan secret; bila konfigurasi benar, ulangi job |
| `Host key verification failed.`                                                                     | kolom host `known_hosts` tidak sama persis dengan `DEPLOY_SSH_HOST` (IP vs nama, port bukan 22 tanpa `[host]:port`), atau Tailscale SSH aktif (host key lain)                                                                                                              | tahap 7.1; `sudo tailscale set --ssh=false`                    |
| `Permission denied (publickey).`                                                                    | kunci publik tidak/salah di `authorized_keys`; mode `.ssh`/`authorized_keys` bukan 700/600 milik user; kunci berpassphrase; akun `!` dengan `usepam no`; `AllowUsers`/`AllowGroups`; `DEPLOY_SSH_USER` salah; sumber koneksi bukan alamat tailnet (`from="100.64.0.0/10"`) | tahap 5.1, 5.4; uji 7.2 dari PC lewat tailnet                  |
| `Load key ".../kapdh-ssh/id": invalid format`                                                       | secret kunci terpotong atau memuat CRLF                                                                                                                                                                                                                                    | set ulang dari berkas (`grep -c $'\r'` = 0)                    |
| `This account is currently not available.`                                                          | shell user CI `nologin`                                                                                                                                                                                                                                                    | `sudo usermod -s /bin/sh kapdh-ci-staging`                     |

### Forced command `remote-migrate.sh`

| Pesan                                                                                                                                                                      | Penyebab                                                                                                                                                                              | Perbaikan                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `lingkungan forced command tidak diisi (command="/usr/local/bin/kapdh-ci-migrate <lingkungan>")`                                                                           | `command=` tanpa argumen `staging`                                                                                                                                                    | perbaiki `authorized_keys` (5.4)                                 |
| `argumen tambahan tidak diizinkan pada forced command`                                                                                                                     | `command=` memuat kata selain `staging`                                                                                                                                               | sama                                                             |
| `kunci ini terikat ke lingkungan production; permintaan untuk staging ditolak`                                                                                             | `authorized_keys` user staging memakai `kapdh-ci-migrate production`                                                                                                                  | ganti ke `staging`                                               |
| `konfigurasi /etc/kapdh/ci-migrate/staging.env tidak ada atau tidak terbaca`                                                                                               | berkas tidak ada, milik root/mode 600 root, atau `/etc/kapdh` tidak dapat dilalui                                                                                                     | pemilik `kapdh-ci-staging`, mode 0400, direktori 0755 (5.3, 5.6) |
| Galat sintaks sh yang menyebut `/etc/kapdh/ci-migrate/staging.env` (dicetak shell, tanpa `GAGAL:`)                                                                         | nilai tanpa kutip tunggal memuat `&`, `;`, `$`, spasi atau kurung                                                                                                                     | apit setiap nilai dengan kutip tunggal                           |
| `/usr/local/bin/kapdh-ci-migrate: <baris>: KAPDH_DOCKER_NETWORK: wajib di /etc/kapdh/ci-migrate/staging.env` (juga nama wajib lain; dicetak shell, tanpa `GAGAL:`, kode 2) | baris hilang/kosong, atau ditulis dengan nama jalur manual (`ADMIN_DATABASE_URL`, `MIGRATOR_DATABASE_URL`)                                                                            | enam nama wajib di templat 5.3                                   |
| `/etc/kapdh/ci-migrate/staging.env menyatakan KAPDH_ENVIRONMENT=..., bukan staging (berkas tertukar?)`                                                                     | isi berkas production                                                                                                                                                                 | perbaiki `KAPDH_ENVIRONMENT='staging'`                           |
| `KAPDH_PSQL_IMAGE wajib dipin @sha256:<digest> (PRD 7.1)`                                                                                                                  | image psql tanpa digest                                                                                                                                                               | salin nilai dari templat                                         |
| `RELEASE_GATE tidak berlaku untuk job migrasi CI; tulis KAPDH_RELEASE_GATE di /etc/kapdh/ci-migrate/staging.env (docs/runbooks/ci-cd.md bagian 5)`                         | nama gerbang jalur manual dipakai                                                                                                                                                     | hapus atau ganti ke `KAPDH_RELEASE_GATE`                         |
| `KAPDH_RELEASE_GATE harus enforce atau report`                                                                                                                             | nilai lain                                                                                                                                                                            | kosongkan (bawaan `report`)                                      |
| `image harus <KAPDH_API_REPOSITORY>@sha256:<digest>`                                                                                                                       | `KAPDH_API_REPOSITORY` bukan persis `ghcr.io/bayumusthafa/kapdh-api`                                                                                                                  | perbaiki (huruf kecil, tanpa tag/`/` akhir)                      |
| `docker pull image API gagal (login ghcr.io di server?)`                                                                                                                   | user CI belum `docker login ghcr.io`, token kedaluwarsa/tanpa akses paket, user bukan anggota grup `docker` (`permission denied ... docker.sock` di atasnya), atau VPS bukan `x86_64` | 5.1, 5.5; uji `docker pull` di 5.6                               |
| `docker pull image psql gagal`                                                                                                                                             | Docker Hub tidak terjangkau/rate limit                                                                                                                                                | ulangi; periksa egress VPS                                       |
| `versi skema database tidak dapat dibaca`                                                                                                                                  | `KAPDH_ADMIN_DATABASE_URL` salah (host, sandi, database), `KAPDH_DOCKER_NETWORK` salah, atau PostgreSQL mewajibkan TLS; galat `psql` di atasnya menyebut sebabnya                     | uji `pg_isready` dan login tahap 3-4; perbaiki URL               |
| `roles.sql sebelum migrasi gagal`                                                                                                                                          | URL admin bukan superuser, atau PostgreSQL < 16 (sintaks `WITH INHERIT FALSE, SET TRUE`)                                                                                              | pakai `postgres` resource PostgreSQL 17                          |
| `migrasi gagal; image baru JANGAN dideploy` dengan `password authentication failed for user "kapdh_migrator"`                                                              | sandi `kapdh_migrator` belum diatur atau berbeda dengan URL                                                                                                                           | tahap 4.2; samakan `KAPDH_MIGRATOR_DATABASE_URL`                 |
| `seed referensi gagal; image baru JANGAN dideploy` / `roles.sql sesudah migrasi gagal`                                                                                     | galat database di atasnya                                                                                                                                                             | perbaiki sebab, ulangi job (idempoten)                           |
| `gerbang go-live tidak dapat dijalankan (kode 3); image JANGAN dideploy`                                                                                                   | galat teknis gerbang (koneksi, role)                                                                                                                                                  | periksa log gerbang; URL migrator harus login `kapdh_migrator`   |
| `KAPDH_BACKUP_DIR <direktori> tidak ada` / `pg_dump pra-migrasi gagal; migrasi TIDAK dijalankan`                                                                           | dump opsional diaktifkan tanpa direktori, atau server PostgreSQL > 17                                                                                                                 | buat direktori 0700 milik user CI, atau hapus baris              |
| `gerbang menolak, tetapi mode laporan: job dilanjutkan. Belum boleh go-live.`                                                                                              | **bukan galat** di staging                                                                                                                                                            | tidak ada (9.2)                                                  |

### Deploy Coolify (`coolify-deploy.mjs`)

| Pesan                                                                                                                                                                                                                                                                                                                                    | Penyebab                                                                                                                                                                                                                                  | Perbaikan                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `COOLIFY_DEPLOY_URL bukan URL yang valid` / `COOLIFY_DEPLOY_URL wajib https (N-07)` / `COOLIFY_DEPLOY_URL wajib berakhir di /api/v1/deploy (endpoint deploy API Coolify)` / `COOLIFY_DEPLOY_URL wajib memuat parameter uuid=<resource,...> atau tag=<tag>` / `COOLIFY_DEPLOY_URL tidak boleh memuat kredensial; pakai COOLIFY_API_TOKEN` | format secret                                                                                                                                                                                                                             | susun ulang (6.5), uji `--dry-run`, set ulang         |
| `COOLIFY_API_TOKEN kosong`                                                                                                                                                                                                                                                                                                               | secret kosong                                                                                                                                                                                                                             | set ulang                                             |
| `Coolify menolak permintaan deploy: HTTP 405 {"message":"This endpoint has changed to a POST request."}`                                                                                                                                                                                                                                 | run dari commit sebelum perbaikan `POST` (mis. re-run 38654879656); Coolify >= 4.2.0 menolak GET                                                                                                                                          | run baru untuk HEAD `main` (8.1 A)                    |
| `Coolify menolak permintaan deploy: HTTP 401 ...` atau `HTTP 403 ...`                                                                                                                                                                                                                                                                    | token salah/dicabut/berspasi, tanpa izin `deploy`, akses API mati, atau IP runner tidak diizinkan                                                                                                                                         | 6.5; set ulang token                                  |
| `Coolify menolak permintaan deploy: HTTP 404 {"message":"No resources found."}`                                                                                                                                                                                                                                                          | tidak ada UUID yang dikenal (mis. UUID project/environment)                                                                                                                                                                               | UUID resource aplikasi                                |
| `resource <8 karakter> tidak mengembalikan deployment_uuid; rollout tidak dapat dipantau`                                                                                                                                                                                                                                                | UUID resource service/Compose atau database ikut di URL                                                                                                                                                                                   | hanya empat aplikasi "Docker Image"                   |
| `deployment <8> (resource <8>): http_403` berulang, lalu `GAGAL resource <8>: timeout (http_403)`                                                                                                                                                                                                                                        | token tanpa izin `read`                                                                                                                                                                                                                   | token deploy + read (6.5)                             |
| `GAGAL resource <8>: failed` (atau `error`, `cancelled-by-user`)                                                                                                                                                                                                                                                                         | lihat log deployment di panel: tarikan image `unauthorized` (login GHCR user server Coolify, bawaan root, 5.5), repo/tag salah (`kapdh-web-staging`, `:staging-staging`), healthcheck gagal (`localhost`, port/path salah, readiness 503) | 5.5, 6.2, 6.3                                         |
| `GAGAL resource <8>: timeout (queued)` / `timeout (in_progress)`                                                                                                                                                                                                                                                                         | antrean Coolify penuh atau tarikan lambat > 900 detik                                                                                                                                                                                     | periksa panel/kapasitas, ulangi job                   |
| `<n> deployment diantrekan` dengan n < 4 (langkah tetap hijau)                                                                                                                                                                                                                                                                           | UUID yang tidak dikenal dilewati Coolify tanpa galat                                                                                                                                                                                      | perbaiki URL; resource yang terlewat tidak di-rollout |

### Uji asap HTTP (`smoke.mjs`)

| Pesan (`tunggu <nama>: ...`, akhirnya `Uji asap <nama> gagal`)                                                   | Penyebab                                                                            | Perbaikan                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| api `HTTP 503`                                                                                                   | readiness gagal; isi `checks` tidak tercetak untuk 503                              | `curl -s https://staging-api.kapdh.or.id/api/v1/health/ready`: `database` fail = sandi/host `DATABASE_URL` `kapdh_app`; `storage` fail = mount/uid 1000 `/srv/kapdh/staging/files`; `redis` fail = `REDIS_URL` |
| `HTTP 404`, `HTTP 502`, `HTTP 504`                                                                               | domain/port resource di Traefik salah atau kontainer tidak sehat                    | 6.2                                                                                                                                                                                                            |
| `HTTP 301`, `HTTP 302`, `HTTP 307`, `HTTP 308`                                                                   | pengalihan pada `/` web/admin atau API (mis. www, `/login`)                         | hapus pengalihan path HTTPS (6.2)                                                                                                                                                                              |
| `body bukan JSON HealthReadiness`                                                                                | domain API menunjuk resource lain                                                   | perbaiki domain `kapdh-api`                                                                                                                                                                                    |
| `header Content-Security-Policy tidak ada` / `header X-Content-Type-Options: nosniff tidak ada`                  | domain web/admin melayani kontainer lain atau proxy membuang header                 | domain dan image resource (6.2)                                                                                                                                                                                |
| `commit image <12 hex> != <12 hex> (kontainer lama masih melayani?)` atau `commit image tidak dilaporkan != ...` | tag resource bukan `staging`, Coolify tidak me-rollout, atau `KAPDH_COMMIT` ditimpa | tag `staging` (6.4), hapus `KAPDH_COMMIT` dari env                                                                                                                                                             |
| `commit: HTTP 404` (web/admin)                                                                                   | `/version.json` tidak ada = bukan image KAPDH                                       | image resource (6.2)                                                                                                                                                                                           |
| `galat jaringan TimeoutError` / `galat jaringan TypeError`                                                       | DNS belum mengarah, sertifikat TLS belum terbit/tidak valid, port 443 tertutup      | tahap 1 (DNS), domain resource dan Traefik                                                                                                                                                                     |

### Uji asap lingkungan (`staging-smoke.sh`, tahap 9.3)

| Pesan                                                                                     | Penyebab                                                                                | Perbaikan                                         |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `GAGAL  <domain> HTTP → 302 https://... (harus 301/308 ke https)`                         | pengalihan proxy tidak permanen (middleware Coolify `redirectscheme` tanpa `permanent`) | tahap 6.2a                                        |
| `GAGAL  port 8000 TERBUKA di <ip-publik-vps> (harus tertutup firewall)` (juga 6001, 6002, 8080) | port yang dipublikasikan Docker melewati ufw | firewall penyedia atau aturan `DOCKER-USER` (2.4) |
| `PERINGATAN: port kontrol 9999 (tidak dipakai) ikut tersambung ...` | jaringan atau VPN di jalur menerima koneksi ke semua port | jalankan dari jaringan lain, atau buktikan port dengan prosedur `go-live.md` 2.4 |
| `PERINGATAN: nc tidak dapat menjangkau <ip>:443 ...` | `KAPDH_VPS_HOST` salah, `nc` tanpa `-z`, atau jaringan pemeriksa memblokir keluar | perbaiki host atau `nc`, jalankan dari jaringan lain, atau prosedur `go-live.md` 2.4 |
