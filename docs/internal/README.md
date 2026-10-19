# Catatan internal pengurus dan pengembang

> **Internal pengurus.** Folder `docs/internal/` hanya ada di repo kerja private dan **tidak ikut** snapshot
> publik. Skrip `publikasi/buat-snapshot-publik.sh` selalu membuang seluruh folder ini.

Folder ini menampung catatan yang perlu dirawat bersama kode tetapi tidak untuk umum: kesenjangan kepatuhan yang
belum ditutup, prosedur internal pengurus, dan langkah penerbitan repositori.

## Isi

| Berkas                              | Isi                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `legal/butir-terbuka.md`            | Butir kepatuhan naskah legal yang belum ditutup (pelengkap `docs/legal/`) |
| `publikasi/README.md`               | Prosedur menerbitkan repo publik yang bersih                              |
| `publikasi/buat-snapshot-publik.sh` | Skrip snapshot satu commit tanpa riwayat dan tanpa folder ini             |

## Aturan

- **Jangan menautkan** berkas di folder ini dari dokumen di luar `docs/internal/`; tautan itu putus di repo
  publik. Tautan dari sini ke dokumen publik boleh.
- **Jangan menyalin** isinya ke folder lain. Bila sebuah catatan sudah layak dibuka, pindahkan ke folder publik
  yang sesuai lalu hapus dari sini.
- **Tetap tanpa rahasia dan data pribadi.** Semua yang punya akses repo private bisa membaca folder ini, dan
  riwayat git menyimpannya selamanya. Kata sandi, token, dan kunci tetap di GitHub Secrets atau pengelola sandi;
  data anggota tetap di sistem produksi.
- Setiap dokumen Markdown baru diawali penanda **Internal pengurus** seperti di atas.
- Folder ini hanya dibuang dari isi snapshot. Riwayat repo kerja tetap memuatnya, jadi membuka repo kerja apa
  adanya ikut membuka folder ini (lihat `publikasi/README.md` bagian 5).
