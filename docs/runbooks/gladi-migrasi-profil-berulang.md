# Runbook: gladi migrasi profil berulang (0009-0010) pada salinan pulihan production

Rujukan: PRD 5.3, 5.5, 8.4; `docs/runbooks/rilis-dan-gerbang-go-live.md` bagian 5 dan 5.5;
`docs/runbooks/backup-restore.md` bagian 3, 7 dan 8.

> Satu-satunya tempat gladi migrasi 0009-0010 dengan data nyata. Staging hanya memakai data sintetis (PRD 5.3).
> Prosedur ini belum pernah dijalankan. Hal yang belum dapat dibuktikan dari kode ditandai **[A-n]** (bagian 16).
> Rilis production (bagian 14) **hanya** dijalankan setelah persetujuan tertulis pemilik produk.

| Butir                 | Nilai                                                                                                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Perubahan             | PR #18 (profil berulang): `0009_profile_lists` (3 tabel daftar; kunci EXCLUSIVE dengan batas tunggu 15 detik) + `0010_profile_lists_bridge` (isi awal, batas, jembatan, proyeksi); skrip pembatalan `infra/db/rollback/0009-0010-profile-lists.sql` |
| Image yang digladikan | `ghcr.io/<org>/kapdh-release:sha-<MERGE_SHA>`, dibangun dari commit merge PR #18 di `main`; `<org>` dibaca dari image API production di Blok 0.0                                                                                                    |
| Tempat gladi          | lingkungan drill terisolasi `backup-restore.md` 8.1, dalam bentuk yang dipakai drill restore Oktober 2026 (`docs/qa/restore-drills/2026-10/README.md`, bagian deviasi): VPS production yang sama dengan pagar isolasi bagian 2. Bukan staging       |
| Pelaksana             | pengelola infra sebagai root di terminal Coolify; saksi QA                                                                                                                                                                                          |
| Folder bukti          | `/root/bukti-gladi-0009/` (root 700, tetap ada sesudah pemusnahan; isinya hanya angka, sidik md5, id snapshot, log job)                                                                                                                             |
| Perkiraan durasi      | 60 sampai 90 menit                                                                                                                                                                                                                                  |
| Jendela waktu         | jam sepi, **di luar 18:45 sampai 20:00 UTC** (timer backup harian 19:15 UTC + jeda acak 5 menit)                                                                                                                                                    |

## Dasar perintah

Setiap perintah diturunkan dari berkas repo berikut:

- `kapdh-platform/infra/backup/{restore.sh, verify-restore.sh, lib.sh, backup.sh, backup.env.example}` dan
  `infra/backup/systemd/{kapdh-backup.service, kapdh-backup.timer}`
- `kapdh-platform/infra/scripts/{run-release.sh, release-job.sh}`, `kapdh-platform/infra/ci/remote-migrate.sh`
- `kapdh-platform/infra/db/{roles.sql, role-passwords.sql}`, `kapdh-platform/infra/db/rollback/0009-0010-profile-lists.sql`
- `kapdh-platform/packages/database/migrations/{0009_profile_lists.sql, 0010_profile_lists_bridge.sql, meta/_journal.json}`,
  `packages/database/src/migrate.ts`, `apps/api/test/pg/migrate-and-seed.pg.test.ts` (bentuk skema sesudah migrasi
  dan perilaku `lock_timeout`), `infra/Dockerfile.api` (skrip pembatalan disalin ke `/app/infra/db/rollback`)
- `packages/config/src/index.ts` (env wajib API/worker `NODE_ENV=staging`), `apps/api/src/cli/golive-check-command.ts`,
  `apps/api/src/modules/public/health.controller.ts`, `apps/api/src/modules/account/ledger-reapply.cli.ts`

Nilai pasti yang diturunkan dari kode:

