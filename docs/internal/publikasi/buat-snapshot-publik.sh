#!/usr/bin/env bash
# Membuat snapshot publik KAPDH Apps: repo git baru berisi SATU commit tanpa riwayat, diambil dari berkas
# ter-track pada <ref> (git archive), tanpa docs/internal/ dan path tambahan. Prosedur lengkap ada di
# docs/internal/publikasi/README.md.
#
# Skrip tidak mengubah repo sumber (tidak checkout, commit, atau push) dan tidak membuat remote. Isi snapshot
# dicocokkan dengan <ref> sebelum commit: path, mode berkas (termasuk bit eksekusi), dan isi blob harus sama.
# Setelah commit, berkas yang cocok dengan pola sisa jejak (POLA_PERIKSA) disebut sebagai peringatan.
set -euo pipefail

readonly NAMA_GIT="Bayu Musthafa"
readonly EMAIL_GIT="298556921+bayumusthafa@users.noreply.github.com"
readonly PESAN_COMMIT="chore: snapshot awal KAPDH Apps"
readonly SELALU_DIBUANG="docs/internal"
# Sisa jejak yang tidak boleh terbit; sama dengan pola di README bagian 2 langkah 3.
readonly POLA_PERIKSA='picotel|@gmail\.com|@yahoo\.|@email\.com|airhemp\.com|fidhost\.com'

pakai() {
  cat <<'EOF'
Pemakaian: buat-snapshot-publik.sh <direktori-tujuan> [--ref <ref>] [--exclude-extra <path>]...

  <direktori-tujuan>      wajib; belum ada atau kosong, dan tidak di dalam working tree atau folder .git
  --ref <ref>             commit sumber (bawaan HEAD); perubahan yang belum di-commit tidak ikut
  --exclude-extra <path>  path tambahan yang dibuang (boleh berulang; folder atau pola glob pathspec git)

docs/internal/ selalu dibuang. Contoh:
  bash docs/internal/publikasi/buat-snapshot-publik.sh ../kapdh-apps-publik --ref origin/main \
    --exclude-extra "docs/Prototipe KAPDH Apps.html"
EOF
}

gagal() {
  printf 'galat: %s\n' "$*" >&2
  exit 1
}

# Variabel lingkungan git dari hook atau sesi lain akan membelokkan perintah ke repo yang salah. CDPATH membuat
# `cd` mencetak path dan bisa pindah ke direktori lain.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX CDPATH

tujuan=""
ref="HEAD"
tambahan=()
while (($# > 0)); do
  case "$1" in
    -h | --help)
      pakai
      exit 0
      ;;
    --ref)
      (($# >= 2)) || gagal "--ref butuh nilai"
      ref=$2
      shift 2
      ;;
    --ref=*)
      ref=${1#*=}
      shift
      ;;
    --exclude-extra)
      (($# >= 2)) || gagal "--exclude-extra butuh path"
      tambahan+=("$2")
      shift 2
      ;;
    --exclude-extra=*)
      tambahan+=("${1#*=}")
      shift
      ;;
    -*) gagal "opsi tidak dikenal: $1 (lihat --help)" ;;
    *)
      [[ -z $tujuan ]] || gagal "direktori tujuan hanya boleh satu: '$tujuan' dan '$1'"
      tujuan=$1
      shift
      ;;
  esac
done
if [[ -z $tujuan ]]; then
  pakai >&2
  exit 2
fi
[[ -n $ref ]] || gagal "--ref tidak boleh kosong"

# Repo sumber adalah repo tempat skrip ini berada, bukan direktori kerja pemanggil.
dir_skrip=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$dir_skrip" rev-parse --show-toplevel 2>/dev/null) || gagal "skrip harus berada di dalam repo KAPDH Apps"
sha=$(git -C "$repo" rev-parse --verify --quiet "${ref}^{commit}") || gagal "ref bukan commit yang dikenal: $ref"
format_objek=$(git -C "$repo" rev-parse --show-object-format)
pohon_kosong=$(git -C "$repo" hash-object -t tree --stdin </dev/null)

