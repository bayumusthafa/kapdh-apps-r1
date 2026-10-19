# Menerbitkan repo KAPDH Apps sebagai repo publik

> **Internal pengurus.** Folder `docs/internal/` tidak ikut snapshot publik. Jangan menautkan berkas ini dari
> dokumen publik.

Repo kerja `bayumusthafa/kapdh-apps-r1` tetap private. Versi publik dibuat sebagai repo **baru** dari snapshot satu
commit tanpa riwayat (bagian 2). Kode dan aset tetap milik Perkumpulan Keluarga Alumni Pesantren Darel Hikmah
(KAPDH), badan hukum berdasarkan Akta Nomor 01 tanggal 27 Maret 2023 dan SK Menkumham Nomor
AHU-0002732.AH.01.07.TAHUN 2023, dengan lisensi proprietary (semua hak dilindungi, lihat `LICENSE` di akar repo).
Repo publik berarti kode boleh dibaca, bukan boleh dipakai ulang. Satu-satunya hak tambahan adalah yang diwajibkan
ketentuan layanan GitHub (melihat dan mem-fork di dalam GitHub), sesuai `LICENSE` butir 2.

Urutan kerja: bagian 1, lalu daftar periksa bagian 3, lalu langkah bagian 2, lalu bagian 4. Bagian 5 hanya untuk
keputusan membuka repo kerja lama.

## 1. Langkah akun GitHub (pemilik, sebelum merge PR atau push berikutnya)

Dikerjakan sendiri oleh pemilik akun `bayumusthafa`. Agen dan skrip tidak mengubah pengaturan akun.

1. GitHub > **Settings** > **Emails**.
2. Centang **Keep my email addresses private**. Sejak itu commit yang dibuat lewat web GitHub (tombol merge PR,
   edit berkas di web) memakai alamat noreply, bukan email akun.
3. Centang **Block command line pushes that expose my email**. GitHub menolak push bila commit yang didorong masih
   memakai email pribadi akun.
4. Kerjakan langkah 2 dan 3 **sebelum** menekan merge pada PR mana pun atau push berikutnya. Merge sebelum itu
   mencatat email akun di commit merge.

Identitas git repo kerja sudah diset di `.git/config` dan berlaku untuk semua worktree repo ini. Repo ini memakai
`extensions.worktreeConfig`, jadi pastikan tidak ada `config.worktree` yang menimpanya: di worktree mana pun, keluaran
di bawah harus menunjuk `.git/config`.

```bash
git config --show-origin user.name    # Bayu Musthafa
git config --show-origin user.email   # 298556921+bayumusthafa@users.noreply.github.com
```

Identitas global di mesin kerja masih email pribadi, jadi setiap clone lain (clone baru, laptop lain, mesin build)
diset sama, atau identitas globalnya diganti ke alamat noreply:

```bash
git config user.name "Bayu Musthafa"
git config user.email "298556921+bayumusthafa@users.noreply.github.com"
```

Bila push ditolak karena commit yang belum didorong masih memakai email lama, perbaiki author commit itu (mis.
`git commit --amend --no-edit --reset-author` untuk commit teratas). Jangan mematikan perlindungannya.

## 2. Jalur yang disarankan: repo publik baru dari snapshot

### Mengapa repo kerja tidak dibuka

- Riwayat commit memakai email kantor `@picotel.co.id`, dan commit lama teratribusi ke akun GitHub PicotelScript.
- Riwayat memuat data pribadi lama: data uji dan mock sebelum diganti persona sintetis, serta gambar guideline
  sebelum dikaburkan.
- Log dan artifact GitHub Actions memuat alamat Gmail pribadi.
- `refs/pull/*` dan run Actions lama terikat ke SHA lama. Menulis ulang riwayat (filter-repo lalu force push) tidak
  menghapus ref PR yang dikelola GitHub, log, maupun artifact, sehingga commit lama tetap bisa dibuka lewat SHA-nya.
  Ref PR tidak bisa dihapus sendiri oleh pemilik repo.

Snapshot tidak membawa satu pun dari hal di atas: satu commit, author dan committer noreply, tanpa `docs/internal/`.

### Langkah

