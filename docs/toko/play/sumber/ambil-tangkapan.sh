#!/usr/bin/env bash
# Mengambil tangkapan layar ponsel untuk listing Google Play dari build rilis KAPDH di emulator atau perangkat Android.
# Prasyarat dan urutan kerja: docs/toko/play/tangkapan-layar.md. Aplikasi sudah terpasang (build rilis) dan sudah
# masuk dengan akun demo aktif sebelum skrip dijalankan.
#
#   bash docs/toko/play/sumber/ambil-tangkapan.sh                 semua layar
#   bash docs/toko/play/sumber/ambil-tangkapan.sh kta jejaring    sebagian layar (nama di DAFTAR di bawah)
#
# Variabel lingkungan:
#   ADB             path adb; bawaan adb di PATH, lalu $LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe
#   ANDROID_SERIAL  perangkat tujuan bila lebih dari satu yang tersambung
#   EVENT_ID        id event untuk layar event (kosong: daftar event)
#   BERITA_SLUG     slug berita untuk layar berita (kosong: daftar berita)
#   CHAT_ROOM_ID    id percakapan untuk layar pesan; kosong: tab Jejaring dibuka dan skrip menunggu Enter setelah
#                   percakapan dibuka dengan tangan (butuh terminal interaktif)
#   JEDA            detik tunggu setelah layar dibuka (bawaan 5)
#   MANUAL=1        tunggu Enter sebelum setiap pengambilan, untuk menggulir atau menata layar dengan tangan
#   SAMARKAN        kotak tambahan yang diburamkan pada semua layar, "x,y,w,h" dipisah titik koma
#   KELUARAN        folder hasil; bawaan docs/toko/play/tangkapan
#   UJI_TANPA_LOGIN=1  hanya untuk menguji skrip: lewati pemeriksaan teks layar dan QR
#
# Skrip mengubah ukuran layar ke 1080x1920 (9:16, density 420), memaksa tema terang dan skala huruf 1.0, menyalakan
# demo mode status bar (jam 09.00, baterai dan Wi-Fi penuh, tanpa ikon seluler dan notifikasi; label jenis jaringan
# seluler seperti "3G" tidak dapat diatur di semua image), lalu mengembalikan semuanya
# saat selesai atau gagal.
set -euo pipefail

PAKET=id.or.kapdh.app
SUMBER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KELUARAN="${KELUARAN:-$SUMBER/../tangkapan}"
JEDA="${JEDA:-5}"
KERJA="$(mktemp -d "${TMPDIR:-/tmp}/kapdh-tangkapan.XXXXXX")"

if [ -z "${ADB:-}" ]; then
  if command -v adb >/dev/null 2>&1; then ADB=adb
  elif [ -n "${LOCALAPPDATA:-}" ] && [ -x "$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe" ]; then ADB="$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe"
  else echo "adb tidak ditemukan; isi ADB=<path adb>" >&2; exit 2
  fi
fi
# Git Bash di Windows: jangan ubah argumen adb (kapdh://..., /sdcard/...) menjadi path Windows.
adb() { MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' "$ADB" "$@"; }
sh_() { adb shell "$@" | tr -d '\r'; }

# Nama layar, nomor urut di listing, deep link (kapdh://app/<rute>, lib/app/routes.dart).
DAFTAR=(beranda kta event berita jejaring pesan)
urut() { case "$1" in beranda) echo 01;; kta) echo 02;; event) echo 03;; berita) echo 04;; jejaring) echo 05;; pesan) echo 06;; esac; }
tautan() {
  case "$1" in
    beranda) echo "kapdh://app/home" ;;
    kta) echo "kapdh://app/kta" ;;
    event) echo "kapdh://app/events${EVENT_ID:+/$EVENT_ID}" ;;
    berita) echo "kapdh://app/news${BERITA_SLUG:+/$BERITA_SLUG}" ;;
    jejaring) echo "kapdh://app/network" ;;
    pesan) if [ -n "${CHAT_ROOM_ID:-}" ]; then echo "kapdh://app/chat/$CHAT_ROOM_ID"; else echo "kapdh://app/network"; fi ;;
  esac
}

# ---------------------------------------------------------------- pemeriksaan awal
[ "$(adb get-state 2>/dev/null)" = device ] || { echo "tidak ada perangkat siap (adb devices); isi ANDROID_SERIAL bila lebih dari satu" >&2; exit 2; }
sh_ pm path "$PAKET" | grep -q '^package:' || { echo "$PAKET belum terpasang" >&2; exit 2; }
INFO_PAKET="$(sh_ dumpsys package "$PAKET")"
if grep -q 'DEBUGGABLE' <<<"$(grep -m1 'pkgFlags=' <<<"$INFO_PAKET")"; then
  echo "$PAKET terpasang sebagai build debug/profile (ada banner DEBUG dan performa berbeda); pasang build rilis" >&2
  exit 2
fi
echo "Perangkat: $(sh_ getprop ro.product.model), Android $(sh_ getprop ro.build.version.release); $PAKET $(grep -m1 -o 'versionName=[^ ]*' <<<"$INFO_PAKET")"

