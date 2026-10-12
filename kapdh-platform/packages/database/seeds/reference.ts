/**
 * Seed data referensi yang AMAN untuk production (PRD 8.2 langkah 4, ARCHITECTURE §5.4). Idempoten: hanya menyisipkan
 * baris yang belum ada (ON CONFLICT DO NOTHING) sehingga nilai yang sudah diubah pengurus tidak pernah ditimpa.
 * Setiap eksekusi dicatat pada audit (F-17: "bootstrap dan seed produksi").
 *
 * Isi:
 *   - app_settings untuk seluruh kunci ARCHITECTURE §5.4 (nominal D4, periode/jendela D4, event D5/D6, chat v3.2).
 *   - Daftar awal master profesi dan keahlian berstatus USULAN: disisipkan NONAKTIF dan wajib ditinjau serta
 *     diaktifkan pengurus (master.manage) di web admin sebelum go-live. Nilai yang belum disahkan memblokir go-live.
 *   - Kerangka halaman legal/informasi berstatus DRAF (published_at null); naskah resmi diisi dan diterbitkan pengurus.
 * Tidak ada fixture, akun, atau metode bayar di sini: metode bayar dikelola bendahara lewat web admin (PRD 9.3).
 *
 *   DATABASE_URL=postgres://... pnpm --filter @kapdh/database seed:reference
 */
import { v7 as uuidv7 } from "uuid";
import type { Database } from "../src/client.js";
import { pages } from "../src/schema/content.js";
import { masterProfessions, masterSkills } from "../src/schema/membership.js";
import { auditLogs } from "../src/schema/platform.js";
import { type AppSettingKey, appSettings } from "../src/schema/settings.js";
import { invokedDirectly, runSeedCli } from "./_cli.js";

/** Nilai awal app_settings (ARCHITECTURE §5.4). Money berupa string desimal (ARCHITECTURE §2.5). */
export const REFERENCE_SETTINGS: Record<AppSettingKey, Record<string, unknown>> = {
  // D4 (disahkan v3.3): register Rp50.000 + pembuatan KTA Rp10.000; perpanjangan Rp10.000/tahun.
  fees: { registration_fee: "50000.00", card_fee: "10000.00", renewal_fee: "10000.00" },
  // D4 (disahkan v3.2): periode 12 bulan dari approved_at, expiring 30 hari, jendela renewal 30 hari.
  membership: { period_months: 12, expiring_days: 30, renewal_window_days: 30 },
  // D5/D6 (disahkan v3.5): hold 24 jam, check-in 2 jam sebelum mulai, batal mandiri sampai H-3, eskalasi 2 hari kerja.
  events: {
    hold_hours: 24,
    checkin_before_hours: 2,
    self_cancel_days: 3,
    review_escalation_business_days: 2,
  },
  // D5 (disahkan v3.2): teks 4.000 karakter, grup 100 anggota.
  chat: { max_text_chars: 4000, max_group_members: 100 },
  min_app_version: { android: "1.0.0", ios: "1.0.0" },
  maintenance: { active: false, message: null, until: null },
  store_links: { android: null, ios: null },
  // PRD 8.3: kanal dukungan awal; nomor WhatsApp admin ditetapkan pengurus.
  support: { email: "bantuan@kapdh.or.id", whatsapp: null },
  // Mencerminkan versi halaman legal yang sudah diterbitkan; null selama masih draf.
  legal: { privacy_version: null, terms_version: null, community_version: null },
};

/** USULAN daftar awal profesi; wajib ditinjau pengurus. Disisipkan nonaktif. */
export const STARTER_PROFESSIONS: readonly string[] = [
  "Aparatur Sipil Negara",
  "TNI/Polri",
  "Guru",
  "Dosen/Peneliti",
  "Ustadz/Dai",
  "Pengasuh/Pengurus Pesantren",
  "Dokter",
  "Tenaga Kesehatan",
  "Advokat/Konsultan Hukum",
  "Akuntan",
  "Insinyur",
  "Profesional Teknologi Informasi",
  "Karyawan Swasta",
  "Karyawan BUMN/BUMD",
  "Pegawai Perbankan/Keuangan",
  "Wirausaha",
  "Pedagang",
  "Petani/Peternak/Nelayan",
  "Jurnalis/Pekerja Media",
  "Pekerja Kreatif",
  "Mahasiswa/Pelajar",
  "Ibu Rumah Tangga",
  "Pensiunan",
  "Lainnya",
];

/** USULAN daftar awal keahlian; wajib ditinjau pengurus. Disisipkan nonaktif. */
export const STARTER_SKILLS: readonly string[] = [
  "Bahasa Arab",
  "Bahasa Inggris",
  "Tahfidz Al-Qur'an",
  "Kajian Kitab Kuning",
  "Dakwah dan Public Speaking",
  "Pendidikan dan Pengajaran",
  "Kepemimpinan dan Organisasi",
  "Manajemen Proyek",
  "Kewirausahaan",
  "Pemasaran Digital",
  "Desain Grafis",
  "Fotografi dan Videografi",
  "Penulisan dan Jurnalistik",
  "Pemrograman",
  "Analisis Data",
  "Akuntansi dan Keuangan",
  "Hukum",
  "Kesehatan",
  "Pertanian",
  "Teknik dan Konstruksi",
  "Administrasi Perkantoran",
  "Kuliner",
];