1. Pastikan semua perubahan yang akan terbit sudah di-merge ke `main` dan CI hijau, lalu `git fetch origin`.
2. Buat snapshot di luar repo (skrip menolak tujuan di dalam working tree atau folder `.git` repo mana pun):

   ```bash
   bash docs/internal/publikasi/buat-snapshot-publik.sh ../kapdh-apps-publik --ref origin/main
   ```

   Tambahkan `--exclude-extra <path>` (boleh berulang) untuk pengecualian opsional di bagian 3. Skrip:
   - mengambil isi lewat `git archive <ref>`, jadi hanya berkas ter-track. Perubahan yang belum di-commit dan
     berkas yang diabaikan `.gitignore` (termasuk `.claude/`) tidak ikut;
   - membuang `docs/internal/` dan path tambahan, dan menolak path tambahan yang tidak cocok dengan berkas apa pun
     (mencegah salah ketik);
   - menjalankan `git init -b main` lalu satu commit `chore: snapshot awal KAPDH Apps` dengan author dan committer
     `Bayu Musthafa <298556921+bayumusthafa@users.noreply.github.com>`, dan mengeset identitas yang sama di repo
     baru;
   - mencocokkan isi snapshot dengan `<ref>` (path, mode berkas, isi blob) sebelum commit;
   - menyebut nama berkas yang cocok dengan pola langkah 3 sebagai peringatan (isi barisnya tidak dicetak);
   - hanya mencetak langkah lanjutan. Skrip tidak membuat repo GitHub, remote, atau push.

   Bila skrip gagal setelah mulai mengisi tujuan, hapus folder tujuan sebelum mencoba lagi.

3. Periksa hasilnya:

   ```bash
   S=../kapdh-apps-publik
   git -C "$S" log --format=fuller                  # satu commit, identitas noreply
   git -C "$S" ls-files docs/internal               # harus kosong
   git -C "$S" grep -n -I -i -E 'picotel|@gmail\.com|@yahoo\.|@email\.com|airhemp\.com|fidhost\.com' || echo bersih
   ```

   Pola ini sama dengan `POLA_PERIKSA` di skrip; ubah keduanya bersamaan. Setiap temuan dibersihkan di repo kerja,
   di-merge, lalu snapshot dibuat ulang; jangan menyunting folder snapshot. Jalankan juga pemindai rahasia (mis.
   gitleaks) pada folder snapshot bila tersedia.

4. Buat repo **kosong** di GitHub (tanpa README, LICENSE, atau .gitignore), private dulu, dan matikan Actions
   sebelum push pertama agar tidak ada workflow yang jalan sebelum bagian 4 selesai:

   ```bash
   gh repo create <pemilik>/<nama-repo> --private
   gh api -X PUT repos/<pemilik>/<nama-repo>/actions/permissions -F enabled=false
   git -C "$S" remote add origin https://github.com/<pemilik>/<nama-repo>.git
   git -C "$S" push -u origin main
   ```

5. Periksa tampilan repo di GitHub, ubah visibilitas ke **Public** (Settings > General > Danger Zone), lalu segera
   kerjakan bagian 4. Di paket GitHub Free sebagian pengaturan bagian 4 (ruleset, reviewer environment, private
   vulnerability reporting) hanya tersedia untuk repo publik, jadi pengaturan itu dikerjakan setelah visibilitas
   diubah dan sebelum Actions dinyalakan.
6. Repo kerja lama tetap private. Skrip ini hanya untuk snapshot awal: menjalankannya lagi menghasilkan riwayat baru
   yang tidak tersambung dengan repo publik. Sejak snapshot, perubahan berikutnya masuk lewat PR biasa ke repo
   publik. Pindahkan catatan `docs/internal/` ke repo private lain sebelum repo lama diarsipkan.

## 3. Daftar periksa sebelum publikasi

- [ ] **Izin tertulis pengurus** Perkumpulan untuk membuka kode dan aset merek (nama, logo, foto, pedoman merek).
      Surat atau notulen disimpan di arsip pengurus, bukan di repo.
