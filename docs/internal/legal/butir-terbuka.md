# Butir terbuka naskah legal KAPDH (internal)

> **Internal pengurus.** Folder `docs/internal/` tidak ikut snapshot publik repositori. Jangan menautkan berkas ini
> dari dokumen publik dan jangan menyalin isinya ke folder lain.

Berkas ini melengkapi `docs/legal/README.md`. Isinya dipindah apa adanya dari README tersebut pada 19 Oktober 2026
karena memuat kesenjangan kepatuhan yang belum ditutup. Bila sebuah butir selesai, hapus dari berkas ini; bila
penyelesaiannya mengubah naskah, perbarui berkas di `docs/legal/` dan terbitkan ulang halaman terkait melalui web
admin.

## Penomoran

Butir di bawah memakai nomor semula di bagian "Syarat sebelum terbit" README. Butir yang tetap di README publik
dinomori ulang:

| README publik | Nomor semula | Pokok                         |
| ------------- | ------------ | ----------------------------- |
| 1             | 1            | Domain kapdh.or.id            |
| 2             | 3            | Bucket deletion ledger        |
| 3             | 4            | Backup harian dan uji restore |
| 4             | 6            | Identitas organisasi          |
| 5             | 7            | Batas usia 18 tahun           |
| 6             | 9            | Petugas bantuan@kapdh.or.id   |
| 7             | 11           | Nomor WhatsApp dukungan       |

## Syarat sebelum terbit (internal)

Butir berikut juga harus benar pada saat naskah diterbitkan. Bila belum, sebagian kalimat naskah menjadi tidak benar.

### Rincian butir 1 (domain)

Kalimat semula di README: "Saat diperiksa 15 Oktober 2026, `https://kapdh.or.id/...` masih dialihkan (308) ke situs
lama di Vercel, termasuk `/delete-account` yang membuka formulir hapus akun aplikasi lama." README publik tetap
memuat butir domain tanpa rincian aplikasi lama.

### Butir 2

**Nasib data aplikasi lama "KAPDH Alumni" sudah diputuskan** sebelum domain dipindah. Aplikasi lama menyimpan data
alumni (termasuk NIK bila pernah diisi), dan halaman kebijakan privasi serta hapus akunnya akan hilang saat domain
dipindah. Pilihannya: dihentikan dan datanya dihapus dengan pemberitahuan kepada penggunanya, atau tetap berjalan di
subdomain terpisah lengkap dengan kebijakan privasi dan halaman hapus akun yang berfungsi. Naskah baru sengaja belum
menyebut aplikasi lama; tambahkan paragraf di Kebijakan Privasi bagian 5 hanya setelah prosesnya benar-benar ada.

### Butir 5

**Ketentuan pemrosesan data (DPA) dengan setiap pemroses sudah ada dan diperiksa:** PT Cloud Hosting Indonesia
(IDCloudHost, pemilik IP VPS menurut data APNIC), Resend, Google Firebase (setujui Data Processing and Security Terms
di konsol Firebase), Cloudflare, Amazon Web Services (penerima email masuk kapdh.or.id menurut catatan MX), dan
penyedia object storage (IS3 IDCloudHost, ketentuan layanan yang sama dengan VPS). Kebijakan Privasi bagian 8
menyatakan para pemroses terikat ketentuan pemrosesan data dengan pelindungan yang sama atau setara (syarat Apple
5.1.1).

### Butir 8

**Akun yang menyetujui naskah DRAF diperiksa.** Production sudah membuka pendaftaran dengan versi legal 1 (teks DRAF).
Bila hanya ada akun uji, hapus akun tersebut. Buat akun demo untuk reviewer toko **setelah** naskah final terbit.

### Butir 10

**Dokumen internal tersedia** (tidak dipublikasikan): penilaian dampak pelindungan data (DPIA) untuk bukti pembayaran,
analisis kepentingan yang sah untuk keamanan, audit, dan moderasi, serta catatan aktivitas pemrosesan. Kebijakan
Privasi menawarkan penjelasan pertimbangan kepentingan yang sah atas permintaan.