# Normalkan path pengecualian ke bentuk relatif akar repo, lalu pastikan memang ada di <ref> agar salah ketik
# tidak diam-diam membuat berkas yang ingin dibuang ikut terbit.
normalkan() {
  local p=${1//\\//}
  while [[ $p == ./* ]]; do p=${p#./}; done
  while [[ $p == */ ]]; do p=${p%/}; done
  [[ -n $p && $p != . ]] || gagal "path pengecualian kosong: '$1'"
  [[ $p != /* && $p != [A-Za-z]:* ]] || gagal "path pengecualian harus relatif terhadap akar repo: '$1'"
  [[ /$p/ != */../* ]] || gagal "path pengecualian tidak boleh memuat '..': '$1'"
  printf '%s' "$p"
}

pastikan_ada_di_ref() {
  local rc=0
  git -C "$repo" diff-tree --quiet -r "$pohon_kosong" "$sha" -- "$1" || rc=$?
  case $rc in
    1) ;; # --quiet keluar 1 bila ada berkas yang cocok
    0) gagal "path pengecualian tidak cocok dengan berkas apa pun di $ref: '$2'" ;;
    *) gagal "gagal memeriksa path '$2' di $ref" ;;
  esac
}

pathspec=(. ":(exclude)$SELALU_DIBUANG")
dibuang=("$SELALU_DIBUANG/")
for mentah in ${tambahan[@]+"${tambahan[@]}"}; do
  p=$(normalkan "$mentah")
  pastikan_ada_di_ref "$p" "$mentah"
  pathspec+=(":(exclude)$p")
  dibuang+=("$p")
done

# Direktori tujuan: belum ada atau kosong, dan tidak bersarang di working tree git mana pun (termasuk repo ini)
# maupun di dalam folder .git, supaya repo snapshot tidak ikut ter-add sebagai repo tertanam.
if [[ -e $tujuan ]]; then
  [[ -d $tujuan ]] || gagal "tujuan sudah ada dan bukan direktori: $tujuan"
  isi_tujuan=$(find "$tujuan" -mindepth 1 -maxdepth 1 -print -quit)
  [[ -z $isi_tujuan ]] || gagal "direktori tujuan tidak kosong: $tujuan"
fi
induk=$tujuan
while [[ ! -d $induk ]]; do induk=$(dirname "$induk"); done
if top_induk=$(git -C "$induk" rev-parse --show-toplevel 2>/dev/null) && [[ -n $top_induk ]]; then
  gagal "tujuan berada di dalam working tree git ($top_induk); pilih lokasi di luar repo"
fi
if dir_git_induk=$(git -C "$induk" rev-parse --absolute-git-dir 2>/dev/null); then
  gagal "tujuan berada di dalam direktori git ($dir_git_induk); pilih lokasi di luar repo"
fi

if [[ $ref == HEAD ]] && ! git -C "$repo" diff --quiet HEAD --; then
  printf 'catatan: ada perubahan yang belum di-commit di %s; perubahan itu TIDAK ikut snapshot.\n' "$repo" >&2
fi

sementara=$(mktemp -d)
tujuan_terisi=""
# Bila gagal setelah tujuan mulai diisi, isinya bukan snapshot yang sah. Skrip tidak menghapusnya sendiri.
beres() {
  local rc=$?
  rm -rf -- "$sementara"
  if ((rc != 0)) && [[ -n $tujuan_terisi ]]; then
    printf 'Snapshot GAGAL. Hapus %s sebelum mencoba lagi; isinya jangan dipakai.\n' "$tujuan_terisi" >&2
  fi
}
trap beres EXIT

mkdir -p "$tujuan"
tujuan=$(cd "$tujuan" && pwd)
tujuan_terisi=$tujuan
printf 'Membuat snapshot %s (%s) di %s ...\n' "$ref" "$sha" "$tujuan"

git init -q -b main --object-format="$format_objek" "$tujuan"
git -C "$tujuan" config user.name "$NAMA_GIT"
git -C "$tujuan" config user.email "$EMAIL_GIT"

# git archive hanya memuat berkas ter-track. core.autocrlf dimatikan di kedua sisi agar konversi akhir baris
# hanya mengikuti .gitattributes, sehingga blob hasil git add sama dengan blob sumber.
git -C "$repo" -c core.autocrlf=false archive --format=tar "$sha" -- "${pathspec[@]}" | tar -x -f - -C "$tujuan"
git -C "$tujuan" -c core.autocrlf=false -c core.safecrlf=false add --all --force -- .

# Daftar yang diharapkan: semua entri <ref> di luar pengecualian, lengkap dengan mode dan hash blob.
git -C "$repo" diff-tree -r -z --no-renames "$pohon_kosong" "$sha" -- "${pathspec[@]}" >"$sementara/harapan"

# Sistem berkas tanpa bit eksekusi (Windows) membuat semua berkas baru menjadi 100644; pulihkan dari sumber.
while IFS= read -r -d '' meta && IFS= read -r -d '' path; do
  if [[ $meta == ":000000 100755 "* ]]; then printf '%s\0' "$path"; fi
done <"$sementara/harapan" | git -C "$tujuan" update-index -z --chmod=+x --stdin

pohon=$(git -C "$tujuan" write-tree)
git -C "$tujuan" diff-tree -r -z --no-renames "$pohon_kosong" "$pohon" >"$sementara/aktual"
if ! cmp -s "$sementara/harapan" "$sementara/aktual"; then
  tr '\0' '\n' <"$sementara/harapan" | paste - - >"$sementara/harapan.txt"
  tr '\0' '\n' <"$sementara/aktual" | paste - - >"$sementara/aktual.txt"
  diff "$sementara/harapan.txt" "$sementara/aktual.txt" | head -n 40 >&2 || true
  gagal "isi snapshot berbeda dari $ref (selisih di atas: < sumber, > snapshot)." \
    "Periksa .gitattributes (export-ignore, filter), symlink, atau submodule."
fi

GIT_AUTHOR_NAME=$NAMA_GIT GIT_AUTHOR_EMAIL=$EMAIL_GIT GIT_COMMITTER_NAME=$NAMA_GIT GIT_COMMITTER_EMAIL=$EMAIL_GIT \
  git -C "$tujuan" commit -q -m "$PESAN_COMMIT"

jumlah_commit=$(git -C "$tujuan" rev-list --count HEAD)
identitas=$(git -C "$tujuan" log -1 --format='%an <%ae>|%cn <%ce>')
[[ $jumlah_commit == 1 ]] || gagal "snapshot memuat $jumlah_commit commit, seharusnya 1"
[[ $identitas == "$NAMA_GIT <$EMAIL_GIT>|$NAMA_GIT <$EMAIL_GIT>" ]] || gagal "identitas commit tidak sesuai: $identitas"
sisa_internal=$(git -C "$tujuan" ls-files -- "$SELALU_DIBUANG")
[[ -z $sisa_internal ]] || gagal "$SELALU_DIBUANG/ masih ikut snapshot"

# Hanya nama berkas yang dicetak, bukan isi baris, agar data yang tersisa tidak tersalin ke log terminal.
rc_pola=0
cocok_pola=$(git -C "$tujuan" grep -I -i -l -E "$POLA_PERIKSA") || rc_pola=$?
((rc_pola <= 1)) || gagal "gagal memindai pola sisa jejak di snapshot"

jumlah_berkas=$(git -C "$tujuan" ls-files | wc -l | tr -d ' ')
commit_baru=$(git -C "$tujuan" rev-parse HEAD)
t=$(printf '%q' "$tujuan")

printf '\nSnapshot selesai.\n'
printf '  Sumber   : %s @ %s (%s)\n' "$repo" "$sha" "$ref"
printf '  Tujuan   : %s\n' "$tujuan"
printf '  Commit   : %s %s\n' "$commit_baru" "$PESAN_COMMIT"
printf '  Identitas: %s <%s>\n' "$NAMA_GIT" "$EMAIL_GIT"
printf '             (author dan committer; juga user.name/user.email lokal repo baru)\n'
printf '  Berkas   : %s\n' "$jumlah_berkas"
printf '  Dibuang  : %s\n' "${dibuang[*]}"
if [[ -n $cocok_pola ]]; then
  printf '\nPERINGATAN: berkas berikut cocok dengan pola sisa jejak (%s).\n' "$POLA_PERIKSA" >&2
  printf 'Bersihkan di repo kerja, merge, lalu buat snapshot ulang sebelum dipush:\n' >&2
  while IFS= read -r berkas; do printf '  %s\n' "$berkas"; done <<<"$cocok_pola" >&2
fi
cat <<EOF

Langkah lanjutan (skrip ini TIDAK menjalankannya; ikuti docs/internal/publikasi/README.md):
  1. Periksa isi snapshot (README bagian 2 langkah 3), juga dengan pemindai rahasia bila ada:
       git -C $t show --stat --format=fuller HEAD | head -n 20
       git -C $t grep -n -I -i -E '${POLA_PERIKSA}' || echo "bersih"
  2. Buat repo KOSONG di GitHub (tanpa README, LICENSE, atau .gitignore), private dulu, dan matikan Actions:
       gh repo create <pemilik>/<nama-repo> --private
       gh api -X PUT repos/<pemilik>/<nama-repo>/actions/permissions -F enabled=false
  3. Hubungkan dan dorong:
       git -C $t remote add origin https://github.com/<pemilik>/<nama-repo>.git
       git -C $t push -u origin main
  4. Ubah visibilitas ke publik, selesaikan pengaturan keamanan (README bagian 4), baru nyalakan Actions.
EOF