- [ ] **`LICENSE` ditinjau penasihat hukum**: pemegang hak cipta Perkumpulan Keluarga Alumni Pesantren Darel Hikmah
      (KAPDH) sesuai akta dan SK di atas, lisensi proprietary, semua hak dilindungi. Tinjau bersama
      `THIRD_PARTY_NOTICES.md`: setiap aset pihak ketiga tercantum dengan lisensi dan berkas lisensinya.
- [ ] **Pemilik repo publik** diputuskan: akun pribadi `bayumusthafa` atau organisasi GitHub atas nama Perkumpulan.
- [ ] **`SECURITY.md` dikonfirmasi pengurus** (berkas sudah ada; butir terbuka ditandai komentar HTML di dalamnya):
      `bantuan@kapdh.or.id` tetap kanal laporan keamanan atau diganti alamat khusus, petugas yang memantaunya
      meneruskan email berawalan `[KEAMANAN]` ke pengembang dan pengelola infra, angka target (konfirmasi terima 5
      hari kerja, penilaian awal 10 hari kerja) beserta komitmen tanggapan lain, dan pernyataan itikad baik. Ubah
      ringkasan Bahasa Inggris bersamaan.
- [ ] **Pengecualian opsional** diputuskan bila izin merek atau foto belum ada:

  | Path                             | Isi                                                     | Opsi skrip                                         |
  | -------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
  | `docs/reference/guidelines/`     | 18 halaman pedoman merek (PNG, data pribadi dikaburkan) | `--exclude-extra docs/reference/guidelines`        |
  | `docs/Prototipe KAPDH Apps.html` | prototipe UI satu berkas                                | `--exclude-extra "docs/Prototipe KAPDH Apps.html"` |
  | `docs/PRD_KAPDH_Apps_v3.5.pdf`   | dokumen PRD                                             | `--exclude-extra docs/PRD_KAPDH_Apps_v3.5.pdf`     |

  Ikut dipertimbangkan bersama butir di atas: salinan teks `docs/reference/Guidelines_KAPDH_v1.0.txt` dan
  `docs/reference/PRD_v3.5.txt`, serta `docs/reference/prototype/`. Bila dikecualikan, periksa rujukan yang akan
  putus (`README.md` dan `docs/ARCHITECTURE.md` menyebut PRD dan guideline):

  ```bash
  git grep -n -e 'reference/guidelines' -e 'Prototipe KAPDH Apps' -e 'PRD_KAPDH_Apps' -e 'PRD_v3.5' \
    -e 'Guidelines_KAPDH' -- . ':(exclude)docs/internal'
  ```

- [ ] **Paket GHCR tetap private** (`kapdh-api`, `kapdh-worker`, `kapdh-web`, `kapdh-admin`): profil > **Packages** >
      tiap paket > **Package settings** > visibilitas **Private**. Paket yang sudah dibuat publik tidak bisa
      dikembalikan ke private. Bila repo publik kelak mendorong image, beri repo itu akses lewat **Manage Actions
      access** tanpa mengubah visibilitas, lalu periksa ulang setelah image pertama.
- [ ] Bagian 1 sudah dikerjakan dan semua clone memakai alamat noreply.
- [ ] Snapshot lolos pemeriksaan bagian 2 langkah 3: tanpa data pribadi asli dan tanpa rahasia.

## 4. Setelah repo publik dibuat

Kerjakan sebelum Actions dinyalakan. Rincian environment, secret, dan ruleset ada di `docs/runbooks/ci-cd.md`
bagian 4; butir di bawah adalah tambahan khusus repo publik.

1. **Keamanan kode** (Settings > Advanced Security): aktifkan **Secret scanning** beserta **Push protection**,
   **Dependabot alerts**, **Dependabot security updates**, dan **Private vulnerability reporting**.
   `.github/dependabot.yml` yang ikut snapshot sudah mengatur pembaruan versi.
2. **`SECURITY.md`** sudah ada di akar repo dan ikut commit pertama snapshot setelah di-merge ke `main`: lapor
   celah lewat **Report a vulnerability** (private vulnerability reporting) atau email `bantuan@kapdh.or.id`
   berawalan `[KEAMANAN]`, jangan lewat issue publik; cakupan; versi yang didukung (rilis terbaru dan layanan
   production); aturan pengujian beritikad baik; target tanggapan; tanpa bug bounty. Setelah butir 1, pastikan
   tombol **Report a vulnerability** muncul di tab **Security**. Alamat kontak dan angka target masih usulan (lihat
   bagian 3).