# ---------------------------------------------------------------- tata layar (dikembalikan saat keluar)
MALAM_LAMA="$(sh_ cmd uimode night | sed -n 's/^Night mode: //p')"
HURUF_LAMA="$(sh_ settings get system font_scale)"
pulihkan() {
  [ -n "$MALAM_LAMA" ] && adb shell cmd uimode night "$MALAM_LAMA" >/dev/null 2>&1 || true
  if [ "$HURUF_LAMA" = null ] || [ -z "$HURUF_LAMA" ]; then adb shell settings delete system font_scale >/dev/null 2>&1 || true
  else adb shell settings put system font_scale "$HURUF_LAMA" >/dev/null 2>&1 || true; fi
  adb shell am broadcast -a com.android.systemui.demo -e command exit >/dev/null 2>&1 || true
  adb shell settings put global sysui_demo_allowed 0 >/dev/null 2>&1 || true
  adb shell wm size reset >/dev/null 2>&1 || true
  adb shell wm density reset >/dev/null 2>&1 || true
  rm -rf "$KERJA"
}
trap pulihkan EXIT

adb shell wm size 1080x1920
adb shell wm density 420
adb shell cmd uimode night no >/dev/null
adb shell settings put system font_scale 1.0
demo() { adb shell am broadcast -a com.android.systemui.demo -e command "$@" >/dev/null; }
adb shell settings put global sysui_demo_allowed 1
demo enter
demo clock -e hhmm 0900
demo battery -e level 100 -e plugged false
demo network -e wifi show -e level 4 -e fully true
demo network -e mobile hide
demo notifications -e visible false
sleep 2
UKURAN="$(sh_ wm size | tail -1)"
case "$UKURAN" in *1080x1920*) ;; *) echo "ukuran layar tidak berubah ke 1080x1920: $UKURAN" >&2; exit 1 ;; esac

# ---------------------------------------------------------------- ambil per layar
mkdir -p "$KELUARAN"
[ $# -gt 0 ] && PILIH=("$@") || PILIH=("${DAFTAR[@]}")
GAGAL=0
for layar in "${PILIH[@]}"; do
  no="$(urut "$layar")"
  [ -n "$no" ] || { echo "layar tidak dikenal: $layar (pilihan: ${DAFTAR[*]})" >&2; GAGAL=1; continue; }
  uri="$(tautan "$layar")"
  echo "== $no-$layar: $uri"
  # Layar emulator/perangkat bisa tidur di tengah jalan; screencap layar tidur menghasilkan gambar hitam.
  adb shell input keyevent KEYCODE_WAKEUP
  adb shell wm dismiss-keyguard >/dev/null 2>&1 || true
  adb shell am start -W -a android.intent.action.VIEW -d "$uri" "$PAKET" >/dev/null
  sleep "$JEDA"
  manual="${MANUAL:-}"
  if [ "$layar" = pesan ] && [ -z "${CHAT_ROOM_ID:-}" ]; then
    echo "   CHAT_ROOM_ID kosong: buka tab Pesan lalu percakapan contoh di perangkat"
    manual=1
  fi
  if [ "$manual" = 1 ]; then
    if [ -t 0 ]; then read -r -p "   tata layar di perangkat, lalu tekan Enter untuk mengambil... " _
    else echo "   $layar dilewati: butuh terminal interaktif untuk menata layar" >&2; GAGAL=1; continue; fi
  fi
  mentah="$KERJA/$no-$layar.png"
  adb exec-out screencap -p >"$mentah"
  opsi=()
  if [ "${UJI_TANPA_LOGIN:-}" != 1 ]; then
    # Dua kali dump: dump pertama menyalakan pohon semantik Flutter, dump kedua membaca isinya.
    adb shell uiautomator dump /sdcard/kapdh-ui.xml >/dev/null 2>&1 || true
    sleep 1
    adb shell uiautomator dump /sdcard/kapdh-ui.xml >/dev/null 2>&1 || true
    adb exec-out cat /sdcard/kapdh-ui.xml >"$KERJA/$no-$layar.xml" 2>/dev/null || true
    adb shell rm -f /sdcard/kapdh-ui.xml >/dev/null 2>&1 || true
    opsi+=(--ui "$KERJA/$no-$layar.xml")
    [ "$layar" = kta ] && opsi+=(--wajib-qr)
  fi
  if [ -n "${SAMARKAN:-}" ]; then
    IFS=';' read -r -a kotak <<<"$SAMARKAN"
    for k in "${kotak[@]}"; do opsi+=(--samarkan "$k"); done
  fi
  node "$SUMBER/olah-tangkapan.mjs" "$mentah" "$KELUARAN/$no-$layar.png" ${opsi[@]+"${opsi[@]}"} || GAGAL=1
done

node "$SUMBER/cek.mjs" --tangkapan "$KELUARAN" || GAGAL=1
[ "$GAGAL" = 0 ] && echo "Selesai: $KELUARAN" || { echo "Ada layar yang gagal; periksa pesan di atas." >&2; exit 1; }