## Butir terbuka lain

Butir berikut tidak membuat naskah keliru, tetapi perlu keputusan pemilik atau perubahan aplikasi. Bila salah satunya
diselesaikan, naskah terkait perlu diterbitkan ulang.

- **Font Poppins diunduh dari Google Fonts saat aplikasi berjalan.** Naskah mengungkapkannya dengan jujur (Kebijakan
  Privasi bagian 8, 9, 10, dan 17), tetapi pengiriman alamat IP ke Google ini tidak punya perjanjian pemrosesan. Sangat
  disarankan membundel Poppins sebagai aset sebelum rilis. Setelah dibundel, hapus butir Google Fonts di bagian 8,
  butir unduhan huruf di bagian 9 (daftar dan pelindungan), serta kata "huruf" pada bagian 10 dan 17, lalu terbitkan
  ulang. Selaraskan formulir Data safety dan App Privacy.
- **Email akun aktif belum dapat diganti** (tidak ada alur di aplikasi, web admin, maupun CLI). Naskah menyatakannya
  apa adanya. Disarankan membuat alur ganti email terverifikasi. Teks aplikasi di
  `kapdh-mobile/lib/features/account/profile_edit_screen.dart` ("email diubah lewat alur verifikasi email")
  bertentangan dengan naskah dan perlu diperbaiki.
- **Pendaftaran yang tidak pernah diverifikasi disimpan tanpa batas** (tidak ada job pembersih akun `pending_otp`).
  Disarankan job yang menghapusnya setelah 30 hari, lalu tambahkan masa itu di Kebijakan Privasi bagian 10.
- **Pihak yang dilaporkan tidak diberi tahu** saat kontennya dihapus atau dilaporkan. Permenkominfo 5/2020 Pasal 10
  ayat (4) mewajibkan pemberitahuan aduan kepada pengunggah. Putuskan bersama penasihat hukum; bila diterapkan, ubah
  Ketentuan Komunitas bagian 8.
- **Apple 1.2:** filter otomatis saat ini hanya menolak karakter tersembunyi dan tautan berbahaya, dan target laporan
  non-ancaman 2 hari kerja. Pertimbangkan filter kata kasar, cabul, dan SARA serta target 24 jam, atau siapkan catatan
  reviewer yang menjelaskan proses moderasi.
- **Teks izin iOS** (`Info.plist`, kamera dan galeri) baru menyebut bukti transfer dan foto profil. Tambahkan foto
  grup dan gambar chat agar sesuai Kebijakan Privasi bagian 18.
- **Notifikasi push** belum aktif di konfigurasi build yang ada di repo (`PUSH_ENABLED=false`, entitlement APNs belum
  ada). Naskah sudah ditulis "bila tersedia", sehingga tetap benar sebelum dan sesudah push diaktifkan.
- **Hari kerja** di naskah berarti Senin sampai Jumat WIB, sama dengan perhitungan sistem (belum ada kalender libur
  nasional). Bila pemilik ingin hari libur dikecualikan, kalender libur harus ditambahkan ke kode lebih dahulu.
- **Pelacakan galat (GlitchTip)** bila diaktifkan hanya menerima data teknis tanpa data pribadi, sebagaimana tertulis
  di Kebijakan Privasi bagian 4.11. Pertahankan daftar putih field yang ada.
- **Teks aplikasi tentang iuran** yang masih memakai istilah "terkunci" atau "membuka fitur" tercatat sebagai pemblokir
  submit di `docs/runbooks/app-store-submission.md` bagian 2. Naskah halaman sudah memakai rumusan status keanggotaan.
- **Bantuan di iOS** memuat langkah pembayaran transfer. Bila reviewer Apple mempermasalahkannya, pertimbangkan versi
  Bantuan yang lebih ringkas untuk bagian iuran.