const DRAFT_NOTICE =
  "<p><strong>DRAF</strong>: naskah resmi halaman ini belum disahkan pengurus dan wajib diganti sebelum go-live " +
  "(PRD 8.2 langkah 4).</p>";

/** Kerangka halaman informasi dan legal (F-08, PRD 8.2); dapat dibaca sebelum aktivasi setelah diterbitkan. */
export const LEGAL_PAGE_SHELLS: readonly { slug: string; title: string; outline: string[] }[] = [
  {
    slug: "kebijakan-privasi",
    title: "Kebijakan Privasi",
    outline: [
      "Data yang dikumpulkan dan tujuannya; aplikasi tidak meminta NIK/Nomor KTP.",
      "Visibilitas profil, kontak, dan tautan sosial (default tersembunyi).",
      "Penyimpanan bukti pembayaran dan akses pengurus yang berizin.",
      "Penghapusan akun di aplikasi dan di /delete-account; tanpa periode retensi data pribadi (D2).",
      "Backup harian berotasi 30 hari dengan deletion ledger.",
      "Kontak: bantuan@kapdh.or.id.",
    ],
  },
  {
    slug: "ketentuan",
    title: "Ketentuan Layanan",
    outline: [
      "Keanggotaan, iuran pendaftaran dan perpanjangan melalui transfer manual.",
      "Masa berlaku KTA 12 bulan kalender dan perpanjangan.",
      "Pemesanan event, pembatalan, dan refund manual (D6).",
      "Pembatasan akun dan pemulihan.",
    ],
  },
  {
    slug: "ketentuan-komunitas",
    title: "Ketentuan Komunitas",
    outline: [
      "Perilaku yang dilarang di direktori dan chat (spam, pelecehan, kebencian, konten seksual, ancaman, penipuan).",
      "Blokir, pelaporan, dan tindak lanjut moderasi oleh pengurus.",
      "Target penanganan laporan dan mekanisme banding.",
    ],
  },
  {
    slug: "bantuan",
    title: "Bantuan",
    outline: [
      "Cara mendaftar, verifikasi email, dan membayar iuran.",
      "Kontak dukungan: bantuan@kapdh.or.id dan WhatsApp admin.",
    ],
  },
  {
    slug: "tentang",
    title: "Tentang KAPDH",
    outline: ["Profil Keluarga Alumni Pondok Pesantren Darel Hikmah dan layanan KAPDH Apps."],
  },
];

export function draftPageBody(outline: readonly string[]): string {
  return `${DRAFT_NOTICE}<p>Bagian yang wajib dicakup:</p><ul>${outline.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

export interface ReferenceSeedSummary {
  settings_inserted: number;
  professions_inserted: number;
  skills_inserted: number;
  pages_inserted: number;
}

/** Menyisipkan data referensi yang belum ada dalam satu transaksi, beserta satu baris audit. */
export async function seedReference(
  db: Database,
  options: { now?: Date; requestId?: string } = {},
): Promise<ReferenceSeedSummary> {
  const now = options.now ?? new Date();
  const requestId = options.requestId ?? `seed-reference-${uuidv7()}`;
  return db.transaction(async (tx) => {
    const settings = await tx
      .insert(appSettings)
      .values(
        Object.entries(REFERENCE_SETTINGS).map(([key, value]) => ({
          key,
          value,
          version: 1,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ key: appSettings.key });
    const professions = await tx
      .insert(masterProfessions)
      .values(
        STARTER_PROFESSIONS.map((label, i) => ({
          id: uuidv7(),
          label,
          active: false,
          sortOrder: i + 1,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: masterProfessions.id });
    const skills = await tx
      .insert(masterSkills)
      .values(
        STARTER_SKILLS.map((label, i) => ({
          id: uuidv7(),
          label,
          active: false,
          sortOrder: i + 1,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: masterSkills.id });
    const pageRows = await tx
      .insert(pages)
      .values(
        LEGAL_PAGE_SHELLS.map((page) => ({
          id: uuidv7(),
          slug: page.slug,
          title: page.title,
          bodyHtml: draftPageBody(page.outline),
          version: 1,
          publishedAt: null,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: pages.id });

    const summary: ReferenceSeedSummary = {
      settings_inserted: settings.length,
      professions_inserted: professions.length,
      skills_inserted: skills.length,
      pages_inserted: pageRows.length,
    };
    await tx.insert(auditLogs).values({
      id: uuidv7(),
      effectiveRole: "system",
      action: "seed.reference",
      entityType: "seed",
      entityId: "reference",
      requestId,
      after: { ...summary, masters_status: "usulan_nonaktif_perlu_tinjauan", pages_status: "draf" },
      createdAt: now,
    });
    return summary;
  });
}

if (invokedDirectly(import.meta.url)) {
  runSeedCli("seed:reference", (db) => seedReference(db));
}