3. **Proteksi branch dan tag** (Settings > Rules > Rulesets):
   - branch `main`: wajib PR, wajib status "CI lulus", blokir force push dan penghapusan;
   - tag `v*` dan `contracts-v*` (pemicu `release.yml`): hanya pengelola rilis yang boleh membuat, blokir pembaruan
     dan penghapusan, bypass untuk GitHub Actions agar job `contracts-push` tetap bisa mendorong tag.
4. **Environment**: `production` dengan **Required reviewers** (pemilik produk dan satu cadangan, "Prevent
   self-review") dan deployment hanya dari tag `v*` dan branch `main`; `staging` hanya dari `main`. Secrets dan
   variables tidak ikut snapshot: isi ulang di repo baru, rahasia deploy sebagai secret environment, bukan secret
   repo.
5. **Actions** (Settings > Actions > General):
   - **Fork pull request workflows from outside collaborators**: pilih opsi paling ketat, **Require approval for all
     outside collaborators**;
   - **Workflow permissions**: baca saja (bawaan); workflow yang perlu menulis sudah meminta `permissions` sendiri;
   - **Jangan pakai runner self-hosted.** Biarkan variabel repo `DEPLOY_RUNS_ON` dan `CI_RUNS_ON` kosong dan jangan
     mendaftarkan runner self-hosted ke repo publik: PR dari fork bisa menjalankan kode di mesin runner. Saat ini
     hanya `_deploy.yml` yang membaca `DEPLOY_RUNS_ON`; `CI_RUNS_ON` belum dipakai dan jangan ditambahkan ke
     workflow repo publik. Deploy memakai runner GitHub plus Tailscale (`docs/runbooks/staging-setup.md`).
6. Nyalakan Actions, jalankan CI di `main`, dan pastikan job deploy production menunggu persetujuan reviewer:

   ```bash
   gh api -X PUT repos/<pemilik>/<nama-repo>/actions/permissions -F enabled=true
   ```

## 5. Bila tetap ingin membuka repo kerja lama (tidak disarankan)

Hanya dengan keputusan tertulis pengurus yang menerima risiko berikut. Risiko ini **tidak bisa dihilangkan**:

- atribusi akun PicotelScript dan email `@picotel.co.id` di commit lama tetap terlihat;
- data pribadi lama tetap ada di riwayat dan di `refs/pull/*`;
- `docs/internal/` beserta riwayatnya ikut terbuka.

Yang bisa dibersihkan sendiri hanyalah run Actions beserta log dan artifact-nya. Perintah di bawah **dijalankan
pemilik sendiri** dengan `gh` yang sudah login sebagai admin repo; agen tidak menjalankannya.

> **Peringatan: penghapusan permanen.** Log, artifact, dan riwayat run di tab Actions tidak bisa dipulihkan. Simpan
> dulu bukti yang masih diperlukan (mis. bukti rilis atau uji restore) di luar repo.

```bash
R=bayumusthafa/kapdh-apps-r1
# 1. Catat daftar run sebagai arsip, di luar folder repo (tanpa log).
gh run list --repo "$R" --limit 500 --json databaseId,workflowName,headBranch,createdAt,conclusion \
  >~/kapdh-run-lama.json
# 2. Hapus run beserta log dan artifact-nya (PERMANEN).
gh run list --repo "$R" --limit 500 --json databaseId -q '.[].databaseId' |
  while read -r id; do gh run delete "$id" --repo "$R" </dev/null; done
# 3. Ulangi langkah 2 sampai perintah ini tidak menampilkan apa pun.
gh run list --repo "$R" --limit 5
# 4. Hapus juga cache Actions.
gh cache delete --all --repo "$R"
```

Setelah itu periksa deskripsi dan komentar PR atau issue, catatan rilis, dan riwayat deployment yang mungkin memuat
data pribadi, lalu kerjakan bagian 1, 3, dan 4 sebelum mengubah visibilitas.
