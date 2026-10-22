# Pedoman naskah Panduan Pengguna dan Presentasi Peluncuran

Semua teks dalam **Bahasa Indonesia** baku yang ramah (sapa pembaca dengan "Anda"), kalimat pendek dan jelas, untuk
alumni awam dan pengurus non-teknis. Jangan menyebut nama berkas kode, nama kelas, kode PRD/ADR, endpoint API, atau
detail infrastruktur (server, kontainer, alamat IP). Tulis apa yang dilihat dan dilakukan pengguna. Nama tombol, menu,
tab, dan label layar ditulis **persis** seperti di aplikasi dan dicetak tebal dengan `**...**` (satu-satunya markup
inline). Tanpa emoji. Tanpa baris baru di dalam string.

- Teks status keanggotaan mengikuti aturan D13 (`docs/runbooks/app-store-submission.md` bagian 2): jangan memakai
  "terkunci", "terbuka setelah KTA", "membuka (kembali) fitur", "fitur alumni", "mengaktifkan (kembali) KTA",
  "upgrade", "premium", "langganan". Tulis status sebagai status keanggotaan organisasi; direktori, pesan, dan
  reservasi event sebagai layanan bagi anggota terverifikasi/aktif.
- Data contoh di tangkapan layar (nama, nomor KTA, nominal) fiktif. Tarif iuran tidak dicantumkan.
- Setiap angka (masa OTP, batas unggah, masa offline KTA, batas profesi, jendela check-in, dsb) harus berasal dari kode
  atau dokumen repo, dan sumbernya dicatat di `sources`.
- Identitas organisasi diambil dari `kapdh-platform/apps/web/src/lib/organization.ts`.

## Skema bab (`sumber/konten/<id>.json`)

```json
{
  "id": "b02",
  "part": "anggota | pengurus | publik | umum | bantuan",
  "title": "Judul bab (maks 48 karakter)",
  "kicker": "Label kecil di atas judul (maks 32)",
  "summary": "1-2 kalimat pembuka bab (maks 260)",
  "icon": "ph-identification-card",
  "highlights": ["3-5 poin 'Yang akan Anda pelajari', masing-masing maks 70"],
  "sections": [{ "id": "b02-1", "title": "Judul subbab (maks 60)", "blocks": [] }],
  "sources": ["path repo yang menjadi dasar (tidak dicetak)"]
}
```

`icon` adalah kelas Phosphor yang tersedia di `kapdh-mobile/mockup-html/css/icons-phosphor.css`.

| type | Bidang | Catatan |
| --- | --- | --- |
| `p` | `text` | Paragraf, maks 700 karakter. |
| `steps` | `title?`, `items: [{title?, text}]` | Langkah bernomor, 2-8 langkah, `text` maks 300. |
| `list` | `title?`, `items: [string]` | Maks 10 butir, masing-masing maks 220. |
| `screens` | `items: [{img, caption}]` | 1-3 tangkapan layar ponsel (`mobile/<nama>.png`). Satu layar ditata berdampingan dengan blok teks di dekatnya. `caption` maks 90. |
| `shot` | `img`, `caption` | Tangkapan layar lebar (`admin/...` atau `web/...`). `caption` maks 140. |
| `callout` | `variant`, `title?`, `text` | `tip`, `info`, `warning`, `penting`. `text` maks 400. |
| `table` | `title?`, `columns`, `rows` | 2-4 kolom, maks 12 baris, sel maks 200. |
| `status` | `title?`, `items: [{label, tone, text}]` | Chip status: `success`, `warning`, `danger`, `info`, `neutral`. |
| `faq` | `items: [{q, a}]` | `a` maks 600. |

Nama gambar diawali id bab (`b04-kta-aktif.png`); gambar presentasi diawali `deck-`.

## Skema presentasi (`sumber/konten/presentasi.json`)

`{ "title": "...", "slides": [ { "type": "...", ..., "notes": "catatan pembicara 50-160 kata" } ] }`

| type | Bidang (batas karakter) |
| --- | --- |
| `cover` | `title` (40), `subtitle` (100), `meta` (60) |
| `agenda` | `title` (40), `items` 3-6 x (40) |
| `statement` | `kicker` (30), `title` (80), `text` (220) |
| `split` | `title` (60), `left`/`right`: `{title (30), points 2-4 x (90)}` |
| `features` | `title` (60), `subtitle?` (120), `items` 4-6 x `{icon, title (26), text (90)}` |
| `phone` | `kicker?` (30), `title` (60), `text` (220), `bullets` 0-4 x (80), `screens` 1-3 |
| `wide` | `kicker?` (30), `title` (60), `text` (200), `bullets` 0-3 x (80), `img` |
| `steps` | `title` (60), `steps` 3-5 x `{title (26), text (90)}` |
| `stats` | `title` (60), `items` 3-4 x `{value (10), label (48)}` |
| `section` | `number`, `title` (40), `subtitle` (120) |
| `timeline` | `title` (60), `items` 3-5 x `{date (24), title (40), text (90)}` |
| `cta` | `title` (60), `text` (200), `actions` 1-3 x `{label (30), url}`, `qr?` |
| `closing` | `title` (40), `text` (160), `contact` (100) |

`node validate.mjs <berkas>` memeriksa semua aturan di atas dan keberadaan gambar.