| Nilai                                                                                                                                                                                                           | Asal                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Journal image baru: 11 migrasi; `when` 0008 = `1792062113847`, 0009 = `1792591532605`, 0010 = `1792591540265`                                                                                                   | `migrations/meta/_journal.json`                             |
| `drizzle.__drizzle_migrations`: `created_at` = `when` journal, `hash` = sha256 isi berkas SQL migrasi; skrip pembatalan menghapus dua baris lewat `created_at`                                                  | migrator Drizzle; skrip pembatalan baris terakhir           |
| 0009 diawali `SET LOCAL lock_timeout = '15s'`, `LOCK TABLE ... IN EXCLUSIVE MODE`, `SET LOCAL lock_timeout TO DEFAULT`. Kunci tidak diperoleh dalam 15 detik: `55P03`, seluruh transaksi migrasi dibatalkan     | `0009_profile_lists.sql`; uji `migrate-and-seed.pg.test.ts` |
| Isi awal 0010: profesi = setiap baris `alumni_professions` (posisi 0); pendidikan bila `btrim` tidak kosong, institusi `btrim(left(btrim(...), 120))`; tautan bila `char_length` 1 sampai 200, nilai apa adanya | `0010_profile_lists_bridge.sql`                             |
| Sesudah migrasi: +3 tabel `app` (40 → 43), +7 trigger non-internal (16 → 23), +10 fungsi                                                                                                                        | `migrate-and-seed.pg.test.ts`, 0010                         |
| Skrip pembatalan: 4 `DROP TRIGGER`, 10 `DROP FUNCTION`, 3 `DROP TABLE`, `DELETE 2`                                                                                                                              | `0009-0010-profile-lists.sql`                               |
| sha256 skrip pembatalan = `af72884cd45f07cf710766bc6a11c23a70ade2bae090989977dd9bd63cc896c8` (34 baris, LF)                                                                                                     | berkas yang ditinjau di PR #18                              |
| sha256 `infra/db/roles.sql` = `0696299e4492…` (tidak diubah PR #18)                                                                                                                                             | berkas di `main` dan PR #18                                 |
| Gerbang go-live `--json`: `JSON.stringify(report, null, 2)`, kunci `"ok": true/false` per pemeriksaan + puncak                                                                                                  | `golive-check-command.ts`                                   |

Sebelum gladi, cocokkan nilai yang bergantung pada isi merge di workstation (checkout repo):
`git show <MERGE_SHA>:kapdh-platform/infra/db/rollback/0009-0010-profile-lists.sql | sha256sum` harus sama dengan
nilai di atas; sha256 `0009_profile_lists.sql` dan `0010_profile_lists_bridge.sql` dengan perintah yang sama dicatat
untuk dibandingkan dengan keluaran Blok 0.4.

## 1. Aturan blok tempel (terminal Coolify)

Terminal Coolify merusak `read` di dalam blok yang ditempel dan tidak ada scp. Semua blok di bawah mematuhi aturan ini:

1. Baris pertama setiap blok memuat variabel dari `/root/bukti-gladi-0009/vars.env` (ditulis sekali di Blok 0.0).
   `MERGE_SHA` hanya diisi **satu kali**, di Blok 0.0.
2. Tanpa `read`, tanpa heredoc, tanpa prompt interaktif, tanpa `set -e` dan tanpa `exit` (keduanya menutup terminal).
3. Setiap perintah yang lama atau yang dapat membaca stdin diberi `</dev/null`. **`docker exec -i` / `docker run -i`
   hanya dipakai dengan `< berkas`**: tanpa pengalihan, Docker menelan sisa baris yang ditempel.
4. Tanpa karakter `!` di dalam tanda kutip ganda (ekspansi riwayat bash).
5. Setiap pemeriksaan mencetak satu baris `PASS ...`, `FAIL ...` atau `INFO ...`. Secret tidak pernah dicetak; berkas
   env ditampilkan hanya sebagai **nama kunci**. Data pribadi tidak dicetak: hanya jumlah dan sidik md5 agregat.
6. Blok idempoten (aman diulang) kecuali yang ditandai. Bila ada `FAIL`: **STOP**, jangan lanjut ke blok berikutnya
   (bagian 13). Bila gladi dibatalkan di tengah jalan, langsung ke Langkah 9 (pemusnahan); blok itu aman dijalankan kapan
   saja.
7. psql selalu `-v ON_ERROR_STOP=1 -v VERBOSITY=terse` (tanpa baris `DETAIL` yang dapat memuat isi baris data).

## 2. Pagar isolasi (sama dengan drill restore Oktober 2026)

| Pagar                | Wujud                                                                                                                                                      | Mencegah                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Jaringan             | `docker network create --internal kapdh-restore`: tanpa jalan keluar, tanpa port terbit; kontainer drill **hanya** di jaringan ini (tidak di `coolify`)    | nama host PostgreSQL production tidak dapat di-resolve dari kontainer drill; tidak ada lalu lintas ke internet |
| Database             | kontainer `kapdh-drill-pg` (image sama dengan production), volume `kapdh-drill-pgdata`                                                                     | tulisan apa pun berakhir di salinan                                                                            |
| Secret               | **semua** sandi/secret drill dibuat baru (`openssl rand -hex 32`) di `/etc/kapdh/drill` (600). Tidak ada sandi production yang disalin ke berkas drill     | env drill yang salah tunjuk ke production gagal autentikasi                                                    |
| Berkas               | `FILES_ROOT=/srv/kapdh/drill/files`; `LEDGER_REAPPLY_CMD` memasang direktori drill, bukan `/srv/kapdh/production/files`                                    | penerapan ulang ledger (menghapus objek akun terhapus) tidak menyentuh berkas production                       |
| Layanan luar         | API/worker drill `NODE_ENV=staging`, SMTP buntu (`smtp.gladi.invalid`), tanpa `FCM_*`, tanpa `DELETION_LEDGER_S3_*`, tanpa Redis, tanpa Sentry             | email/push/tulisan ledger dari drill                                                                           |
| Penyimpanan luar VPS | restic hanya `restore --no-lock` (repo backup), rclone ledger memakai **kunci hanya-baca** `kapdhledger`                                                   | tidak ada tulisan atau lock di bucket production                                                               |
| Nama                 | semua objek drill berawalan `kapdh-drill-`, jaringan `kapdh-restore`; job rilis drill bernama `kapdh-drill-release`                                        | salah hapus; pembuktian pemusnahan                                                                             |
| Pemeriksaan otomatis | Blok 2A-cek/2C memeriksa bahwa berkas drill memuat `kapdh-drill-pg` dan **tidak** memuat nama kontainer PostgreSQL production atau `/srv/kapdh/production` | salah salin                                                                                                    |

## 3. Langkah 0: prasyarat dan pagar

### Blok 0.0: variabel (satu-satunya tempat mengisi MERGE_SHA)

Ganti `ISI_40_HEKS_COMMIT_MERGE_PR18` dengan SHA 40 heksadesimal commit merge PR #18 di `main` yang image-nya sudah
terbit [A-1]. Registry image (`ghcr.io/<org>`) dibaca dari kontainer API production yang sedang berjalan.

```sh
MERGE_SHA=ISI_40_HEKS_COMMIT_MERGE_PR18
BK=/root/bukti-gladi-0009; R=$(docker ps --format '{{.Image}}' | grep -m1 '/kapdh-api:' | sed 's#/kapdh-api:.*##')
install -d -m 700 "$BK" "$BK/sql"
if printf '%s' "$MERGE_SHA" | grep -Eqx '[0-9a-f]{40}' && printf '%s' "$R" | grep -Eqx 'ghcr\.io/[a-z0-9._/-]+'; then printf '%s\n' "MERGE_SHA=$MERGE_SHA" "REL_IMG=$R/kapdh-release:sha-$MERGE_SHA" "API_IMG=$R/kapdh-api:sha-$MERGE_SHA" "WORKER_IMG=$R/kapdh-worker:sha-$MERGE_SHA" "ADMIN_IMG=$R/kapdh-admin:sha-$MERGE_SHA-production" "WEB_IMG=$R/kapdh-web:sha-$MERGE_SHA-production" "BK=$BK" "D=/etc/kapdh/drill" "EVR=/var/restore/kapdh/evidence/gladi-0009" "NET=kapdh-restore" "ENVF=/etc/kapdh/drill/release.env" > "$BK/vars.env" && echo "PASS vars.env ditulis" && cat "$BK/vars.env"; else echo "FAIL MERGE_SHA belum diisi (40 heksadesimal huruf kecil) atau registry image API production tidak terbaca ('$R')"; fi
```

### Blok 0.1: alat, jendela waktu, RAM, disk

```sh
. /root/bukti-gladi-0009/vars.env
[ "$(id -u)" = 0 ] && echo "PASS root" || echo "FAIL bukan root"
for c in docker restic rclone openssl sha256sum shred curl cmp; do command -v "$c" >/dev/null && echo "PASS alat $c" || echo "FAIL alat $c tidak ada"; done
HM=$(date -u +%H%M); if [ "$HM" -ge 1845 ] && [ "$HM" -le 2000 ]; then echo "FAIL jam $HM UTC dekat backup harian 19:15 UTC: tunda"; else echo "PASS jam $HM UTC di luar jendela backup"; fi
MEM=$(awk '/^MemAvailable/ {print int($2/1024)}' /proc/meminfo); [ "$MEM" -ge 1200 ] && echo "PASS RAM tersedia $MEM MB" || echo "FAIL RAM tersedia $MEM MB (< 1200)"
echo "INFO swap bebas $(awk '/^SwapFree/ {print int($2/1024)}' /proc/meminfo) MB"
for m in / /var/lib/docker; do f=$(df -Pm "$m" | awk 'NR==2 {print $4}'); [ "$f" -ge 5000 ] && echo "PASS disk bebas $m $f MB" || echo "FAIL disk bebas $m $f MB (< 5000)"; done
RPF=$(sed -n 's/^RESTIC_PASSWORD_FILE=//p' /etc/kapdh/backup.env | tr -d "\"'"); [ -r "$RPF" ] && echo "PASS berkas sandi restic terbaca" || echo "FAIL RESTIC_PASSWORD_FILE tidak terbaca"
```

Ambang RAM 1200 MB: drill menambah PostgreSQL (batas 640 MB) lalu job rilis (512 MB, sama dengan `run-release.sh`)
atau API drill (768 MB), tidak pernah ketiganya sekaligus. Disk diperiksa ulang dengan ukuran dump nyata di Blok 1.

### Blok 0.2: production sehat, nama kontainer PostgreSQL dicari dinamis

Nama kontainer PostgreSQL production **tidak** ditulis tetap: diambil dari host `ADMIN_DATABASE_URL` di
`/etc/kapdh/production/release.env` (host = nama kontainer Coolify di jaringan `coolify`, runbook rilis bagian 2
langkah 4) dan dicocokkan dengan kontainer terakhir di `PG_EXEC` `/etc/kapdh/backup.env`. Hanya nama host yang
dicetak, bukan URL.

```sh
. /root/bukti-gladi-0009/vars.env
docker ps --format '{{.Image}} {{.Status}}' | grep -E '/kapdh-(api|worker|web|admin):' | sed 's/@sha256:[0-9a-f]*//'
N=$(docker ps --format '{{.Image}} {{.Status}}' | grep -E '/kapdh-(api|worker|web|admin):' | grep -c '(healthy)'); [ "$N" -ge 4 ] && echo "PASS 4 layanan production healthy" || echo "FAIL hanya $N layanan production healthy"
C=$(curl -s -o /dev/null -w '%{http_code}' https://api.kapdh.or.id/api/v1/health/ready); [ "$C" = 200 ] && echo "PASS readiness production 200" || echo "FAIL readiness production $C"
PGC=$(sed -n 's#^ADMIN_DATABASE_URL=postgres[a-z]*://[^@]*@\([^:/]*\).*#\1#p' /etc/kapdh/production/release.env); PGC2=$(sed -n 's/^PG_EXEC=//p' /etc/kapdh/backup.env | tr -d "\"'" | awk '{print $NF}')
PGIMG=$(docker inspect -f '{{.Config.Image}}' "$PGC" 2>/dev/null); API_OLD=$(docker ps --format '{{.Image}}' | grep -m1 '/kapdh-api:')
[ -n "$PGC" ] && [ "$PGC" = "$PGC2" ] && echo "PASS kontainer PostgreSQL production $PGC (release.env = backup.env)" || echo "FAIL nama kontainer PostgreSQL: release.env='$PGC' backup.env='$PGC2'"
case "$PGIMG" in *postgres:17*) echo "PASS image PostgreSQL $PGIMG";; *) echo "FAIL image PostgreSQL '$PGIMG' bukan 17";; esac
[ -n "$API_OLD" ] && echo "INFO image API production (dipakai ledger-reapply drill): $API_OLD" || echo "FAIL image API production tidak ditemukan"
sed -i '/^PGC=/d;/^PGIMG=/d;/^API_OLD=/d' "$BK/vars.env"; printf '%s\n' "PGC=$PGC" "PGIMG=$PGIMG" "API_OLD=$API_OLD" >> "$BK/vars.env"
```

`API_OLD` dipakai untuk CLI ledger-reapply saat restore, sama dengan image di manifest backup (diperiksa di Blok 2D).

### Blok 0.3: tidak ada sisa drill, tidak ada job rilis berjalan, berkas tersedia

```sh
. /root/bukti-gladi-0009/vars.env
L=$(docker ps -aq --filter name=kapdh-drill | wc -l)$(docker volume ls -q --filter name=kapdh-drill | wc -l)$(docker network ls -q --filter name=kapdh-restore | wc -l)$(docker ps -q --filter name=kapdh-release | wc -l)
[ "$L" = 0000 ] && echo "PASS tidak ada sisa drill dan tidak ada job rilis berjalan" || echo "FAIL sisa kontainer/volume/jaringan/job (kode $L)"
for p in /srv/kapdh/drill /var/restore/kapdh /etc/kapdh/drill; do [ -e "$p" ] && echo "FAIL masih ada $p" || echo "PASS bersih $p"; done
for f in /etc/kapdh/backup.env /etc/kapdh/backup.secrets.env /etc/kapdh/production/release.env /opt/kapdh/infra/backup/restore.sh /opt/kapdh/infra/backup/verify-restore.sh /opt/kapdh/infra/db/roles.sql; do [ -r "$f" ] && echo "PASS ada $f" || echo "FAIL tidak ada $f"; done
/opt/kapdh/infra/backup/restore.sh --help </dev/null 2>&1 | grep -q -- '--evidence-dir' && echo "PASS restore.sh terpasang mengenal --evidence-dir dan --yes" || echo "FAIL restore.sh terpasang tidak dikenal"
echo "INFO sha256 roles.sql terpasang $(sha256sum /opt/kapdh/infra/db/roles.sql | cut -c1-12) (main dan PR #18: 0696299e4492)"
```

### Blok 0.4: image baru tersedia dan isinya benar

```sh
. /root/bukti-gladi-0009/vars.env
for i in "$REL_IMG" "$API_IMG"; do docker pull -q "$i" </dev/null >/dev/null 2>&1 && echo "PASS tarik $i" || echo "FAIL tarik $i (image belum terbit / login GHCR)"; done
DG=$(docker image inspect -f '{{index .RepoDigests 0}}' "$REL_IMG"); printf 'REL_DIGEST=%s\n' "$DG" > "$BK/digest-rilis.txt"; echo "INFO digest image rilis: $DG"
KC=$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$REL_IMG" | sed -n 's/^KAPDH_COMMIT=//p'); [ "$KC" = "$MERGE_SHA" ] && echo "PASS image rilis dibangun dari MERGE_SHA" || echo "FAIL KAPDH_COMMIT image '$KC'"
J=$(docker run --rm --entrypoint sh "$REL_IMG" -c 'grep -o "\"tag\"" /app/node_modules/@kapdh/database/migrations/meta/_journal.json | wc -l' </dev/null); [ "$J" = 11 ] && echo "PASS journal image 11 migrasi (s.d. 0010)" || echo "FAIL journal image $J migrasi"
M=/app/node_modules/@kapdh/database/migrations; docker run --rm --entrypoint grep "$REL_IMG" -qF "SET LOCAL lock_timeout = '15s'" "$M/0009_profile_lists.sql" </dev/null && echo "PASS 0009 di image memasang batas tunggu kunci 15 detik" || echo "FAIL 0009 di image tanpa lock_timeout 15 detik (versi sebelum perbaikan tinjauan)"
H9=$(docker run --rm --entrypoint sha256sum "$REL_IMG" "$M/0009_profile_lists.sql" </dev/null | cut -c1-64); H10=$(docker run --rm --entrypoint sha256sum "$REL_IMG" "$M/0010_profile_lists_bridge.sql" </dev/null | cut -c1-64); echo "INFO sha256 0009 di image $H9"; echo "INFO sha256 0010 di image $H10"
sed -i '/^H9=/d;/^H10=/d' "$BK/vars.env"; printf '%s\n' "H9=$H9" "H10=$H10" >> "$BK/vars.env"
RB=$(docker run --rm --entrypoint sha256sum "$REL_IMG" /app/infra/db/rollback/0009-0010-profile-lists.sql </dev/null | cut -c1-64); [ "$RB" = af72884cd45f07cf710766bc6a11c23a70ade2bae090989977dd9bd63cc896c8 ] && echo "PASS skrip pembatalan di image = versi PR #18 yang ditinjau" || echo "FAIL skrip pembatalan di image berbeda/tidak ada ($RB)"
```

`FAIL` pada sha256 skrip pembatalan berarti berkas berubah saat merge: tinjau isinya lebih dahulu, lalu perbarui nilai
di dokumen ini. Jangan menjalankan skrip yang belum ditinjau. sha256 0009/0010 di image harus sama dengan hasil
`git show <MERGE_SHA>:... | sha256sum` di workstation (bagian "Dasar perintah"); Blok 5C memeriksa bahwa migrator
mencatat hash yang sama.

### Secret yang dibutuhkan (dan yang tidak)

| Dibutuhkan                                                                  | Sumber                                                                                  | Akses ke layanan production                                                |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Kata sandi repositori restic                                                | `RESTIC_PASSWORD_FILE` dari `/etc/kapdh/backup.env` (berkas sudah ada di VPS)           | hanya baca repo backup (`restore --no-lock`)                               |
| Kunci S3 bucket backup (`AWS_*`)                                            | disaring dari `/etc/kapdh/backup.secrets.env` ke `/etc/kapdh/drill/restore.secrets.env` | hanya dipakai untuk baca; skrip restore tidak pernah `backup/forget/prune` |
| Kunci **hanya-baca** bucket deletion ledger (`RCLONE_CONFIG_KAPDHLEDGER_*`) | disaring dari berkas yang sama                                                          | `rclone copy` baca saja                                                    |
| Login GHCR root                                                             | `/root/.docker/config.json` (sudah ada)                                                 | tarik image                                                                |
| Sandi/secret drill (PostgreSQL, 3 role, JWT, OTP, FILE_URL, QR, TOTP)       | dibuat baru di Blok 2A                                                                  | hanya cluster drill                                                        |

**Tidak** dibutuhkan dan tidak disalin: sandi superuser/role PostgreSQL production, `TOTP_ENC_KEY`/`OTP_HMAC_SECRET`/
`JWT_ACCESS_SECRET` production, SMTP, FCM, kunci tulis ledger worker, `PGPASSWORD` `kapdh_backup` (sengaja disaring
keluar: restore.sh memuat berkas secret bawaan `/etc/kapdh/backup.secrets.env` bila `KAPDH_BACKUP_SECRETS` tidak
diarahkan, `lib.sh` `load_config`). Login admin drill tidak dipakai, sehingga `TOTP_ENC_KEY` production tidak perlu
(berbeda dengan backup-restore.md 8.1, yang menguji login MFA).

## 4. Langkah 1: backup baru sekarang

Backup harian dijalankan manual agar salinan gladi mutakhir. `kapdh-backup.service` bertipe `oneshot`: `systemctl start`
menunggu sampai selesai. Status sukses ditulis `backup.sh` ke `$WORK_DIR/status/last-success`.

### Blok 1

```sh
. /root/bukti-gladi-0009/vars.env
date -u +"%Y-%m-%dT%H:%M:%SZ langkah1-backup-mulai" >> "$BK/timeline.txt"
systemctl start kapdh-backup.service </dev/null
R=$(systemctl show -p Result --value kapdh-backup.service); S=$(systemctl show -p ExecMainStatus --value kapdh-backup.service)
WD=$(sed -n 's/^WORK_DIR=//p' /etc/kapdh/backup.env | tr -d "\"'"); WD=${WD:-/var/backups/kapdh}; cp "$WD/status/last-success" "$BK/backup-last-success.txt"
AGE=$(( $(date -u +%s) - $(sed -n 's/^finished_epoch=//p' "$BK/backup-last-success.txt") ))
[ "$R" = success ] && [ "$S" = 0 ] && [ "$AGE" -lt 900 ] && echo "PASS backup baru $(sed -n 's/^backup_id=//p' "$BK/backup-last-success.txt") selesai ${AGE}s lalu" || echo "FAIL backup: Result=$R status=$S umur=${AGE}s"
grep -E '^(backup_id|db_snapshot|files_snapshot|db_snapshot_captured_at|duration_seconds)=' "$BK/backup-last-success.txt"
DB=$(journalctl -u kapdh-backup --since '30 min ago' --no-pager | sed -n 's/.*dump selesai: \([0-9]*\) byte.*/\1/p' | tail -n 1); FB=$(journalctl -u kapdh-backup --since '30 min ago' --no-pager | sed -n 's/.*berkas, \([0-9]*\) byte.*/\1/p' | tail -n 1)
NEED=$(( (6 * ${DB:-0} + ${FB:-0}) / 1048576 + 2048 )); FREE=$(df -Pm / | awk 'NR==2 {print $4}'); [ "$FREE" -ge "$NEED" ] && echo "PASS disk bebas $FREE MB >= perkiraan $NEED MB (dump ${DB:-?} B, berkas ${FB:-?} B)" || echo "FAIL disk bebas $FREE MB < perkiraan $NEED MB"
```

Perkiraan disk: dump unduhan + database pulihan (diambil 6 kali ukuran dump custom terkompresi, konservatif) + salinan
berkas + 2 GB cadangan untuk image. Catat `backup_id` dan `db_snapshot`; restore memakai snapshot itu secara eksplisit.

## 5. Langkah 2: restore ke database drill terisolasi (`restore.sh --target-kind drill`)

### Blok 2A: secret dan berkas env drill (baru, 600)

`release.env` drill memakai **kunci yang sama** dengan berkas production (`ADMIN_DATABASE_URL`,
`MIGRATOR_DATABASE_URL`, `KAPDH_MIGRATOR_DB_PASSWORD`, `KAPDH_APP_DB_PASSWORD`, `KAPDH_WORKER_DB_PASSWORD`; runbook
rilis bagian 2 langkah 4) dengan host `kapdh-drill-pg`, tetapi **semua nilai sandi baru**. Berkas production tidak
disalin lalu diganti host-nya: cara itu menyebarkan sandi superuser dan role production ke cluster drill dan
menghapus pagar "salah tunjuk = gagal autentikasi". Perbandingan nama kunci production dan drill dicetak di Blok
2A-cek.

```sh
. /root/bukti-gladi-0009/vars.env
umask 077; install -d -m 700 "$D"
[ -s "$D/secrets.env" ] && echo "INFO secret drill sudah ada, tidak dibuat ulang" || for k in PW_PG PW_MIG PW_APP PW_WRK JWT OTP FURL QR TOTP; do printf '%s=%s\n' "$k" "$(openssl rand -hex 32)" >> "$D/secrets.env"; done
. "$D/secrets.env"; H=kapdh-drill-pg; SMTP=smtp://gladi:gladi@smtp.gladi.invalid:2525
printf 'POSTGRES_PASSWORD=%s\n' "$PW_PG" > "$D/pg.env"
printf "ALTER ROLE kapdh_migrator PASSWORD '%s';\nALTER ROLE kapdh_app PASSWORD '%s';\nALTER ROLE kapdh_worker PASSWORD '%s';\n" "$PW_MIG" "$PW_APP" "$PW_WRK" > "$D/role-passwords.sql"
printf 'ADMIN_DATABASE_URL=postgres://postgres:%s@%s:5432/kapdh\nMIGRATOR_DATABASE_URL=postgres://kapdh_migrator:%s@%s:5432/kapdh\nKAPDH_MIGRATOR_DB_PASSWORD=%s\nKAPDH_APP_DB_PASSWORD=%s\nKAPDH_WORKER_DB_PASSWORD=%s\n' "$PW_PG" "$H" "$PW_MIG" "$H" "$PW_MIG" "$PW_APP" "$PW_WRK" > "$D/release.env"
printf 'NODE_ENV=staging\nDATABASE_URL=postgres://kapdh_worker:%s@%s:5432/kapdh\nSMTP_URL=%s\nFILE_URL_SECRET=%s\nLOG_LEVEL=warn\n' "$PW_WRK" "$H" "$SMTP" "$FURL" > "$D/worker.env"
printf 'NODE_ENV=staging\nDATABASE_URL=postgres://kapdh_app:%s@%s:5432/kapdh\nSMTP_URL=%s\nFILE_URL_SECRET=%s\nJWT_ACCESS_SECRET=%s\nOTP_HMAC_SECRET=%s\nQR_SIGNING_KEYS=gladi1:%s\nTOTP_ENC_KEY=%s\nAPI_PUBLIC_URL=https://api.gladi.invalid\nPUBLIC_WEB_URL=https://gladi.invalid\nADMIN_ORIGIN=https://admin.gladi.invalid\nLOG_LEVEL=warn\nNODE_OPTIONS=--max-old-space-size=384\n' "$PW_APP" "$H" "$SMTP" "$FURL" "$JWT" "$OTP" "$QR" "$TOTP" > "$D/api.env"
chmod 600 "$D"/*; unset PW_PG PW_MIG PW_APP PW_WRK JWT OTP FURL QR TOTP; echo "INFO berkas drill: $(ls "$D" | tr '\n' ' ')"
```

Isi env API/worker drill memenuhi `loadApiEnv`/`loadWorkerEnv` untuk `NODE_ENV=staging` (`packages/config`): SMTP
wajib (diisi alamat buntu), `FILE_URL_SECRET` ≥ 32, `QR_SIGNING_KEYS` `id:secret` ≥ 32, `TOTP_ENC_KEY` 64 heks bukan
nol, `API_PUBLIC_URL` https; Redis, FCM dan ledger S3 opsional di luar production.

### Blok 2A-cek

```sh
. /root/bukti-gladi-0009/vars.env
[ "$(grep -c '@kapdh-drill-pg:5432/kapdh$' "$D/release.env")" = 2 ] && echo "PASS release.env drill menunjuk kapdh-drill-pg" || echo "FAIL release.env drill"
grep -l -- "$PGC" "$D"/* >/dev/null 2>&1 && echo "FAIL nama kontainer PostgreSQL production muncul di berkas drill" || echo "PASS tidak ada rujukan host production di $D"
echo "INFO kunci release.env production: $(sed -n 's/=.*//p' /etc/kapdh/production/release.env | sort | tr '\n' ' ')"
echo "INFO kunci release.env drill     : $(sed -n 's/=.*//p' "$D/release.env" | sort | tr '\n' ' ')"
echo "INFO izin: $(stat -c '%a %n' "$D"/* | tr '\n' ' ')"
```

Bila production `release.env` memuat kunci lain (mis. `KAPDH_BACKUP_DB_PASSWORD`, `KAPDH_MONITOR_DB_PASSWORD`), kunci
itu hanya menyetel sandi role backup/monitor dan tidak memengaruhi migrasi; drill tidak memerlukannya. Bila memuat
`RELEASE_GATE*`, catat: itu memengaruhi mode gerbang production (bagian 14, P.1).

### Blok 2B: jaringan internal dan PostgreSQL drill

Image PostgreSQL drill = image kontainer production (`PGIMG`, runbook backup-restore 7 langkah 2 "image versi sama").

```sh
. /root/bukti-gladi-0009/vars.env
[ -n "$PGIMG" ] || echo "FAIL PGIMG kosong: ulangi Blok 0.2"
docker network inspect kapdh-restore >/dev/null 2>&1 || docker network create --internal kapdh-restore >/dev/null
docker volume inspect kapdh-drill-pgdata >/dev/null 2>&1 || docker volume create kapdh-drill-pgdata >/dev/null
docker inspect kapdh-drill-pg >/dev/null 2>&1 || docker run -d --name kapdh-drill-pg --network kapdh-restore --env-file "$D/pg.env" -v kapdh-drill-pgdata:/var/lib/postgresql/data --memory 640m --shm-size 128m "$PGIMG" -c shared_buffers=64MB -c max_connections=40 </dev/null >/dev/null
i=0; until docker exec kapdh-drill-pg pg_isready -q -h 127.0.0.1 -U postgres; do i=$((i+1)); [ "$i" -ge 45 ] && break; sleep 2; done
[ "$(docker exec kapdh-drill-pg psql -U postgres -X -A -t -c 'select 1')" = 1 ] && echo "PASS PostgreSQL drill siap (socket superuser)" || echo "FAIL PostgreSQL drill belum siap"
[ "$(docker run --rm --network kapdh-restore --env-file "$D/release.env" "$PGIMG" sh -c 'psql "${ADMIN_DATABASE_URL%/kapdh}/postgres" -X -A -t -c "select 1"' </dev/null 2>/dev/null)" = 1 ] && echo "PASS superuser drill tersambung lewat TCP di jaringan drill (sandi drill)" || echo "FAIL koneksi TCP superuser drill"
[ "$(docker network inspect -f '{{.Internal}}' kapdh-restore)" = true ] && echo "PASS jaringan kapdh-restore internal" || echo "FAIL jaringan tidak internal"
echo "INFO jaringan kapdh-drill-pg: $(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' kapdh-drill-pg); port terbit: $(docker port kapdh-drill-pg | wc -l); $(docker exec kapdh-drill-pg postgres --version)"
```

Catatan: database `kapdh` baru dibuat restore.sh, jadi uji TCP superuser memakai database `postgres` (URL yang sama
dengan akhiran `/kapdh` diganti, di dalam kontainer). Uji `pg_isready -h 127.0.0.1` dipakai karena server sementara
saat inisialisasi image hanya mendengar socket [A-4].

### Blok 2C: env restore drill dari konfigurasi backup production (disaring)

`restore.sh` memuat `KAPDH_BACKUP_ENV` (konfigurasi) lalu `KAPDH_BACKUP_SECRETS` (secret) dan mengekspor semuanya
(`lib.sh` `load_env_file`, `set -a`). Isi yang disalin dari production hanya: lokasi repo restic, berkas sandi restic,
remote ledger, kunci S3 dan kunci baca ledger. Selebihnya nilai drill (bagian "KHUSUS RESTORE" `backup.env.example`).

```sh
. /root/bukti-gladi-0009/vars.env
umask 077
grep -E '^(KAPDH_ENV|RESTIC_HOST|RESTIC_REPOSITORY|RESTIC_PASSWORD_FILE|RESTIC_PASSWORD_COMMAND|LEDGER_RCLONE_REMOTE)=' /etc/kapdh/backup.env > "$D/restore.env"
printf '%s\n' 'WORK_DIR=/var/restore/kapdh' 'RESTIC_CACHE_DIR=/var/restore/kapdh/.cache-restic' 'RESTORE_DB=kapdh' 'RESTORE_ADMIN_DB=postgres' 'FILES_ROOT=/srv/kapdh/drill/files' 'FILES_OWNER=1000:1000' 'PGUSER=postgres' 'PG_EXEC="docker exec -i -e PGUSER -e PGPASSWORD -e PGDATABASE kapdh-drill-pg"' 'ROLE_PASSWORDS_SQL=/etc/kapdh/drill/role-passwords.sql' 'LEDGER_DIR_IN_CMD=/ledger' 'KUMA_PUSH_RESTORE=' >> "$D/restore.env"
printf 'LEDGER_REAPPLY_CMD=\047docker run --rm --network kapdh-restore --env-file /etc/kapdh/drill/worker.env -v /srv/kapdh/drill/files:/data/files -v "$KAPDH_LEDGER_DIR":/ledger:ro %s node dist/modules/account/ledger-reapply.cli.js\047\n' "$API_OLD" >> "$D/restore.env"
grep -E '^(AWS_[A-Z0-9_]+|RESTIC_[A-Z0-9_]+|RCLONE_CONFIG_KAPDHLEDGER_[A-Z0-9_]+)=' /etc/kapdh/backup.secrets.env > "$D/restore.secrets.env"; chmod 600 "$D/restore.env" "$D/restore.secrets.env"
echo "INFO kunci restore.env: $(sed -n 's/=.*//p' "$D/restore.env" | tr '\n' ' ')"; echo "INFO kunci restore.secrets.env: $(sed -n 's/=.*//p' "$D/restore.secrets.env" | tr '\n' ' ')"
grep -q '^RESTIC_REPOSITORY=' "$D/restore.env" && grep -q '^LEDGER_REAPPLY_CMD=' "$D/restore.env" && grep -q '^LEDGER_RCLONE_REMOTE=' "$D/restore.env" && [ "$(grep -c '^RCLONE_CONFIG_KAPDHLEDGER_' "$D/restore.secrets.env")" -ge 3 ] && echo "PASS env restore lengkap" || echo "FAIL env restore kurang (repo restic / remote ledger / kunci baca ledger)"
grep -Eq '^PGPASSWORD=|/srv/kapdh/production|kapdh_backup' "$D/restore.env" "$D/restore.secrets.env" && echo "FAIL env restore memuat rujukan production" || echo "PASS env restore tanpa PGPASSWORD/berkas production"
grep -q -- "$PGC" "$D/restore.env" "$D/restore.secrets.env" && echo "FAIL nama kontainer PostgreSQL production di env restore" || echo "PASS env restore tanpa host PostgreSQL production"
```

Mengapa `restore.sh` tidak perlu "jaringan kustom": koneksi database restore berjalan lewat `PG_EXEC` (`docker exec`
ke `kapdh-drill-pg`, socket lokal), dan satu-satunya kontainer yang dibuat restore.sh (`LEDGER_REAPPLY_CMD`) sudah
menyebut `--network kapdh-restore` sendiri. `FILES_OWNER=1000:1000` wajib karena CLI di image berjalan sebagai `node`.
Batasan yang tetap ada: restore.sh **selalu** memulihkan berkas juga (tidak ada mode database saja), jadi salinan berkas
production ikut ke `/srv/kapdh/drill/files` dan dimusnahkan di Langkah 9.

### Blok 2D: jalankan restore.sh (flag pasti) dan periksa hasil

Flag: `--target-kind drill` (wajib), `--snapshot <db_snapshot dari Blok 1>` (bukan `latest`, agar pasti backup yang
baru), `--evidence-dir` tetap, `--yes` (tanpanya restore.sh memanggil `read`, yang rusak di terminal ini). Dijalankan
sebagai root (restore.sh mewajibkan root atau uid `FILES_OWNER`).

```sh
. /root/bukti-gladi-0009/vars.env
SNAP=$(sed -n 's/^db_snapshot=//p' "$BK/backup-last-success.txt"); echo "INFO snapshot kapdh-db $SNAP"; date -u +"%Y-%m-%dT%H:%M:%SZ langkah2-restore-mulai" >> "$BK/timeline.txt"
KAPDH_BACKUP_ENV="$D/restore.env" KAPDH_BACKUP_SECRETS="$D/restore.secrets.env" /opt/kapdh/infra/backup/restore.sh --target-kind drill --snapshot "$SNAP" --evidence-dir "$EVR" --yes </dev/null; RC=$?
date -u +"%Y-%m-%dT%H:%M:%SZ langkah2-restore-selesai kode $RC" >> "$BK/timeline.txt"; [ "$RC" = 0 ] && echo "PASS restore.sh kode 0" || echo "FAIL restore.sh kode $RC (lihat $EVR/restore.log; STOP)"
FC=$(grep -c '^FAIL' "$EVR/verify-report.txt"); WC=$(grep -c '^WARN' "$EVR/verify-report.txt"); [ "$FC" = 0 ] && echo "PASS verify-report 0 FAIL, $WC WARN" || echo "FAIL verify-report $FC FAIL"
grep -E '^(PASS|WARN|FAIL|INFO) ' "$EVR/verify-report.txt"
B1=$(sed -n 's/^backup_id=//p' "$BK/backup-last-success.txt"); B2=$(sed -n 's/^backup_id=//p' "$EVR/summary.txt" | tail -n 1); [ -n "$B1" ] && [ "$B1" = "$B2" ] && echo "PASS restore memakai backup $B1" || echo "FAIL backup_id restore '$B2' bukan '$B1'"
grep -E '^(restore_seconds|backup_age_at_start_seconds|files_restored|ledger_entry_files)=' "$EVR/summary.txt"; grep -A 5 '"images"' "$EVR/manifest.json" | sed 's/@sha256:[0-9a-f]*//'
```

Harapan: 0 FAIL; WARN `http` (normal, `VERIFY_API_URL` kosong); invariant (`users`, `payments`, `paid_total`, ...)
dan `skema.applied` = 9 sama dengan manifest; `images.api` di manifest = `API_OLD` (Blok 0.2).

Ulang restore yang gagal di tengah jalan: restore.sh menolak database yang sudah berisi skema, jadi kosongkan dulu (hanya
objek drill):

```sh
. /root/bukti-gladi-0009/vars.env
docker exec kapdh-drill-pg psql -U postgres -X -q -c 'drop database if exists kapdh' </dev/null && rm -rf /srv/kapdh/drill/files "$EVR" && echo "INFO database dan berkas drill dikosongkan; ulangi Blok 2D"
```

## 6. Langkah 3: hitungan "sebelum" dan cek versi skema pada database drill

Semua kueri pemeriksaan dijalankan dari kontainer image PostgreSQL di jaringan drill sebagai `kapdh_migrator`
(pemilik objek, baca saja), URL dibaca dari `--env-file` di dalam kontainer (pola `remote-migrate.sh`). Hanya kueri
`transaksi-lama.sql` yang memakai superuser, karena role lain tidak melihat `xact_start` sesi milik role lain. Fungsi
`sqlf`/`sqla` yang sama dipakai untuk production di bagian 14 dengan `NET=coolify` dan
`ENVF=/etc/kapdh/production/release.env`, sehingga gladi juga melatih perintah pemeriksaan production. Berkas
`runbook55*.sql` dan `transaksi-lama.sql` memuat kueri runbook rilis 5.5 apa adanya.

### Blok 3A: tulis berkas SQL (tanpa heredoc)

```sh
. /root/bukti-gladi-0009/vars.env
tulis() { printf '%s\n' "$1" >> "$F"; }
F="$BK/sql/skema.sql"; : > "$F"
tulis "select 'migrasi_tercatat=' || count(*) from drizzle.__drizzle_migrations;"
tulis "select 'migrasi_terakhir=' || coalesce(max(created_at), 0) from drizzle.__drizzle_migrations;"
tulis "select 'tabel_app=' || count(*) from pg_tables where schemaname = 'app';"
tulis "select 'tabel_daftar_baru=' || count(*) from pg_tables where schemaname = 'app' and tablename in ('alumni_education', 'alumni_social_links', 'alumni_profession_entries');"
tulis "select 'fungsi_baru=' || count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname in ('profile_lists_api_writer', 'alumni_list_limit', 'alumni_apply_legacy_social', 'alumni_apply_legacy_education', 'alumni_apply_legacy_profession', 'alumni_legacy_profile_bridge', 'alumni_professions_legacy_bridge', 'alumni_project_legacy_profile', 'alumni_legacy_reproject', 'alumni_professions_legacy_reproject');"
tulis "select 'trigger_baru=' || count(*) from pg_trigger where not tgisinternal and tgname in ('alumni_profession_entries_limit', 'alumni_education_limit', 'alumni_social_links_limit', 'alumni_legacy_profile_bridge', 'alumni_professions_legacy_bridge', 'alumni_legacy_reproject', 'alumni_professions_legacy_reproject');"
tulis "select 'trigger_total=' || count(*) from pg_trigger where not tgisinternal;"
F="$BK/sql/runbook55.sql"; : > "$F"
tulis "select count(*) filter (where btrim(coalesce(last_education_institution, '')) <> '') as pendidikan,"
tulis "       count(*) filter (where char_length(social_instagram) between 1 and 200)"
tulis "         + count(*) filter (where char_length(social_x) between 1 and 200)"
tulis "         + count(*) filter (where char_length(social_facebook) between 1 and 200)"
tulis "         + count(*) filter (where char_length(social_linkedin) between 1 and 200) as tautan,"
tulis "       (select count(*) from app.alumni_professions) as profesi"
tulis "from app.alumni;"
F="$BK/sql/runbook55-dilewati.sql"; : > "$F"
tulis "select count(*) filter (where char_length(social_instagram) not between 1 and 200)"
tulis "         + count(*) filter (where char_length(social_x) not between 1 and 200)"
tulis "         + count(*) filter (where char_length(social_facebook) not between 1 and 200)"
tulis "         + count(*) filter (where char_length(social_linkedin) not between 1 and 200) as tautan_dilewati"
tulis "from app.alumni;"
F="$BK/sql/runbook55-sesudah.sql"; : > "$F"
tulis "select count(*) filter (where btrim(coalesce(last_education_institution, '')) <> '') as pendidikan,"
tulis "       (select count(*) from app.alumni_education) as pendidikan_baru,"
tulis "       count(*) filter (where char_length(social_instagram) between 1 and 200)"
tulis "         + count(*) filter (where char_length(social_x) between 1 and 200)"
tulis "         + count(*) filter (where char_length(social_facebook) between 1 and 200)"
tulis "         + count(*) filter (where char_length(social_linkedin) between 1 and 200) as tautan,"
tulis "       (select count(*) from app.alumni_social_links) as tautan_baru,"
tulis "       (select count(*) from app.alumni_professions) as profesi,"
tulis "       (select count(*) from app.alumni_profession_entries) as profesi_baru"
tulis "from app.alumni;"
F="$BK/sql/transaksi-lama.sql"; : > "$F"
tulis "select count(*) as transaksi_lama from pg_stat_activity"
tulis "where datname = current_database() and backend_type = 'client backend' and pid <> pg_backend_pid()"
tulis "  and xact_start < now() - interval '15 seconds';"
wc -l "$BK"/sql/skema.sql "$BK"/sql/runbook55*.sql "$BK/sql/transaksi-lama.sql"
```

Harapan `wc -l`: `skema.sql` 7, `runbook55.sql` 7, `runbook55-dilewati.sql` 5, `runbook55-sesudah.sql` 10,
`transaksi-lama.sql` 3.

### Blok 3A-2: berkas SQL hitungan kolom lama dan sidik

Aturan hitungan sama dengan isi awal 0010 (bagian "Dasar perintah"). `tautan_dilewati` menghitung nilai sosial lama
yang **tidak** disalin isi awal (string kosong atau lebih dari 200 karakter). Kolom lama tidak memiliki CHECK panjang
di database dan API lama menolak kedua bentuk itu, jadi nilai ini harus dibuktikan 0.

```sh
. /root/bukti-gladi-0009/vars.env
tulis() { printf '%s\n' "$1" >> "$F"; }
F="$BK/sql/hitung-lama.sql"; : > "$F"
tulis "select 'pendidikan=' || count(*) filter (where btrim(coalesce(last_education_institution, '')) <> '') from app.alumni;"
tulis "select 'tautan=' || (count(*) filter (where char_length(social_instagram) between 1 and 200) + count(*) filter (where char_length(social_x) between 1 and 200) + count(*) filter (where char_length(social_facebook) between 1 and 200) + count(*) filter (where char_length(social_linkedin) between 1 and 200)) from app.alumni;"
tulis "select 'tautan_dilewati=' || (count(*) filter (where char_length(social_instagram) not between 1 and 200) + count(*) filter (where char_length(social_x) not between 1 and 200) + count(*) filter (where char_length(social_facebook) not between 1 and 200) + count(*) filter (where char_length(social_linkedin) not between 1 and 200)) from app.alumni;"
tulis "select 'pendidikan_dipotong_120=' || count(*) filter (where char_length(btrim(last_education_institution)) > 120) from app.alumni;"
tulis "select 'profesi=' || count(*) from app.alumni_professions;"
tulis "select 'alumni=' || count(*) from app.alumni;"
tulis "select 'akun=' || count(*) from app.users;"
F="$BK/sql/sidik.sql"; : > "$F"
tulis "select 'sidik_alumni=' || coalesce(md5(string_agg(md5(t::text), ',' order by t.user_id)), 'kosong') from app.alumni t;"
tulis "select 'sidik_alumni_professions=' || coalesce(md5(string_agg(md5(t::text), ',' order by t.alumni_user_id, t.profession_id)), 'kosong') from app.alumni_professions t;"
tulis "select 'sidik_master_professions=' || coalesce(md5(string_agg(md5(t::text), ',' order by t.id)), 'kosong') from app.master_professions t;"
wc -l "$BK/sql/hitung-lama.sql" "$BK/sql/sidik.sql"
```

Sidik = md5 dari gabungan md5 setiap **baris utuh** (semua kolom, termasuk `social_*`, `last_education_*` dan
`updated_at`) `alumni`, `alumni_professions` dan `master_professions` (tiga tabel yang dikunci 0009). Hanya hash
agregat yang dicetak; tidak dapat dibalik ke data pribadi.

### Blok 3B: jalankan hitungan "sebelum"

```sh
. /root/bukti-gladi-0009/vars.env
sqlf() { docker run --rm -i --network "$NET" --env-file "$ENVF" "$PGIMG" sh -c 'psql "$MIGRATOR_DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=terse -f -' < "$1"; }
sqla() { docker run --rm -i --network "$NET" --env-file "$ENVF" "$PGIMG" sh -c 'psql "$ADMIN_DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=terse -f -' < "$1"; }
val() { sed -n "s/^$1=//p" "$2" | head -n 1; }; cek() { if [ "$2" = "$3" ]; then echo "PASS $1=$2"; else echo "FAIL $1: dapat '$2', harap '$3'"; fi; }
S="$BK/skema-sebelum.txt"; L="$BK/hitung-lama-sebelum.txt"; sqlf "$BK/sql/skema.sql" > "$S"; sqlf "$BK/sql/hitung-lama.sql" > "$L"; sqlf "$BK/sql/sidik.sql" > "$BK/sidik-sebelum.txt"
R55=$(sqlf "$BK/sql/runbook55.sql"); echo "runbook_5_5(pendidikan|tautan|profesi)=$R55" | tee "$BK/runbook55-sebelum.txt"; cat "$L" "$BK/sidik-sebelum.txt"
cek migrasi_tercatat "$(val migrasi_tercatat "$S")" 9; cek migrasi_terakhir "$(val migrasi_terakhir "$S")" 1792062113847
cek tabel_daftar_baru "$(val tabel_daftar_baru "$S")" 0; cek fungsi_baru "$(val fungsi_baru "$S")" 0; cek trigger_baru "$(val trigger_baru "$S")" 0
echo "INFO tabel_app=$(val tabel_app "$S") (uji PR: 40) trigger_total=$(val trigger_total "$S") (uji PR: 16)"
cek runbook_5_5 "$R55" "$(val pendidikan "$L")|$(val tautan "$L")|$(val profesi "$L")"
cek tautan_dilewati "$(val tautan_dilewati "$L")" 0; cek runbook_5_5_dilewati "$(sqlf "$BK/sql/runbook55-dilewati.sql")" "$(val tautan_dilewati "$L")"
echo "INFO pendidikan_dipotong_120=$(val pendidikan_dipotong_120 "$L") (jumlah tetap; institusi dipotong ke 120 karakter di daftar)"
echo "INFO transaksi_lama=$(sqla "$BK/sql/transaksi-lama.sql") (database drill tanpa penulis lain: harap 0)"
```

`migrasi_terakhir=1792062113847` = `when` journal `0008_qris_payment_method`: skema tepat di 0008 (9 migrasi).
`runbook_5_5` membuktikan kueri runbook rilis 5.5 langkah 1.1 menghasilkan angka yang sama dengan hitungan gladi.

## 7. Langkah 4: job rilis image baru terhadap database drill, persis seperti production

Urutan yang dijalankan entry image (`release-job.sh`, tidak diubah): tunggu DB → cek versi skema (9 ≤ 11) →
`roles.sql` → `role-passwords.sql` → gerbang pra-migrasi `--preflight` (enforce) → `migrate.js` sebagai
`kapdh_migrator` (advisory lock, semua migrasi tertunda satu transaksi; 0009 menunggu kunci EXCLUSIVE paling lama 15
detik) → `roles.sql` → `seed-reference.js` → gerbang penuh.

**Cara menjalankan.** `run-release.sh` tidak ikut di image (Dockerfile.api hanya menyalin `release-job.sh`, `infra/db`,
`infra/backup`, `infra/monitoring`) dan keberadaannya di VPS belum terbukti [A-2]. Blok 4 memakai perintah
`docker run` yang **setara baris per baris** dengan `run-release.sh` (`--rm --network <net> --env-file <berkas>
-e KAPDH_ENV=<env> [-e RELEASE_GATE=...] --security-opt no-new-privileges:true --cap-drop ALL --memory 512m`), dengan
dua penggantian yang memang disediakan skrip itu lewat env (`KAPDH_DOCKER_NETWORK=kapdh-restore`,
`KAPDH_RELEASE_ENV_FILE=/etc/kapdh/drill/release.env`) dan satu perbedaan nama kontainer (`kapdh-drill-release`, bukan
`kapdh-release-production`, agar mudah dibuktikan saat pemusnahan). Bila `run-release.sh` ada di VPS, padanannya:
`KAPDH_RELEASE_ENV_FILE=/etc/kapdh/drill/release.env KAPDH_DOCKER_NETWORK=kapdh-restore RELEASE_GATE=enforce sh <path>/run-release.sh production "$REL_IMG" </dev/null`.

`KAPDH_ENV=production` sengaja dipakai (run-release.sh hanya menerima `production|staging`): bawaan gerbangnya
`enforce` dan aturan pengecualian (alasan + penyetuju wajib) sama dengan production. Efek sampingnya hanya label
`lingkungan production` di log job drill.

**Mode gerbang gladi: `enforce`.** Alasan: (1) job production rilis ini berjalan `enforce` (bawaan production; runbook
rilis bagian 5 langkah 2 dan 5.5 langkah 2); (2) salinan pulihan = data production pada titik backup, jadi hasil
gerbang gladi memprediksi hasil gerbang production; (3) hanya `enforce` yang menjalankan gerbang pra-migrasi
`--preflight` dengan kode image baru terhadap skema 0008, jalur yang dilewati mode `report`. Bila `enforce` menolak:
**STOP**, catat pemeriksaan `[GAGAL]`; lanjut hanya setelah pemilik memutuskan (perbaiki konfigurasi production lalu
ulangi gladi dari Langkah 1, **atau** pemilik menyetujui pengecualian tertulis untuk production sesuai runbook rilis
5.3, lalu gladi diulang dengan Blok 4R memakai alasan yang sama).

### Blok 4: job rilis (dapat diulang; nomor job bertambah otomatis)

```sh
. /root/bukti-gladi-0009/vars.env
GATE=enforce; N=$(( $(ls "$BK"/job-rilis-*.log 2>/dev/null | wc -l) + 1 )); LOG="$BK/job-rilis-$N.log"
grep -q '@kapdh-drill-pg:5432/kapdh' "$ENVF" && [ "$(stat -c %a "$ENVF")" = 600 ] && echo "PASS env job = drill (kapdh-drill-pg), izin 600" || echo "FAIL env job bukan drill: STOP"
date -u +"%Y-%m-%dT%H:%M:%SZ langkah4-job-$N-mulai gerbang=$GATE" >> "$BK/timeline.txt"; T0=$(date -u +%s)
docker run --rm --network "$NET" --env-file "$ENVF" -e KAPDH_ENV=production -e RELEASE_GATE="$GATE" --security-opt no-new-privileges:true --cap-drop ALL --memory 512m --name kapdh-drill-release "$REL_IMG" </dev/null > "$LOG" 2>&1; RC=$?
echo "INFO job #$N: kode $RC, durasi $(( $(date -u +%s) - T0 )) detik" | tee -a "$BK/timeline.txt"
grep -E '^\[rilis\]|^\[migrate\]|^\[(LULUS|GAGAL)\]|^HASIL|✗' "$LOG"
[ "$RC" = 0 ] && echo "PASS job rilis gladi #$N (gerbang $GATE)" || echo "FAIL job rilis gladi #$N kode $RC: STOP"
```

Yang dicetak hanya baris langkah `[rilis]`, baris `[migrate]`, judul pemeriksaan `[LULUS]/[GAGAL]`, alasan penolakan
(`✗`) dan vonis; baris rincian `·` (nominal biaya, rekening tersamar, sidik QRIS) tetap hanya di berkas log (root 700).
Harapan job #1: `migrasi tercatat 9, journal image 11`, `pra-migrasi LULUS`, baris `[migrate] Migrasi selesai.` dengan
`Diterapkan: 2` dan `Total tercatat: 11`, `gerbang LULUS`, `selesai`.

Durasi job memberi gambaran lamanya simpan profil tertahan di production: kunci EXCLUSIVE 0009 dipegang sampai
transaksi migrasi commit, ditambah paling lama 15 detik per tabel (sekitar 45 detik untuk tiga tabel) menunggu kunci bila ada transaksi profil yang sedang
berjalan. Database drill tidak memiliki penulis lain, jadi gladi tidak menguji konkurensi maupun jalur `55P03`
(kunci tidak diperoleh dalam 15 detik). Jalur itu dibuktikan uji PostgreSQL 17
`apps/api/test/pg/migrate-and-seed.pg.test.ts`: job gagal `55P03`, skema dan journal tetap 0008, simpan profil yang
tertahan dilanjutkan, dan job ulang menerapkan 0009-0010.

### Blok 4R: hanya bila pemilik memutuskan pengecualian (bukan jalur normal)

```sh
. /root/bukti-gladi-0009/vars.env
GATE=report; export RELEASE_GATE_REASON="gladi 0009-0010 pada salinan pulihan; GANTI_DENGAN_PEMERIKSAAN_GAGAL" RELEASE_GATE_APPROVER="GANTI_DENGAN_NAMA_PEMILIK"
N=$(( $(ls "$BK"/job-rilis-*.log 2>/dev/null | wc -l) + 1 )); LOG="$BK/job-rilis-$N.log"; date -u +"%Y-%m-%dT%H:%M:%SZ langkah4-job-$N-mulai gerbang=$GATE" >> "$BK/timeline.txt"
docker run --rm --network "$NET" --env-file "$ENVF" -e KAPDH_ENV=production -e RELEASE_GATE="$GATE" -e RELEASE_GATE_REASON -e RELEASE_GATE_APPROVER --security-opt no-new-privileges:true --cap-drop ALL --memory 512m --name kapdh-drill-release "$REL_IMG" </dev/null > "$LOG" 2>&1; RC=$?
grep -E '^\[rilis\]|^\[migrate\]|^\[(LULUS|GAGAL)\]|^HASIL|✗' "$LOG"; [ "$RC" = 0 ] && echo "PASS job rilis gladi #$N (report, pengecualian tercatat)" || echo "FAIL job rilis gladi #$N kode $RC"; unset RELEASE_GATE_REASON RELEASE_GATE_APPROVER
```

### Blok 4B: laporan JSON gerbang (arsip bukti)

Perintah yang sama dengan runbook rilis bagian 4 langkah 7, diarahkan ke drill. JSON memuat nominal dan rekening
tersamar, jadi disimpan 600 dan hanya ringkasannya yang dicetak.

```sh
. /root/bukti-gladi-0009/vars.env
docker run --rm --network "$NET" --env-file "$ENVF" --entrypoint sh "$REL_IMG" -c 'DATABASE_URL="$MIGRATOR_DATABASE_URL" node dist/cli/golive-check.js --json' </dev/null > "$BK/golive-gladi.json" 2> "$BK/golive-gladi.err"; RC=$?; chmod 600 "$BK/golive-gladi.json"
T=$(grep -c '"ok": true' "$BK/golive-gladi.json"); F=$(grep -c '"ok": false' "$BK/golive-gladi.json")
[ "$RC" = 0 ] && [ "$F" = 0 ] && echo "PASS gerbang penuh JSON: ok=true $T, ok=false $F" || echo "FAIL gerbang JSON kode $RC, ok=false $F"
echo "INFO pemeriksaan: $(grep -o '"id": "[a-z_]*"' "$BK/golive-gladi.json" | sed 's/"id": //' | tr -d '"' | tr '\n' ' ')"
```

Harapan: kode 0, `ok=false 0`, `ok=true 11` (10 pemeriksaan + puncak).

## 8. Langkah 5: hitungan "sesudah", kolom lama tidak berubah, objek dan hak akses

### Blok 5A: berkas SQL sesudah migrasi

`selisih_baris` membuktikan **setiap** nilai lama yang disalin ada di daftar (bukan hanya jumlahnya);
`baris_daftar_tanpa_sumber` membuktikan daftar tidak memuat apa pun selain isi awal (khusus segera sesudah migrasi,
sebelum API baru menulis). `hash_0009`/`hash_0010` = hash yang dicatat migrator untuk berkas migrasi yang diterapkan.

```sh
. /root/bukti-gladi-0009/vars.env
tulis() { printf '%s\n' "$1" >> "$F"; }
F="$BK/sql/hitung-baru.sql"; : > "$F"
tulis "select 'pendidikan_baru=' || count(*) from app.alumni_education;"
tulis "select 'tautan_baru=' || count(*) from app.alumni_social_links;"
tulis "select 'profesi_baru=' || count(*) from app.alumni_profession_entries;"
tulis "select 'selisih_baris=' || ((select count(*) from app.alumni a cross join lateral (values ('instagram', a.social_instagram), ('x', a.social_x), ('facebook', a.social_facebook), ('linkedin', a.social_linkedin)) v(platform, value) where char_length(v.value) between 1 and 200 and not exists (select 1 from app.alumni_social_links l where l.alumni_user_id = a.user_id and l.platform = v.platform and l.value = v.value)) + (select count(*) from app.alumni a where btrim(coalesce(a.last_education_institution, '')) <> '' and not exists (select 1 from app.alumni_education e where e.alumni_user_id = a.user_id and e.institution = btrim(left(btrim(a.last_education_institution), 120)))) + (select count(*) from app.alumni_professions p where not exists (select 1 from app.alumni_profession_entries e where e.alumni_user_id = p.alumni_user_id and e.profession_id = p.profession_id)));"
tulis "select 'baris_daftar_tanpa_sumber=' || ((select count(*) from app.alumni_social_links l join app.alumni a on a.user_id = l.alumni_user_id where l.value is distinct from (case l.platform when 'instagram' then a.social_instagram when 'x' then a.social_x when 'facebook' then a.social_facebook when 'linkedin' then a.social_linkedin end)) + (select count(*) from app.alumni_education e join app.alumni a on a.user_id = e.alumni_user_id where e.position <> 0 or e.major is not null or e.level is not null or e.graduation_year is not null or e.institution is distinct from btrim(left(btrim(a.last_education_institution), 120))) + (select count(*) from app.alumni_profession_entries e where e.position <> 0 or e.label is not null or not exists (select 1 from app.alumni_professions p where p.alumni_user_id = e.alumni_user_id and p.profession_id = e.profession_id)));"
F="$BK/sql/hak.sql"; : > "$F"
tulis "select 'hak_dml_app_worker=' || count(*) from (values ('kapdh_app'), ('kapdh_worker')) r(rol) cross join (values ('app.alumni_education'), ('app.alumni_social_links'), ('app.alumni_profession_entries')) t(tbl) where has_table_privilege(r.rol, t.tbl, 'SELECT') and has_table_privilege(r.rol, t.tbl, 'INSERT') and has_table_privilege(r.rol, t.tbl, 'UPDATE') and has_table_privilege(r.rol, t.tbl, 'DELETE');"
tulis "select 'hak_truncate_app_worker=' || count(*) from (values ('kapdh_app'), ('kapdh_worker')) r(rol) cross join (values ('app.alumni_education'), ('app.alumni_social_links'), ('app.alumni_profession_entries')) t(tbl) where has_table_privilege(r.rol, t.tbl, 'TRUNCATE');"
tulis "select 'monitor_baca_daftar=' || count(*) from (values ('app.alumni_education'), ('app.alumni_social_links'), ('app.alumni_profession_entries')) t(tbl) where has_table_privilege('kapdh_monitor', t.tbl, 'SELECT');"
tulis "select 'backup_baca_daftar=' || count(*) from (values ('app.alumni_education'), ('app.alumni_social_links'), ('app.alumni_profession_entries')) t(tbl) where has_table_privilege('kapdh_backup', t.tbl, 'SELECT');"
tulis "select 'pemilik_migrator=' || count(*) from pg_tables where schemaname = 'app' and tablename in ('alumni_education', 'alumni_social_links', 'alumni_profession_entries') and tableowner = 'kapdh_migrator';"
tulis "select 'eksekusi_proyeksi_app=' || case when has_function_privilege('kapdh_app', 'app.alumni_project_legacy_profile(uuid)', 'EXECUTE') then 1 else 0 end;"
tulis "select 'trigger_tertunda=' || count(*) from pg_trigger where tgname in ('alumni_legacy_reproject', 'alumni_professions_legacy_reproject') and tgdeferrable and tginitdeferred;"
tulis "select 'hash_0009=' || coalesce((select hash from drizzle.__drizzle_migrations where created_at = 1792591532605), 'tidak-ada');"
tulis "select 'hash_0010=' || coalesce((select hash from drizzle.__drizzle_migrations where created_at = 1792591540265), 'tidak-ada');"
wc -l "$BK/sql/hitung-baru.sql" "$BK/sql/hak.sql"
```

### Blok 5B: versi skema, objek baru, hitungan sesudah = sebelum

```sh
. /root/bukti-gladi-0009/vars.env
sqlf() { docker run --rm -i --network "$NET" --env-file "$ENVF" "$PGIMG" sh -c 'psql "$MIGRATOR_DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=terse -f -' < "$1"; }
val() { sed -n "s/^$1=//p" "$2" | head -n 1; }; cek() { if [ "$2" = "$3" ]; then echo "PASS $1=$2"; else echo "FAIL $1: dapat '$2', harap '$3'"; fi; }
N=$(ls "$BK"/job-rilis-*.log | wc -l); S="$BK/skema-sesudah-$N.txt"; H="$BK/hitung-baru-$N.txt"; L="$BK/hitung-lama-sesudah-$N.txt"; B="$BK/skema-sebelum.txt"; L0="$BK/hitung-lama-sebelum.txt"
sqlf "$BK/sql/skema.sql" > "$S"; sqlf "$BK/sql/hitung-baru.sql" > "$H"; sqlf "$BK/sql/hitung-lama.sql" > "$L"; echo "INFO job #$N"; cat "$H"
cek migrasi_tercatat "$(val migrasi_tercatat "$S")" 11; cek migrasi_terakhir "$(val migrasi_terakhir "$S")" 1792591540265
cek tabel_daftar_baru "$(val tabel_daftar_baru "$S")" 3; cek fungsi_baru "$(val fungsi_baru "$S")" 10; cek trigger_baru "$(val trigger_baru "$S")" 7
cek tabel_app_bertambah "$(( $(val tabel_app "$S") - $(val tabel_app "$B") ))" 3; cek trigger_total_bertambah "$(( $(val trigger_total "$S") - $(val trigger_total "$B") ))" 7
cek pendidikan_baru "$(val pendidikan_baru "$H")" "$(val pendidikan "$L0")"; cek tautan_baru "$(val tautan_baru "$H")" "$(val tautan "$L0")"; cek profesi_baru "$(val profesi_baru "$H")" "$(val profesi "$L0")"
cek selisih_baris "$(val selisih_baris "$H")" 0; cek baris_daftar_tanpa_sumber "$(val baris_daftar_tanpa_sumber "$H")" 0
R55S=$(sqlf "$BK/sql/runbook55-sesudah.sql"); echo "runbook_5_5_sesudah=$R55S" | tee "$BK/runbook55-sesudah-$N.txt"
PD=$(val pendidikan "$L0"); TA=$(val tautan "$L0"); PR=$(val profesi "$L0"); cek runbook_5_5_sesudah "$R55S" "$PD|$PD|$TA|$TA|$PR|$PR"
cmp -s "$L0" "$L" && echo "PASS hitungan kolom lama sama dengan sebelum migrasi" || echo "FAIL hitungan kolom lama berubah"
```

`runbook_5_5_sesudah` = kueri runbook rilis 5.5 langkah 2 (urutan `pendidikan|pendidikan_baru|tautan|tautan_baru|
profesi|profesi_baru`): setiap pasangan sama, dan sama dengan hitungan sebelum migrasi.

### Blok 5C: kolom lama tidak berubah (sidik), hak akses tabel baru, trigger tertunda, hash migrasi

```sh
. /root/bukti-gladi-0009/vars.env
sqlf() { docker run --rm -i --network "$NET" --env-file "$ENVF" "$PGIMG" sh -c 'psql "$MIGRATOR_DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=terse -f -' < "$1"; }
val() { sed -n "s/^$1=//p" "$2" | head -n 1; }; cek() { if [ "$2" = "$3" ]; then echo "PASS $1=$2"; else echo "FAIL $1: dapat '$2', harap '$3'"; fi; }
N=$(ls "$BK"/job-rilis-*.log | wc -l); G="$BK/hak-$N.txt"; sqlf "$BK/sql/hak.sql" > "$G"; sqlf "$BK/sql/sidik.sql" > "$BK/sidik-sesudah-$N.txt"
cmp -s "$BK/sidik-sebelum.txt" "$BK/sidik-sesudah-$N.txt" && echo "PASS sidik alumni/alumni_professions/master_professions sama dengan sebelum migrasi" || echo "FAIL sidik berubah"
cek hak_dml_app_worker "$(val hak_dml_app_worker "$G")" 6; cek hak_truncate_app_worker "$(val hak_truncate_app_worker "$G")" 0; cek monitor_baca_daftar "$(val monitor_baca_daftar "$G")" 0
cek backup_baca_daftar "$(val backup_baca_daftar "$G")" 3; cek pemilik_migrator "$(val pemilik_migrator "$G")" 3; cek eksekusi_proyeksi_app "$(val eksekusi_proyeksi_app "$G")" 1; cek trigger_tertunda "$(val trigger_tertunda "$G")" 2
cek hash_0009 "$(val hash_0009 "$G")" "$H9"; cek hash_0010 "$(val hash_0010 "$G")" "$H10"
```

Arti: API (`kapdh_app`) dan worker (`kapdh_worker`) mendapat DML penuh tanpa TRUNCATE pada ketiga tabel (`roles.sql`
bagian 3 + default privileges); `kapdh_monitor` tidak membaca tabel profil; `kapdh_backup` membaca lewat
`pg_read_all_data` sehingga backup malam berikutnya memuat tabel baru [A-11]; pemilik objek `kapdh_migrator`;
kedua trigger proyeksi ulang `DEFERRABLE INITIALLY DEFERRED`; migrator mencatat hash berkas 0009/0010 yang sama dengan
isi image (Blok 0.4).

## 9. Langkah 6: uji jembatan penulis lama di dalam transaksi yang di-ROLLBACK

**Desain.** Image API lama menulis kolom lama tanpa penanda `kapdh.profile_lists`. Trigger jembatan (baris, `AFTER`,
langsung) menerapkan tulisan itu ke daftar; proyeksi ulang kolom lama berjalan lewat constraint trigger `DEFERRED`
saat commit. Transaksi yang di-ROLLBACK tidak pernah commit, tetapi `SET CONSTRAINTS ALL IMMEDIATE` menembakkan semua
event trigger tertunda saat perintah itu dijalankan (semantik PostgreSQL untuk constraint yang ditunda) [A-12]. Jadi
semantik "saat commit" dapat diperiksa tanpa commit, lalu `ROLLBACK` membuang semuanya, termasuk di salinan drill.
Baris alumni sintetis **tidak** diperlukan bila ada alumni; bila salinan tidak memuat alumni sama sekali, skrip membuat
satu akun + alumni sintetis **di dalam transaksi yang sama** (ikut dibatalkan), sehingga tidak ada langkah buat-lalu-
hapus dan tidak ada sisa (email `.invalid` tidak pernah tersimpan, gerbang `dev_fixtures` tidak tersentuh).

Uji berjalan sebagai `kapdh_app` lewat TCP dengan sandi drill (sama dengan cara API terhubung), dari jaringan drill.
Urutan: tulis kolom lama (sosial, pendidikan, dan profesi hapus-lalu-sisip seperti `replaceProfession` image lama) →
periksa daftar (jembatan) → `SET CONSTRAINTS ALL IMMEDIATE` → periksa kolom lama dan `alumni_professions` (proyeksi
saat commit) → set penanda API dan tulis lagi → jembatan harus diam → `ROLLBACK` → penanda tidak bocor.

### Blok 6A: tulis jembatan.sql

```sh
. /root/bukti-gladi-0009/vars.env
tulis() { printf '%s\n' "$1" >> "$F"; }; F="$BK/sql/jembatan.sql"; : > "$F"
tulis "begin;"
tulis "select case when current_user = 'kapdh_app' and coalesce(current_setting('kapdh.profile_lists', true), '') = '' then 'PASS sesi kapdh_app tanpa penanda API (meniru image API lama)' else 'FAIL sesi bukan kapdh_app atau penanda terpasang' end;"
tulis "select (count(*) > 0) as ada_alumni from app.alumni \gset"
tulis "\if :ada_alumni"
tulis "select user_id as uid from app.alumni order by user_id limit 1 \gset"
tulis "select 'INFO memakai satu baris alumni yang ada (id tidak dicetak)';"
tulis "\else"
tulis "insert into app.users (id, email, password_hash, kind) values (gen_random_uuid(), 'gladi-0009@gladi.invalid', 'gladi-bukan-hash', 'alumni') returning id as uid \gset"
tulis "insert into app.alumni (user_id, full_name, gender, cohort, class_in, class_out) values (:'uid', 'Gladi Sintetis', 'male', 12, 1, 6);"
tulis "select 'INFO tidak ada alumni: memakai baris sintetis di dalam transaksi ini (ikut dibatalkan)';"
tulis "\endif"
tulis "select (count(*) > 0) as ada_master from app.master_professions m where m.active and not exists (select 1 from app.alumni_professions p where p.alumni_user_id = :'uid' and p.profession_id = m.id) \gset"
tulis "update app.alumni set social_instagram = 'gladi.0009.uji', last_education_institution = 'Institut Gladi 0009' where user_id = :'uid';"
tulis "\if :ada_master"
tulis "select m.id as pbaru from app.master_professions m where m.active and not exists (select 1 from app.alumni_professions p where p.alumni_user_id = :'uid' and p.profession_id = m.id) order by m.id limit 1 \gset"
tulis "delete from app.alumni_professions where alumni_user_id = :'uid';"
tulis "insert into app.alumni_professions (alumni_user_id, profession_id) values (:'uid', :'pbaru');"
tulis "\endif"
wc -l "$F"
```

### Blok 6A-2: lanjutan jembatan.sql (pemeriksaan dan ROLLBACK)

```sh
. /root/bukti-gladi-0009/vars.env
tulis() { printf '%s\n' "$1" >> "$F"; }; F="$BK/sql/jembatan.sql"
tulis "select case when (select value from app.alumni_social_links where alumni_user_id = :'uid' and platform = 'instagram' order by position limit 1) = 'gladi.0009.uji' then 'PASS jembatan: tautan Instagram pertama mengikuti kolom lama' else 'FAIL jembatan: tautan Instagram' end;"
tulis "select case when (select institution from app.alumni_education where alumni_user_id = :'uid' order by position limit 1) = 'Institut Gladi 0009' then 'PASS jembatan: pendidikan teratas mengikuti kolom lama' else 'FAIL jembatan: pendidikan teratas' end;"
tulis "\if :ada_master"
tulis "select case when (select profession_id from app.alumni_profession_entries where alumni_user_id = :'uid' order by position limit 1) = :'pbaru'::uuid then 'PASS jembatan: profesi baru menjadi profesi utama daftar' else 'FAIL jembatan: profesi' end;"
tulis "\else"
tulis "select 'INFO tidak ada master profesi aktif lain: uji profesi dilewati';"
tulis "\endif"
tulis "set constraints all immediate;"
tulis "select case when a.social_instagram = 'gladi.0009.uji' and a.last_education_institution = 'Institut Gladi 0009' and a.social_instagram = (select l.value from app.alumni_social_links l where l.alumni_user_id = a.user_id and l.platform = 'instagram' order by l.position limit 1) then 'PASS saat commit: kolom lama = proyeksi daftar' else 'FAIL saat commit: proyeksi kolom lama' end from app.alumni a where a.user_id = :'uid';"
tulis "\if :ada_master"
tulis "select case when (select count(*) from app.alumni_professions where alumni_user_id = :'uid') = 1 and (select profession_id from app.alumni_professions where alumni_user_id = :'uid' limit 1) = :'pbaru'::uuid then 'PASS saat commit: alumni_professions = profesi utama daftar' else 'FAIL saat commit: alumni_professions' end;"
tulis "\endif"
tulis "select set_config('kapdh.profile_lists', 'api', true) as penanda \gset"
tulis "update app.alumni set social_x = 'gladi.api.x' where user_id = :'uid';"
tulis "select case when not exists (select 1 from app.alumni_social_links where alumni_user_id = :'uid' and value = 'gladi.api.x') then 'PASS penanda API: jembatan diam untuk tulisan API baru' else 'FAIL penanda API' end;"
tulis "rollback;"
tulis "select case when coalesce(current_setting('kapdh.profile_lists', true), '') = '' then 'PASS penanda tidak bocor sesudah ROLLBACK' else 'FAIL penanda bocor' end;"
wc -l "$F"
```

Harapan `wc -l`: 18 baris sesudah Blok 6A, 35 sesudah Blok 6A-2 (bila diulang, jalankan 6A lalu 6A-2 lagi; 6A
mengosongkan berkas).

### Blok 6B: jalankan sebagai kapdh_app, lalu buktikan tidak ada perubahan permanen

```sh
. /root/bukti-gladi-0009/vars.env
sqlf() { docker run --rm -i --network "$NET" --env-file "$ENVF" "$PGIMG" sh -c 'psql "$MIGRATOR_DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=terse -f -' < "$1"; }
date -u +"%Y-%m-%dT%H:%M:%SZ langkah6-jembatan" >> "$BK/timeline.txt"
docker run --rm -i --network "$NET" --env-file "$ENVF" "$PGIMG" sh -c 'psql "postgres://kapdh_app:${KAPDH_APP_DB_PASSWORD}@kapdh-drill-pg:5432/kapdh" -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=terse -f -' < "$BK/sql/jembatan.sql" > "$BK/jembatan.txt" 2>&1; RC=$?; cat "$BK/jembatan.txt"
[ "$RC" = 0 ] && [ "$(grep -c '^FAIL' "$BK/jembatan.txt")" = 0 ] && [ "$(grep -c '^PASS' "$BK/jembatan.txt")" -ge 6 ] && echo "PASS uji jembatan (kode $RC)" || echo "FAIL uji jembatan (kode $RC)"
N=$(ls "$BK"/job-rilis-*.log | wc -l); sqlf "$BK/sql/sidik.sql" > "$BK/sidik-sesudah-jembatan.txt"; cmp -s "$BK/sidik-sebelum.txt" "$BK/sidik-sesudah-jembatan.txt" && echo "PASS tidak ada perubahan permanen pada kolom lama (ROLLBACK)" || echo "FAIL ada perubahan permanen pada kolom lama"
sqlf "$BK/sql/hitung-baru.sql" > "$BK/hitung-baru-sesudah-jembatan.txt"; cmp -s "$BK/hitung-baru-$N.txt" "$BK/hitung-baru-sesudah-jembatan.txt" && echo "PASS isi daftar baru tidak berubah permanen" || echo "FAIL daftar baru berubah"
sqlf "$BK/sql/hitung-lama.sql" > "$BK/hitung-lama-sesudah-jembatan.txt"; cmp -s "$BK/hitung-lama-sebelum.txt" "$BK/hitung-lama-sesudah-jembatan.txt" && echo "PASS jumlah alumni dan akun tidak berubah" || echo "FAIL jumlah alumni/akun berubah"
```

Harapan: 6 PASS (8 bila ada master profesi aktif lain), 0 FAIL, satu atau dua baris INFO; tiga pemeriksaan sesudahnya
PASS. Bila psql berhenti dengan galat `check_violation` `*_limit_chk` (daftar penuh), itu perilaku yang benar untuk
alumni dengan 10 tautan; pada data sebelum rilis hal itu tidak terjadi karena belum ada penulis daftar baru.

## 10. Langkah 7: gladi pembatalan darurat, lalu penerapan ulang

Runbook rilis 5.5 langkah 6: rollback image lebih dahulu (di drill tidak ada API/worker yang berjalan), dump database,
lalu skrip pembatalan dari image rilis baru sebagai `kapdh_migrator` dalam satu transaksi (`psql -1`).

### Blok 7A: dump pra-pembatalan (melatih perintah dump runbook rilis 5.5 langkah 1.3 dan P.3)

Perintah sama dengan `remote-migrate.sh` `backup_before_migration`: `pg_dump --format=custom --compress=6` dari
kontainer image PostgreSQL dengan URL superuser lewat env, lalu `pg_restore --list` di jaringan `none`.

```sh
. /root/bukti-gladi-0009/vars.env
umask 077; F=/var/restore/kapdh/gladi-pra-pembatalan.dump
docker run --rm --network "$NET" --env-file "$ENVF" "$PGIMG" sh -c 'exec pg_dump --format=custom --compress=6 --dbname="$ADMIN_DATABASE_URL"' </dev/null > "$F"; RC=$?
TOC=$(docker run --rm -i --network none "$PGIMG" pg_restore --list < "$F" | grep -c '^[0-9]')
[ "$RC" = 0 ] && [ "$TOC" -gt 0 ] && echo "PASS dump pra-pembatalan $(wc -c < "$F") byte, $TOC entri TOC, sha256 $(sha256sum "$F" | cut -c1-12) (dimusnahkan di Langkah 9)" || echo "FAIL dump pra-pembatalan (kode $RC, TOC $TOC)"
```

### Blok 7B: jalankan skrip pembatalan (perintah runbook rilis 5.5 langkah 6, jaringan dan env drill)

```sh
. /root/bukti-gladi-0009/vars.env
RB=$(docker run --rm --entrypoint sha256sum "$REL_IMG" /app/infra/db/rollback/0009-0010-profile-lists.sql </dev/null | cut -c1-64)
if [ "$RB" = af72884cd45f07cf710766bc6a11c23a70ade2bae090989977dd9bd63cc896c8 ]; then echo "PASS skrip pembatalan = versi yang ditinjau"; date -u +"%Y-%m-%dT%H:%M:%SZ langkah7-pembatalan" >> "$BK/timeline.txt"; docker run --rm --network "$NET" --env-file "$ENVF" --entrypoint sh "$REL_IMG" -c 'psql "$MIGRATOR_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v VERBOSITY=terse -1 -f /app/infra/db/rollback/0009-0010-profile-lists.sql' </dev/null > "$BK/pembatalan.log" 2>&1; RC=$?; [ "$RC" = 0 ] && echo "PASS skrip pembatalan selesai (satu transaksi, kapdh_migrator)" || echo "FAIL skrip pembatalan kode $RC"; echo "INFO perintah DROP: $(grep -c '^DROP' "$BK/pembatalan.log") (harap 17), DELETE: $(grep '^DELETE' "$BK/pembatalan.log")"; else echo "FAIL skrip pembatalan di image berbeda ($RB): STOP, tinjau dulu"; fi
```

Harapan: 17 `DROP` (4 trigger, 10 fungsi, 3 tabel) dan `DELETE 2` (catatan journal 0009 dan 0010).

### Blok 7C: bentuk skema kembali ke 0008, kolom lama utuh

```sh
. /root/bukti-gladi-0009/vars.env
sqlf() { docker run --rm -i --network "$NET" --env-file "$ENVF" "$PGIMG" sh -c 'psql "$MIGRATOR_DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=terse -f -' < "$1"; }
val() { sed -n "s/^$1=//p" "$2" | head -n 1; }; cek() { if [ "$2" = "$3" ]; then echo "PASS $1=$2"; else echo "FAIL $1: dapat '$2', harap '$3'"; fi; }
S="$BK/skema-pembatalan.txt"; B="$BK/skema-sebelum.txt"; sqlf "$BK/sql/skema.sql" > "$S"; sqlf "$BK/sql/sidik.sql" > "$BK/sidik-pembatalan.txt"; sqlf "$BK/sql/hitung-lama.sql" > "$BK/hitung-lama-pembatalan.txt"
for k in migrasi_tercatat migrasi_terakhir tabel_app tabel_daftar_baru fungsi_baru trigger_baru trigger_total; do cek "$k" "$(val $k "$S")" "$(val $k "$B")"; done
cmp -s "$BK/sidik-sebelum.txt" "$BK/sidik-pembatalan.txt" && echo "PASS kolom lama, alumni_professions dan master_professions utuh sesudah pembatalan" || echo "FAIL sidik berubah sesudah pembatalan"
cmp -s "$BK/hitung-lama-sebelum.txt" "$BK/hitung-lama-pembatalan.txt" && echo "PASS hitungan kolom lama sama dengan sebelum migrasi" || echo "FAIL hitungan kolom lama berubah"
```

Harapan: semua nilai sama dengan "sebelum" (9 migrasi, terakhir `1792062113847`, 0 tabel/fungsi/trigger baru).

### Blok 7D: penerapan ulang

Jalankan ulang **Blok 4** (job #2), lalu **Blok 5B** dan **Blok 5C** (nomor job otomatis 2). Tambahan bukti:

```sh
. /root/bukti-gladi-0009/vars.env
grep -q 'migrasi tercatat 9, journal image 11' "$BK/job-rilis-2.log" && echo "PASS job #2 mulai dari skema 0008 (9 migrasi)" || echo "FAIL job #2 tidak mulai dari 9 migrasi"
cmp -s "$BK/hitung-baru-1.txt" "$BK/hitung-baru-2.txt" && echo "PASS isi awal ulang = isi awal pertama" || echo "FAIL isi awal ulang berbeda"
```

Ini membuktikan kalimat skrip pembatalan "Bila 0009-0010 diterapkan lagi kelak, daftar diisi ulang dari kolom lama".

## 11. Langkah 8 (opsional): API image baru satu replika di jaringan drill

Seperti drill Oktober: satu replika, tanpa worker, tanpa Redis, hanya di `kapdh-restore`. Jaringan `--internal`
sengaja tanpa port terbit, jadi "127.0.0.1" berarti loopback **di dalam** kontainer API: readiness dipanggil dengan
`docker exec` + `fetch` Node (Node ada di image API) [A-9]. Syarat: Blok 7D sudah dijalankan (skema 11). Tidak perlu
login.

```sh
. /root/bukti-gladi-0009/vars.env
docker inspect kapdh-drill-api >/dev/null 2>&1 || docker run -d --name kapdh-drill-api --network "$NET" --env-file "$D/api.env" -v /srv/kapdh/drill/files:/data/files --memory 768m --security-opt no-new-privileges:true --cap-drop ALL "$API_IMG" </dev/null >/dev/null
i=0; until docker exec kapdh-drill-api node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; do i=$((i+1)); [ "$i" -ge 30 ] && break; sleep 2; done
docker exec kapdh-drill-api node -e "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(async r=>console.log('ready_status='+r.status+' '+await r.text()),e=>console.log('ready_galat='+e.name))" | tee "$BK/api-ready.txt"
docker exec kapdh-drill-api node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>r.json()).then(j=>console.log('commit='+j.commit),e=>console.log('galat='+e.name))" | tee "$BK/api-health.txt"
grep -q 'ready_status=200' "$BK/api-ready.txt" && grep -q '"deletion_ledger":"ok"' "$BK/api-ready.txt" && echo "PASS readiness API drill 200, deletion_ledger ok" || echo "FAIL readiness API drill (docker logs --tail 30 kapdh-drill-api)"
grep -q "commit=$MERGE_SHA" "$BK/api-health.txt" && echo "PASS API drill menjalankan MERGE_SHA" || echo "FAIL commit API drill"
echo "INFO API drill: jaringan $(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' kapdh-drill-api), port terbit $(docker port kapdh-drill-api | wc -l), $(docker stats --no-stream --format '{{.MemUsage}}' kapdh-drill-api)"
docker rm -f kapdh-drill-api >/dev/null && echo "INFO API drill dihentikan"
```

Harapan `ready_status=200` dengan `database=ok`, `redis=skipped`, `storage=ok`, `deletion_ledger=ok` (sama dengan drill
Oktober). Log kontainer hanya memuat nama variabel bila validasi env gagal, bukan nilainya.

## 12. Langkah 9: pemusnahan lingkungan drill

### Blok 9A: salin bukti tanpa data pribadi

Seperti drill Oktober: `summary.txt`, `timeline.txt`, `restore.log`, `verify-report.txt`, `outbox.txt`,
`manifest.json`, `ledger-reapply.log` (hanya nomor permintaan dan jumlah). Folder `ledger/` **tidak** disalin.

```sh
. /root/bukti-gladi-0009/vars.env
install -d -m 700 "$BK/restore"; for f in summary.txt timeline.txt restore.log verify-report.txt outbox.txt manifest.json ledger-reapply.log; do [ -f "$EVR/$f" ] && cp "$EVR/$f" "$BK/restore/$f"; done; echo "INFO disalin: $(ls "$BK/restore" | tr '\n' ' ')"
```

### Blok 9B: musnahkan (aman dijalankan kapan saja, juga saat membatalkan gladi)

```sh
. /root/bukti-gladi-0009/vars.env
docker rm -f kapdh-drill-api kapdh-drill-release kapdh-drill-pg >/dev/null 2>&1; docker volume rm kapdh-drill-pgdata >/dev/null 2>&1; docker network rm kapdh-restore >/dev/null 2>&1
rm -rf /srv/kapdh/drill /var/restore/kapdh
[ -d /etc/kapdh/drill ] && find /etc/kapdh/drill -type f -exec shred -u {} \;
rm -rf /etc/kapdh/drill; date -u +"%Y-%m-%dT%H:%M:%SZ pemusnahan" | tee "$BK/pemusnahan.txt"
```

`/var/restore/kapdh` memuat salinan ledger, dump pra-pembatalan dan cache restic; `/srv/kapdh/drill` memuat salinan
berkas production; volume memuat database pulihan; `/etc/kapdh/drill` memuat secret drill (di-shred).

### Blok 9C: buktikan tidak ada yang tersisa dan production tetap sehat

```sh
. /root/bukti-gladi-0009/vars.env
K=$(docker ps -aq --filter name=kapdh-drill | wc -l); V=$(docker volume ls -q --filter name=kapdh-drill | wc -l); J=$(docker network ls -q --filter name=kapdh-restore | wc -l)
[ "$K$V$J" = 000 ] && echo "PASS 0 kontainer, 0 volume, 0 jaringan drill" | tee -a "$BK/pemusnahan.txt" || echo "FAIL sisa: kontainer=$K volume=$V jaringan=$J" | tee -a "$BK/pemusnahan.txt"
for p in /srv/kapdh/drill /var/restore/kapdh /etc/kapdh/drill; do [ -e "$p" ] && echo "FAIL masih ada $p" || echo "PASS hilang $p"; done | tee -a "$BK/pemusnahan.txt"
N=$(docker ps --format '{{.Image}} {{.Status}}' | grep -E '/kapdh-(api|worker|web|admin):' | grep -c '(healthy)'); [ "$N" -ge 4 ] && echo "PASS production tetap healthy ($N)" || echo "FAIL production healthy $N"
C=$(curl -s -o /dev/null -w '%{http_code}' https://api.kapdh.or.id/api/v1/health/ready); [ "$C" = 200 ] && echo "PASS readiness production 200" || echo "FAIL readiness production $C"
```

Image yang ditarik (`kapdh-release`, `kapdh-api` baru) **dibiarkan**: dipakai rilis production.

## 13. Langkah 10: bukti dan kondisi STOP

### Yang ditempel kembali (hanya baris PASS/FAIL/INFO dan angka)

| Langkah | Tempel                                                                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 0       | semua baris Blok 0.1 sampai 0.4 (termasuk digest image rilis dan sha256 0009/0010)                                                             |
| 1       | baris PASS/FAIL, `backup_id`, `db_snapshot`, `files_snapshot`, `db_snapshot_captured_at`                                                       |
| 2       | baris PASS/FAIL Blok 2A-cek, 2B, 2C, 2D; isi `verify-report.txt` (baris PASS/WARN/FAIL/INFO); `restore_seconds`, `backup_age_at_start_seconds` |
| 3       | `runbook_5_5(...)=`, isi `hitung-lama-sebelum.txt`, `sidik-sebelum.txt`, baris cek dan `transaksi_lama`                                        |
| 4       | keluaran Blok 4 (baris `[rilis]`, `[migrate]`, `[LULUS]/[GAGAL]`, vonis, durasi) dan ringkasan Blok 4B                                         |
| 5       | keluaran Blok 5B (termasuk `runbook_5_5_sesudah=`) dan 5C                                                                                      |
| 6       | isi `jembatan.txt` dan tiga baris sesudahnya                                                                                                   |
| 7       | keluaran Blok 7A, 7B, 7C, job #2 (Blok 4), 5B/5C #2, 7D                                                                                        |
| 8       | `ready_status=...`, `commit=...`, baris PASS/FAIL (opsional)                                                                                   |
| 9       | isi `pemusnahan.txt` dan dua baris production sehat                                                                                            |

**Jangan** menempel: log job lengkap, `golive-gladi.json`, `restore.log` lengkap, `ledger-reapply.log`, isi berkas env.
Paket bukti tetap di `/root/bukti-gladi-0009/` (root 700); salinan ringkas tanpa data pribadi dapat dimasukkan ke
`docs/qa/` setelah gladi (format seperti `docs/qa/restore-drills/2026-10/README.md`).

### STOP: jangan lanjut, dan jangan menjalankan rilis production

1. Blok mana pun mencetak `FAIL`.
2. Production tidak sehat sebelum, selama atau sesudah gladi, atau RAM tersedia turun di bawah ±500 MB selama gladi:
   hentikan, jalankan Blok 9B segera.
3. Backup baru gagal atau lebih tua dari 15 menit; restore.sh kode ≠ 0; `verify-report.txt` memuat FAIL; backup_id
   restore ≠ backup baru.
4. Skema salinan bukan 9 migrasi / `1792062113847`, atau tabel/fungsi/trigger 0009-0010 sudah ada.
5. `tautan_dilewati` > 0: isi awal melewatkan nilai lama itu (tidak tampil di daftar, dan kolom lamanya dikosongkan
   begitu tautan, pendidikan atau profesi anggota itu disimpan lagi). Perlu keputusan pemilik sebelum production.
6. Image rilis: `KAPDH_COMMIT` ≠ `MERGE_SHA`, journal ≠ 11, 0009 tanpa `lock_timeout` 15 detik, sha256 0009/0010 ≠
   hasil `git show` merge, atau sha256 skrip pembatalan ≠ nilai yang ditinjau.
7. Job rilis gladi kode ≠ 0 pada fase apa pun, termasuk gerbang `enforce` menolak (keputusan pemilik, bagian 7).
8. Hitungan sesudah ≠ sebelum, pasangan `runbook_5_5_sesudah` tidak sama, `selisih_baris` ≠ 0,
   `baris_daftar_tanpa_sumber` ≠ 0, sidik berubah, objek/hak/trigger tertunda/hash migrasi tidak sesuai, atau journal
   ≠ 11 / `1792591540265`.
9. Uji jembatan: ada FAIL, psql galat, atau ada perubahan permanen sesudah ROLLBACK.
10. Pembatalan: skrip gagal, bentuk skema tidak kembali ke 0008, sidik berubah, atau penerapan ulang gagal/berbeda.
11. (Opsional) API drill tidak `200`/`deletion_ledger ok` atau commit ≠ `MERGE_SHA`.
12. Pemusnahan menyisakan kontainer, volume, jaringan atau direktori drill.

## 14. Rilis production sesudah gladi lulus: **BUTUH PERSETUJUAN TERTULIS PEMILIK**

> Bagian ini kerangka, bukan izin. Jangan dijalankan sebelum pemilik produk menyatakan secara tertulis "GO rilis profil
> berulang 0009-0010" dengan tanggal, jam dan nama, setelah meninjau paket bukti gladi. Jalur: manual
> (`run-release.sh` atau padanannya, runbook rilis bagian 5 langkah 2 dan 5.5), bila production dideploy manual
> lewat Coolify.

**Prasyarat**

- Gladi lulus seluruhnya dengan **digest image rilis yang sama** (P.1 memeriksanya).
- Isi `main` antara commit yang sekarang berjalan di production (dibaca di P.1) dan `MERGE_SHA` ditinjau: perubahan
  lain yang sudah ter-merge ikut terbit bersama rilis ini.
- Jendela jam sepi, di luar 18:45 sampai 20:00 UTC. Simpan profil tertahan selama transaksi migrasi (durasi job gladi
  sebagai gambaran) ditambah paling lama 15 detik per tabel (sekitar 45 detik untuk tiga tabel) menunggu kunci; baca tetap berjalan.
- Tidak ada `docker pull`/redeploy Coolify ke `sha-<MERGE_SHA>` sebelum P.6 lulus (aplikasi baru membutuhkan tabel
  baru).

### P.1: digest sama dengan gladi, env job, catat image sekarang (untuk rollback)

```sh
. /root/bukti-gladi-0009/vars.env; BKP=/root/bukti-rilis-0009; install -d -m 700 "$BKP"
docker pull -q "$REL_IMG" </dev/null >/dev/null; G=$(sed -n 's/^REL_DIGEST=//p' "$BK/digest-rilis.txt"); P=$(docker image inspect -f '{{index .RepoDigests 0}}' "$REL_IMG"); [ -n "$G" ] && [ "$G" = "$P" ] && echo "PASS image rilis = digest yang digladikan" || echo "FAIL digest image rilis berbeda dari gladi: STOP"
F=/etc/kapdh/production/release.env; [ "$(stat -c %a "$F")" = 600 ] && echo "PASS izin release.env 600" || echo "FAIL izin release.env"; echo "INFO kunci release.env: $(sed -n 's/=.*//p' "$F" | tr '\n' ' ')"
grep -q '^RELEASE_GATE' "$F" && echo "FAIL release.env memuat RELEASE_GATE*: hapus dulu (mode diatur pemanggil), STOP" || echo "PASS release.env tanpa RELEASE_GATE*"
docker ps --format '{{.Image}}' | grep -E '/kapdh-(api|worker|web|admin):' | tee "$BKP/image-sebelum.txt"; date -u +"%Y-%m-%dT%H:%M:%SZ P1" >> "$BKP/timeline.txt"
```

### P.2: backup baru

```sh
. /root/bukti-gladi-0009/vars.env; BKP=/root/bukti-rilis-0009
systemctl start kapdh-backup.service </dev/null
R=$(systemctl show -p Result --value kapdh-backup.service); S=$(systemctl show -p ExecMainStatus --value kapdh-backup.service)
WD=$(sed -n 's/^WORK_DIR=//p' /etc/kapdh/backup.env | tr -d "\"'"); WD=${WD:-/var/backups/kapdh}; cp "$WD/status/last-success" "$BKP/backup-last-success.txt"
AGE=$(( $(date -u +%s) - $(sed -n 's/^finished_epoch=//p' "$BKP/backup-last-success.txt") ))
[ "$R" = success ] && [ "$S" = 0 ] && [ "$AGE" -lt 900 ] && echo "PASS backup baru $(sed -n 's/^backup_id=//p' "$BKP/backup-last-success.txt") selesai ${AGE}s lalu" || echo "FAIL backup: Result=$R status=$S umur=${AGE}s: STOP"
```

### P.3: dump pra-migrasi (runbook rilis 5.5 langkah 1.3)

Jalur manual tidak membuat dump pra-migrasi (hanya `remote-migrate.sh` yang membuatnya), jadi langkah ini memakai
perintah runbook rilis 5.5 langkah 1.3 (dilatih di Blok 7A) dengan direktori dan nama berkas yang sama.

```sh
. /root/bukti-gladi-0009/vars.env; BKP=/root/bukti-rilis-0009; NET=coolify; ENVF=/etc/kapdh/production/release.env
umask 077; DD=/var/backups/kapdh/premigrate-manual; install -d -m 700 "$DD"; F="$DD/kapdh-production-premigrate-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker run --rm --network "$NET" --env-file "$ENVF" "$PGIMG" sh -c 'exec pg_dump --format=custom --compress=6 --dbname="$ADMIN_DATABASE_URL"' </dev/null > "$F.partial"; RC=$?
TOC=$(docker run --rm -i --network none "$PGIMG" pg_restore --list < "$F.partial" | grep -c '^[0-9]')
if [ "$RC" = 0 ] && [ "$TOC" -gt 0 ]; then mv "$F.partial" "$F"; sha256sum "$F" > "$F.sha256"; echo "PASS dump pra-migrasi $(basename "$F") $(wc -c < "$F") byte, $TOC entri TOC, sha256 $(cut -c1-12 "$F.sha256")" | tee -a "$BKP/dump.txt"; else rm -f "$F.partial"; echo "FAIL dump pra-migrasi: JANGAN jalankan job rilis"; fi
```

Dump berisi data pribadi (D2): mode 600, simpan paling lama 7 hari (sama dengan dump pra-migrasi otomatis), lalu
`shred -u`.

### P.4: hitungan "sebelum" production (baca saja)

```sh
. /root/bukti-gladi-0009/vars.env; BKP=/root/bukti-rilis-0009; NET=coolify; ENVF=/etc/kapdh/production/release.env
sqlf() { docker run --rm -i --network "$NET" --env-file "$ENVF" "$PGIMG" sh -c 'psql "$MIGRATOR_DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=terse -f -' < "$1"; }
sqla() { docker run --rm -i --network "$NET" --env-file "$ENVF" "$PGIMG" sh -c 'psql "$ADMIN_DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=terse -f -' < "$1"; }
val() { sed -n "s/^$1=//p" "$2" | head -n 1; }; cek() { if [ "$2" = "$3" ]; then echo "PASS $1=$2"; else echo "FAIL $1: dapat '$2', harap '$3'"; fi; }
S="$BKP/skema-sebelum.txt"; L="$BKP/hitung-lama-sebelum.txt"; sqlf "$BK/sql/skema.sql" > "$S"; sqlf "$BK/sql/hitung-lama.sql" > "$L"; sqlf "$BK/sql/sidik.sql" > "$BKP/sidik-sebelum.txt"
R55=$(sqlf "$BK/sql/runbook55.sql"); echo "runbook_5_5(pendidikan|tautan|profesi)=$R55" | tee "$BKP/runbook55-sebelum.txt"; cat "$L"
cek migrasi_tercatat "$(val migrasi_tercatat "$S")" 9; cek migrasi_terakhir "$(val migrasi_terakhir "$S")" 1792062113847; cek tabel_daftar_baru "$(val tabel_daftar_baru "$S")" 0
cek runbook_5_5 "$R55" "$(val pendidikan "$L")|$(val tautan "$L")|$(val profesi "$L")"; cek tautan_dilewati "$(val tautan_dilewati "$L")" 0
echo "INFO transaksi_lama=$(sqla "$BK/sql/transaksi-lama.sql") (lebih dari 0: tunggu sampai 0 sebelum P.5)"
```

### P.5: job rilis production, gerbang enforce

```sh
. /root/bukti-gladi-0009/vars.env; BKP=/root/bukti-rilis-0009; ENVF=/etc/kapdh/production/release.env
date -u +"%Y-%m-%dT%H:%M:%SZ P5-job-mulai" >> "$BKP/timeline.txt"; T0=$(date -u +%s)
docker run --rm --network coolify --env-file "$ENVF" -e KAPDH_ENV=production -e RELEASE_GATE=enforce --security-opt no-new-privileges:true --cap-drop ALL --memory 512m --name kapdh-release-production "$REL_IMG" </dev/null > "$BKP/job-rilis.log" 2>&1; RC=$?
echo "INFO job production: kode $RC, durasi $(( $(date -u +%s) - T0 )) detik" | tee -a "$BKP/timeline.txt"; grep -E '^\[rilis\]|^\[migrate\]|^\[(LULUS|GAGAL)\]|^HASIL|✗' "$BKP/job-rilis.log"
[ "$RC" = 0 ] && echo "PASS job rilis production (enforce)" || echo "FAIL job rilis production kode $RC: ikuti runbook rilis 5.1 (sebelum migrasi) atau 5.2 (sesudah migrasi); JANGAN redeploy"
```

Padanan bila `run-release.sh` ada di VPS: `RELEASE_GATE=enforce sh <path>/run-release.sh production "$REL_IMG" </dev/null`
(nama kontainer, jaringan `coolify` dan env file bawaannya sama dengan baris di atas).

- Log memuat `[migrate] Gagal: 55P03 ...` lalu `[rilis] GAGAL: migrasi gagal; ...`: kunci 0009 tidak diperoleh dalam
  15 detik. Skema tetap 0008 (seluruh transaksi migrasi dibatalkan), API/worker lama tidak tersentuh, dan simpan
  profil yang sempat tertahan dilanjutkan. Ulangi P.4 sampai `transaksi_lama=0`, lalu P.3 dan P.5.
- Gerbang `enforce` menolak (pra-migrasi): skema belum berubah (runbook rilis 5.1). Lanjut hanya bila pemilik produk
  menyetujui pengecualian tertulis runbook rilis 5.3: baris `docker run` di atas dengan `RELEASE_GATE=report` serta
  `-e RELEASE_GATE_REASON -e RELEASE_GATE_APPROVER`, kedua variabel diekspor lebih dahulu (pola Blok 4R).

### P.6: hitungan "sesudah" production (sebelum redeploy)

Pasangan kolom lama dan daftar baru dihitung dalam satu kueri (`runbook55-sesudah.sql`) dan wajib sama selama hanya
API lama yang menulis (jembatan menjaga keduanya sejalan). Terhadap P.4 angkanya boleh berbeda bila anggota menyimpan
profil di antara P.4 dan P.6, jadi perbandingan dengan P.4 dan sidik bersifat INFO. Pemeriksaan keras: journal,
objek, pasangan `runbook_5_5_sesudah`, `selisih_baris`, `baris_daftar_tanpa_sumber`, hak akses, hash migrasi.

```sh
. /root/bukti-gladi-0009/vars.env; BKP=/root/bukti-rilis-0009; NET=coolify; ENVF=/etc/kapdh/production/release.env
sqlf() { docker run --rm -i --network "$NET" --env-file "$ENVF" "$PGIMG" sh -c 'psql "$MIGRATOR_DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=terse -f -' < "$1"; }
val() { sed -n "s/^$1=//p" "$2" | head -n 1; }; cek() { if [ "$2" = "$3" ]; then echo "PASS $1=$2"; else echo "FAIL $1: dapat '$2', harap '$3'"; fi; }
S="$BKP/skema-sesudah.txt"; H="$BKP/hitung-baru.txt"; L="$BKP/hitung-lama-sesudah.txt"; B="$BKP/skema-sebelum.txt"; sqlf "$BK/sql/skema.sql" > "$S"; sqlf "$BK/sql/hitung-baru.sql" > "$H"; sqlf "$BK/sql/hitung-lama.sql" > "$L"; cat "$H"
cek migrasi_tercatat "$(val migrasi_tercatat "$S")" 11; cek migrasi_terakhir "$(val migrasi_terakhir "$S")" 1792591540265; cek tabel_daftar_baru "$(val tabel_daftar_baru "$S")" 3; cek fungsi_baru "$(val fungsi_baru "$S")" 10; cek trigger_baru "$(val trigger_baru "$S")" 7
cek tabel_app_bertambah "$(( $(val tabel_app "$S") - $(val tabel_app "$B") ))" 3; cek trigger_total_bertambah "$(( $(val trigger_total "$S") - $(val trigger_total "$B") ))" 7
R55S=$(sqlf "$BK/sql/runbook55-sesudah.sql"); echo "runbook_5_5_sesudah=$R55S" | tee "$BKP/runbook55-sesudah.txt"; echo "$R55S" | awk -F'|' '{ if ($1 == $2 && $3 == $4 && $5 == $6) print "PASS pasangan kolom lama = daftar baru"; else print "FAIL pasangan kolom lama dan daftar baru berbeda" }'
cek selisih_baris "$(val selisih_baris "$H")" 0; cek baris_daftar_tanpa_sumber "$(val baris_daftar_tanpa_sumber "$H")" 0
cmp -s "$BKP/hitung-lama-sebelum.txt" "$L" && echo "INFO hitungan kolom lama sama dengan P.4" || echo "INFO hitungan kolom lama berubah sejak P.4 (ada simpan profil di antaranya)"
```

```sh
. /root/bukti-gladi-0009/vars.env; BKP=/root/bukti-rilis-0009; NET=coolify; ENVF=/etc/kapdh/production/release.env
sqlf() { docker run --rm -i --network "$NET" --env-file "$ENVF" "$PGIMG" sh -c 'psql "$MIGRATOR_DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=terse -f -' < "$1"; }
val() { sed -n "s/^$1=//p" "$2" | head -n 1; }; cek() { if [ "$2" = "$3" ]; then echo "PASS $1=$2"; else echo "FAIL $1: dapat '$2', harap '$3'"; fi; }
G="$BKP/hak.txt"; sqlf "$BK/sql/hak.sql" > "$G"; sqlf "$BK/sql/sidik.sql" > "$BKP/sidik-sesudah.txt"
cek hak_dml_app_worker "$(val hak_dml_app_worker "$G")" 6; cek hak_truncate_app_worker "$(val hak_truncate_app_worker "$G")" 0; cek monitor_baca_daftar "$(val monitor_baca_daftar "$G")" 0
cek backup_baca_daftar "$(val backup_baca_daftar "$G")" 3; cek pemilik_migrator "$(val pemilik_migrator "$G")" 3; cek eksekusi_proyeksi_app "$(val eksekusi_proyeksi_app "$G")" 1; cek trigger_tertunda "$(val trigger_tertunda "$G")" 2
cek hash_0009 "$(val hash_0009 "$G")" "$H9"; cek hash_0010 "$(val hash_0010 "$G")" "$H10"
cmp -s "$BKP/sidik-sebelum.txt" "$BKP/sidik-sesudah.txt" && echo "INFO sidik kolom lama sama dengan P.4" || echo "INFO sidik kolom lama berubah sejak P.4 (ada simpan profil di antaranya)"
```

### P.7: redeploy Coolify berurutan dengan tag pasti

Urutan runbook rilis 5.5 langkah 3: **api → worker → admin → web**; tunggu setiap resource `healthy` sebelum
berikutnya (label menu Coolify dapat berbeda [A-14]). Tag pasti dicetak dari `vars.env`:

```sh
. /root/bukti-gladi-0009/vars.env
printf '%s\n' "1 kapdh-api    -> $API_IMG" "2 kapdh-worker -> $WORKER_IMG" "3 kapdh-admin  -> $ADMIN_IMG" "4 kapdh-web    -> $WEB_IMG"
```

Pemeriksaan (jalankan sesudah setiap redeploy; baris untuk resource yang belum diredeploy wajar FAIL):

```sh
. /root/bukti-gladi-0009/vars.env
curl -fsS https://api.kapdh.or.id/api/v1/health | grep -q "\"commit\":\"$MERGE_SHA\"" && echo "PASS api commit baru" || echo "FAIL api belum commit baru"
[ "$(curl -s -o /dev/null -w '%{http_code}' https://api.kapdh.or.id/api/v1/health/ready)" = 200 ] && echo "PASS readiness api 200" || echo "FAIL readiness api"
docker ps --format '{{.Image}} {{.Status}}' | grep -E '/kapdh-(api|worker|web|admin):' | sed 's/@sha256:[0-9a-f]*//'
curl -fsS https://admin.kapdh.or.id/version.json | grep -q "$MERGE_SHA" && echo "PASS admin commit baru" || echo "FAIL admin belum commit baru"
curl -fsS https://kapdh.or.id/version.json | grep -q "$MERGE_SHA" && echo "PASS web commit baru" || echo "FAIL web belum commit baru"
```

### P.8: uji asap dan bukti

- Runbook rilis 5.5 langkah 4: ubah profil akun uji lewat aplikasi lama (field lama) dan lewat web admin baru (daftar
  baru), lalu `GET /me` dan profil direktori menampilkan perubahan yang sama (manual, pemilik).
- Laporan gerbang sesudah rilis: Blok 4B dengan `--network coolify --env-file /etc/kapdh/production/release.env`,
  keluaran ke `/root/bukti-rilis-0009/golive-sesudah.json`.
- `backup.env`: bila memakai `IMAGE_API`/`IMAGE_WORKER` statis (bukan `CONTAINER_*` berlabel), perbarui ke tag baru
  (runbook backup-restore 3), agar manifest backup berikutnya mencatat image yang benar. Periksa:
  `grep -E '^(IMAGE|CONTAINER)_(API|WORKER)=' /etc/kapdh/backup.env`.
- Hari berikutnya: backup harian 19:15 UTC sukses (`journalctl -u kapdh-backup --since today`), dump memuat tabel baru
  (Blok 5C `backup_baca_daftar=3`).

### P.9: jalur mundur

- **Rollback image** (jalur biasa, runbook rilis 5.5 langkah 5 dan 6.1): kembalikan `kapdh-api` dan `kapdh-worker` ke
  tag di `/root/bukti-rilis-0009/image-sebelum.txt`, dan **`kapdh-admin` wajib ikut** (admin baru gagal dengan API
  lama). Jangan menjalankan job rilis image lama. Tidak boleh lagi setelah build mobile yang memakai daftar baru
  tersebar.
- **Pembatalan skema darurat** hanya atas keputusan pemilik (runbook rilis 5.5 langkah 6), sesudah rollback image dan
  dump baru (P.3): perintah Blok 7B dengan `--network coolify --env-file /etc/kapdh/production/release.env`, lalu
  periksa seperti Blok 7C. Isi tambahan daftar yang belum ada di kolom lama hilang permanen.

## 15. Celah skrip dan alternatif minimal yang dipakai

| Celah (dari kode)                                                                                                             | Dampak                                                                                              | Alternatif di dokumen ini                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-release.sh` tidak ikut image rilis (Dockerfile.api hanya menyalin `release-job.sh`); VPS tidak punya checkout repo [A-2] | perintah runbook `sh kapdh-platform/infra/scripts/run-release.sh` tidak dapat dijalankan apa adanya | `docker run` setara dengan argumen skrip; saran: salin `run-release.sh` ke image (`/app/infra/scripts`) seperti skrip backup                                           |
| `run-release.sh` hanya menerima `production\|staging`, nama kontainer tetap `kapdh-release-<env>`                             | tidak ada label "drill"                                                                             | `KAPDH_ENV=production` (gerbang dan aturan pengecualian identik) + nama `kapdh-drill-release`; jaringan/env file lewat `KAPDH_DOCKER_NETWORK`/`KAPDH_RELEASE_ENV_FILE` |
| Jalur manual tidak membuat dump pra-migrasi (hanya `remote-migrate.sh`)                                                       | tanpa langkah tambahan tidak ada titik pulih tepat sebelum migrasi                                  | runbook rilis 5.5 langkah 1.3 dan P.3 memakai perintah dump `remote-migrate.sh`, dilatih di Blok 7A                                                                    |
| 0009 menunggu kunci EXCLUSIVE paling lama 15 detik per tabel, sekitar 45 detik untuk tiga tabel (`lock_timeout`), lalu gagal `55P03`                                       | job production dapat gagal bila ada transaksi profil yang menggantung                               | `transaksi_lama` di P.4 sebelum job; gagal = skema tetap 0008, ulangi saat sepi (P.5); jalur gagal dibuktikan uji PostgreSQL, bukan oleh gladi                         |
| `restore.sh` selalu memulihkan berkas juga                                                                                    | disk dan salinan berkas production di host                                                          | `FILES_ROOT=/srv/kapdh/drill/files`, dimusnahkan                                                                                                                       |
| `restore.sh` tanpa `--yes` memanggil `read`                                                                                   | rusak di terminal Coolify                                                                           | `--yes` + `</dev/null`                                                                                                                                                 |
| `restore.sh` memuat `/etc/kapdh/backup.secrets.env` bawaan (berisi `PGPASSWORD` kapdh_backup)                                 | secret production yang tidak perlu ikut ke drill                                                    | `KAPDH_BACKUP_SECRETS` diarahkan ke salinan tersaring                                                                                                                  |
| Tidak ada `psql` di host                                                                                                      | kueri pemeriksaan                                                                                   | kontainer image PostgreSQL di jaringan target, URL dari `--env-file` (pola `remote-migrate.sh`)                                                                        |
| Skrip pembatalan hanya ada di image sesudah merge                                                                             | gladi pembatalan tidak dapat memakai image sebelum merge                                            | gladi dijalankan dengan image `sha-<MERGE_SHA>`; aman karena production dideploy manual                                                                                |
| Isi awal tautan memakai panjang 1 sampai 200 karakter, kolom lama tanpa CHECK                                                 | nilai kosong/terlalu panjang tidak disalin                                                          | `tautan_dilewati` (Blok 3B, P.4) harus 0; `selisih_baris` memeriksa setiap nilai yang disalin                                                                          |
| Gladi di database tanpa penulis lain                                                                                          | kebebasan deadlock (alasan `LOCK TABLE` 0009) dan jalur `55P03` tidak teruji di gladi               | dicatat sebagai batasan; perilaku konkurensi bersandar pada desain dan uji PostgreSQL 17 PR #18                                                                        |

## 16. Asumsi yang belum terverifikasi dari kode

- **[A-1]** Image `kapdh-release`, `kapdh-api`, `kapdh-worker`, `kapdh-admin`/`kapdh-web` `-production` untuk
  `MERGE_SHA` sudah terbit, dan merge tidak mengubah berkas migrasi, journal (11) maupun skrip pembatalan (sha256
  `af72884c…`); Blok 0.4 memeriksanya.
- **[A-2]** Lokasi `run-release.sh` di VPS tidak diketahui; tidak ada di image.
- **[A-3]** Terminal Coolify menjalankan bash sebagai root; aturan blok (tanpa `read`, `!`, `set -e`, `exit`) cukup untuk
  terminal itu.
- **[A-4]** Kontainer PostgreSQL production memakai image resmi `postgres:17…`: entrypoint resmi, socket lokal `trust`
  untuk `docker exec psql -U postgres` di kontainer drill, data di `/var/lib/postgresql/data`, server sementara saat
  inisialisasi hanya mendengar socket. Superuser drill bernama `postgres`.
- **[A-5]** Host `ADMIN_DATABASE_URL` di `/etc/kapdh/production/release.env` adalah nama kontainer yang dapat
  di-`docker inspect` (berkas tanpa tanda kutip, sesuai format `--env-file`), sama dengan kontainer terakhir di
  `PG_EXEC` `backup.env`; sandi heksadesimal (tanpa `@`).
- **[A-6]** `/etc/kapdh/backup.env` memakai baris `KUNCI=nilai` (format EnvironmentFile systemd, tanpa `export`), memuat
  `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE`, `LEDGER_RCLONE_REMOTE` dan (bila diubah) `WORK_DIR`;
  `backup.secrets.env` memuat `AWS_*` dan `RCLONE_CONFIG_KAPDHLEDGER_*` dengan kunci ledger hanya-baca.
- **[A-7]** Skrip di `/opt/kapdh/infra` (dipasang dari image rilis) sudah memuat opsi restore.sh yang dipakai
  (`--evidence-dir`, `--yes`, `--snapshot`); Blok 0.3 memeriksanya.
- **[A-8]** Image API production (`API_OLD`, `docker ps` memuat `/kapdh-api:`) memuat
  `dist/modules/account/ledger-reapply.cli.js` (terbukti pada drill Oktober dengan image sebelumnya), dan nama image
  itu memberi registry `ghcr.io/<org>` yang benar untuk Blok 0.0.
- **[A-9]** Jaringan `--internal` tidak menerbitkan port, sehingga readiness diperiksa lewat `docker exec` (sesuai
  catatan drill Oktober "jaringan sengaja tanpa port").
- **[A-10]** Gerbang go-live production lulus pada saat gladi. Bila tidak, Blok 4 `enforce` menolak dan keputusan
  pemilik di bagian 7 berlaku.
- **[A-11]** `has_table_privilege` menghitung `pg_read_all_data` untuk `kapdh_backup` (PostgreSQL 14+).
- **[A-12]** `SET CONSTRAINTS ALL IMMEDIATE` menembakkan event constraint trigger yang tertunda pada transaksi itu
  (dokumentasi PostgreSQL); gladi sendiri yang membuktikannya untuk trigger 0010.
- **[A-13]** Sisipan sintetis Blok 6A (hanya bila salinan tidak memuat alumni) mengisi semua kolom wajib tanpa nilai
  bawaan `app.users` dan `app.alumni` (`0000_init.sql`; sama dengan sisipan uji PostgreSQL PR #18).
- **[A-14]** Nama menu Coolify untuk mengubah tag image resource "Docker Image", dan bahwa Coolify menarik image GHCR
  dengan login Docker root.
- **[A-15]** Angka `tabel_app` 40/43 dan `trigger_total` 16/23 berasal dari uji PR pada database bersih; dokumen hanya
  mewajibkan selisihnya (+3/+7).
- **[A-16]** Perkiraan disk (6 kali ukuran dump) dan ambang RAM 1200 MB adalah perkiraan konservatif, bukan hasil ukur.
- **[A-17]** Kontainer production (api, worker, web, admin) masing-masing memiliki healthcheck image (terbukti di
  Dockerfile) dan tampil `(healthy)` di `docker ps`.
- **[A-18]** Kueri `transaksi-lama.sql` sebagai superuser melihat `xact_start` semua sesi; pg_stat_activity hanya
  menampilkan kolom itu untuk sesi milik role sendiri bagi role lain.
