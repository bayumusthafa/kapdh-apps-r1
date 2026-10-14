import {
  admins,
  alumni,
  appSettings,
  auditLogs,
  banners,
  categories,
  events,
  masterProfessions,
  masterSkills,
  MIGRATIONS_FOLDER,
  mfaTotp,
  pages,
  paymentMethods,
  payments,
  posts,
  users,
} from "@kapdh/database";
import { DEV_IDS } from "@kapdh/database/seeds/dev";
import { REFERENCE_SETTINGS } from "@kapdh/database/seeds/reference";
import { and, count, eq, inArray, like, ne, notInArray, or, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTING_KEYS, SETTING_SCHEMAS, type SettingKey, type SettingValue } from "../core/settings/keys.js";
import { rows } from "../core/db/rows.js";
import type { Db, DbOrTx } from "../core/db/types.js";

/**
 * Gerbang go-live / rilis production (PRD 9.2 skenario "production dideploy dengan konfigurasi yang belum disahkan
 * ... gerbang menolak go-live", PRD 9.3, PRD 8.2 langkah 2-4, PRD 10.2 "Konfigurasi produksi belum disahkan", U-12;
 * temuan audit D2-02 dan D4-01). Hanya MEMBACA database (transaksi read only, snapshot repeatable read) dan tidak
 * pernah mengubah apa pun; dijalankan job rilis (infra/scripts/release-job.sh) setelah migrasi dan seed referensi,
 * dan oleh operator sebelum go-live (docs/runbooks/rilis-dan-gerbang-go-live.md).
 *
 * Gerbang TIDAK dipasang di /health/ready: konfigurasi yang belum disahkan adalah alasan menunda go-live atau
 * promosi image, bukan alasan mengeluarkan API yang sedang melayani dari load balancer (PRD 8.4).
 *
 * Keluaran tidak memuat secret, email, nama anggota, maupun nomor rekening utuh (N-14): hanya hitungan, nama tampilan
 * pengurus, dan nomor rekening organisasi yang disamarkan untuk ditandatangani bendahara (PRD 9.3).
 */

export type GateCheckId =
  | "schema"
  | "settings"
  | "fees"
  | "payment_methods"
  | "super_admins"
  | "payment_deciders"
  | "legal_pages"
  | "masters"
  | "support_contact"
  | "dev_fixtures";

export interface GateCheck {
  id: GateCheckId;
  title: string;
  /** Rujukan PRD/keputusan untuk bukti gerbang. */
  ref: string;
  ok: boolean;
  /** Alasan penolakan (kosong bila lulus). */
  problems: string[];
  /** Ringkasan untuk ditinjau/ditandatangani (tidak memuat data pribadi). */
  details: string[];
}

export interface GateReport {
  ok: boolean;
  checkedAt: string;
  database: { name: string; role: string };
  checks: GateCheck[];
  /** Catatan tidak memblokir (mis. mode maintenance aktif, tautan toko belum diisi). */
  notes: string[];
}

/** Minimal Super Admin aktif ber-TOTP sebelum go-live (PRD 8.2 langkah 3, D1). */
export const MIN_SUPER_ADMINS_WITH_TOTP = 2;
/** Minimal pengurus yang dapat memutus pembayaran (PRD 2.3, disahkan v3.2; PRD 10.2). */
export const MIN_PAYMENT_DECIDERS = 2;

/** Halaman yang wajib terbit dengan naskah resmi (PRD 8.2 langkah 4: privasi, ketentuan, komunitas, bantuan). */
export const REQUIRED_PAGES: readonly { slug: string; legalKey: LegalKey | null }[] = [
  { slug: "kebijakan-privasi", legalKey: "privacy_version" },
  { slug: "ketentuan", legalKey: "terms_version" },
  { slug: "ketentuan-komunitas", legalKey: "community_version" },
  { slug: "bantuan", legalKey: null },
];
type LegalKey = "privacy_version" | "terms_version" | "community_version";

/** Penanda kerangka DRAF dari seed referensi (packages/database/seeds/reference.ts DRAFT_NOTICE). */
export const DRAFT_SHELL_MARKER = "naskah resmi halaman ini belum disahkan";

/** Penanda fixture sintetis seed dev (packages/database/seeds/dev.ts). */
export const FIXTURE_TITLE_MARKER = "[Contoh]";
/** Domain email cadangan RFC 2606/6761 yang dipakai fixture (`contoh1@kapdh.test`); tidak dapat menerima OTP. */
export const FIXTURE_EMAIL_PATTERN = "\\.(test|example|invalid|localhost)$";

const FEE_LABELS = {
  registration_fee: "Registrasi alumni baru",
  card_fee: "Pembuatan KTA",
  renewal_fee: "Perpanjangan per tahun",
} as const;

function check(id: GateCheckId, title: string, ref: string): GateCheck {
  return { id, title, ref, ok: true, problems: [], details: [] };
}

function fail(c: GateCheck, problem: string): void {
  c.ok = false;
  c.problems.push(problem);
}

/** Nominal Money string "50000.00" → "Rp50.000" (ARCHITECTURE §2.5; tanpa aritmetika floating point). */
export function formatRupiah(money: string): string {
  const [whole = "0", cents = "00"] = money.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return cents === "00" ? `Rp${grouped}` : `Rp${grouped},${cents}`;
}

/** Nominal Money string bernilai nol (0, 0.00, 000.00). */
function isZeroMoney(money: string): boolean {
  return /^0+(\.0+)?$/.test(money);
}

/** Nomor rekening organisasi disamarkan: hanya 4 digit terakhir (bukti tanda tangan bendahara, N-14). */
export function maskAccountNumber(accountNumber: string): string {
  const compact = accountNumber.replace(/\s+/g, "");
  return compact.length <= 4 ? "****" : `****${compact.slice(-4)}`;
}

/** Jumlah migrasi pada journal paket database yang dibawa image ini. */
function journalEntries(): number {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
    entries: unknown[];
  };
  return journal.entries.length;
}

/**
 * Jumlah migrasi tercatat di database, atau null bila tabel bookkeeping tidak dapat dibaca role ini (roles.sql mencabut
 * akses skema drizzle dari role aplikasi). Dijalankan di luar transaksi utama agar galat hak akses tidak membatalkannya.
 */
async function appliedMigrations(db: Db): Promise<number | null> {
  try {
    // CASE menjamin urutan evaluasi: fungsi hak akses tidak dipanggil untuk skema/tabel yang tidak ada.
    const [present] = rows<{ readable: boolean }>(
      await db.execute(sql`
        select case
          when to_regnamespace('drizzle') is null then false
          when not has_schema_privilege('drizzle', 'USAGE') then false
          when to_regclass('drizzle.__drizzle_migrations') is null then false
          else has_table_privilege('drizzle.__drizzle_migrations', 'SELECT')
        end as readable`),
    );
    if (!present?.readable) return null;
    const [row] = rows<{ n: number }>(
      await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`),
    );
    return row?.n ?? 0;
  } catch {
    return null;
  }
}

async function checkSchema(db: Db): Promise<GateCheck> {
  const c = check("schema", "Skema database pada versi rilis", "PRD 5.5, 8.2 langkah 2");
  const expected = journalEntries();
  const applied = await appliedMigrations(db);
  if (applied === null) {
    c.details.push(
      `Jumlah migrasi tercatat tidak dapat dibaca role ini; journal image memuat ${expected} migrasi. ` +
        "Jalankan gerbang dengan role kapdh_migrator untuk pemeriksaan ini.",
    );
    return c;
  }
  c.details.push(`Migrasi tercatat ${applied}, journal image ${expected}.`);
  if (applied < expected)
    fail(c, `Skema tertinggal: ${expected - applied} migrasi belum diterapkan. Jalankan job migrasi dahulu.`);
  if (applied > expected)
    fail(
      c,
      `Database memuat ${applied - expected} migrasi yang tidak dikenal image ini (image lebih lama dari skema). ` +
        "Jangan mempromosikan image lama ke skema baru (PRD 8.4).",
    );
  return c;
}

interface SettingRow {
  value: unknown;
  version: number;
  updatedByAdminId: string | null;
}
type SettingRows = Map<string, SettingRow>;

async function loadSettings(tx: DbOrTx): Promise<SettingRows> {
  const found = await tx
    .select({
      key: appSettings.key,
      value: appSettings.value,
      version: appSettings.version,
      updatedByAdminId: appSettings.updatedByAdminId,
    })
    .from(appSettings);
  return new Map(found.map((r) => [r.key, r]));
}

function checkSettings(settings: SettingRows): GateCheck {
  const c = check(
    "settings",
    "Seluruh app_settings tersimpan dan valid",
    "PRD 8.2 langkah 4; ARCHITECTURE §5.4",
  );
  const missing = SETTING_KEYS.filter((key) => !settings.has(key));
  if (missing.length > 0)
    fail(
      c,
      `Kunci app_settings belum tersimpan (API diam-diam memakai nilai bawaan versi 0): ${missing.join(", ")}. ` +
        "Jalankan seed:reference.",
    );
  for (const key of SETTING_KEYS) {
    const row = settings.get(key);
    if (row && !SETTING_SCHEMAS[key].safeParse(row.value).success)
      fail(c, `app_settings ${key} versi ${row.version} tidak sesuai skema.`);
  }
  if (c.ok) c.details.push(`${SETTING_KEYS.length} kunci tersimpan dan valid.`);
  return c;
}

function settingValue<K extends SettingKey>(
  settings: SettingRows,
  key: K,
): { value: SettingValue<K>; row: SettingRow } | null {
  const row = settings.get(key);
  if (!row) return null;
  const parsed = SETTING_SCHEMAS[key].safeParse(row.value);
  return parsed.success ? { value: parsed.data as SettingValue<K>, row } : null;
}

async function checkFees(tx: DbOrTx, settings: SettingRows): Promise<GateCheck> {
  const c = check(
    "fees",
    "Nominal iuran tersimpan, tidak nol, dan tersahkan",
    "D4; PRD 8.2 langkah 4, 9.2, 9.3",
  );
  const fees = settingValue(settings, "fees");
  if (!fees) {
    fail(
      c,
      settings.has("fees")
        ? "app_settings fees tidak valid."
        : "Nominal kosong: app_settings fees belum tersimpan (versi 0). Jalankan seed:reference.",
    );
    return c;
  }
  const { value, row } = fees;
  for (const key of Object.keys(FEE_LABELS) as (keyof typeof FEE_LABELS)[]) {
    c.details.push(`${FEE_LABELS[key]}: ${formatRupiah(value[key])}`);
    if (isZeroMoney(value[key])) fail(c, `${FEE_LABELS[key]} bernilai Rp0 (nominal kosong).`);
  }
  const d4 = REFERENCE_SETTINGS.fees as Record<keyof typeof FEE_LABELS, string>;
  const sameAsD4 = (Object.keys(FEE_LABELS) as (keyof typeof FEE_LABELS)[]).every((k) => value[k] === d4[k]);
  let source: string;
  if (row.updatedByAdminId) {
    const [admin] = await tx
      .select({ displayName: admins.displayName })
      .from(admins)
      .where(eq(admins.id, row.updatedByAdminId));
    source = `ditetapkan pengurus ${admin?.displayName ?? "(admin dihapus)"} lewat web admin (audit settings.updated)`;
  } else if (sameAsD4) {
    source = "nilai awal D4 dari seed referensi (disahkan PRD v3.3)";
  } else {
    source = "tidak diketahui";
    fail(
      c,
      "Nominal berbeda dari D4 tetapi tidak tercatat diubah pengurus (updated_by_admin_id kosong): kemungkinan " +
        "diubah langsung di database. Tetapkan ulang lewat web admin (tab Biaya).",
    );
  }
  c.details.push(`Versi ${row.version}; sumber: ${source}.`);
  c.details.push("Bendahara menandatangani nominal di atas pada bukti gerbang (PRD 9.3).");
  return c;
}

async function checkPaymentMethods(tx: DbOrTx): Promise<GateCheck> {
  const c = check(
    "payment_methods",
    "Metode bayar aktif dibuat lewat web admin",
    "D13; PRD 8.2 langkah 4, 9.3",
  );
  const active = await tx
    .select({
      id: paymentMethods.id,
      kind: paymentMethods.kind,
      provider: paymentMethods.provider,
      accountNumber: paymentMethods.accountNumber,
      accountHolder: paymentMethods.accountHolder,
    })
    .from(paymentMethods)
    .where(eq(paymentMethods.active, true))
    .orderBy(paymentMethods.sortOrder, paymentMethods.id);
  if (active.length === 0) {
    fail(c, "Tidak ada metode bayar aktif; anggota tidak dapat membayar iuran (D13).");
    return c;
  }
  const audited = new Set(
    (
      await tx
        .select({ entityId: auditLogs.entityId })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "payment_method.created"),
            inArray(
              auditLogs.entityId,
              active.map((m) => m.id),
            ),
          ),
        )
    ).map((r) => r.entityId),
  );
  for (const m of active) {
    c.details.push(`${m.provider} (${m.kind}) ${maskAccountNumber(m.accountNumber)} a.n. ${m.accountHolder}`);
    const fixture =
      m.id === DEV_IDS.paymentMethod ||
      /\[[^\]]*contoh[^\]]*\]|\(contoh\)/i.test(`${m.provider} ${m.accountHolder}`) ||
      /^0+$/.test(m.accountNumber.replace(/\s+/g, ""));
    if (fixture) fail(c, `Metode "${m.provider}" adalah fixture/contoh, bukan rekening organisasi.`);
    else if (!audited.has(m.id))
      fail(
        c,
        `Metode "${m.provider}" tidak tercatat dibuat lewat web admin (audit payment_method.created tidak ada).`,
      );
  }
  c.details.push("Bendahara menandatangani daftar metode di atas pada bukti gerbang (PRD 9.3).");
  return c;
}

/** Admin yang dapat login: admins.status active DAN users.status active (definisi penjaga migrasi 0002). */
async function usableAdmins(tx: DbOrTx) {
  return tx
    .select({
      id: admins.id,
      displayName: admins.displayName,
      role: admins.role,
      totpVerified: sql<boolean>`${mfaTotp.verifiedAt} is not null`,
      canDecide: sql<boolean>`exists (
        select 1 from app.admin_permissions r
        where r.admin_id = ${admins.id} and r.permission = 'payments.decide')
        and exists (
        select 1 from app.admin_permissions r
        where r.admin_id = ${admins.id} and r.permission = 'payments.read')`,
    })
    .from(admins)
    .innerJoin(users, eq(users.id, admins.userId))
    .leftJoin(mfaTotp, eq(mfaTotp.userId, admins.userId))
    .where(and(eq(admins.status, "active"), eq(users.status, "active")))
    .orderBy(admins.displayName, admins.id);
}

async function checkSuperAdmins(tx: DbOrTx, usable: Awaited<ReturnType<typeof usableAdmins>>) {
  const c = check(
    "super_admins",
    `Minimal ${MIN_SUPER_ADMINS_WITH_TOTP} Super Admin aktif dengan TOTP terverifikasi`,
    "PRD 8.2 langkah 3, 9.2; D1; N-08",
  );
  const supers = usable.filter((a) => a.role === "super_admin");
  const withTotp = supers.filter((a) => a.totpVerified);
  for (const a of supers) c.details.push(`${a.displayName}: ${a.totpVerified ? "TOTP aktif" : "TANPA TOTP"}`);
  const [invited] = await tx
    .select({ n: count() })
    .from(admins)
    .where(and(eq(admins.role, "super_admin"), eq(admins.status, "invited")));
  if ((invited?.n ?? 0) > 0)
    c.details.push(`${invited!.n} Super Admin masih menunggu aktivasi undangan (belum dihitung).`);
  if (withTotp.length < MIN_SUPER_ADMINS_WITH_TOTP)
    fail(
      c,
      `Super Admin aktif ber-TOTP: ${withTotp.length} dari minimal ${MIN_SUPER_ADMINS_WITH_TOTP}. ` +
        "Bootstrap/undang Super Admin dan selesaikan pendaftaran TOTP.",
    );
  return c;
}

function checkPaymentDeciders(usable: Awaited<ReturnType<typeof usableAdmins>>): GateCheck {
  const c = check(
    "payment_deciders",
    `Minimal ${MIN_PAYMENT_DECIDERS} pengurus ber-TOTP dapat memutus pembayaran`,
    "PRD 2.3 (disahkan v3.2), 10.2",
  );
  const deciders = usable.filter((a) => a.totpVerified && (a.role === "super_admin" || a.canDecide));
  c.details.push(
    `Pengurus dengan payments.read + payments.decide (termasuk Super Admin): ${deciders.length}` +
      (deciders.length > 0 ? ` (${deciders.map((a) => a.displayName).join(", ")}).` : "."),
  );
  if (deciders.length < MIN_PAYMENT_DECIDERS)
    fail(
      c,
      `Hanya ${deciders.length} pengurus yang dapat memutus pembayaran; minimal ${MIN_PAYMENT_DECIDERS} agar ` +
        "pembayaran milik pengurus tetap dapat diproses (konflik kepentingan).",
    );
  return c;
}

async function checkLegalPages(tx: DbOrTx, settings: SettingRows): Promise<GateCheck> {
  const c = check(
    "legal_pages",
    "Halaman legal dan bantuan terbit dengan naskah resmi",
    "PRD 8.2 langkah 4; F-01, F-08",
  );
  const found = await tx
    .select({
      slug: pages.slug,
      publishedVersion: pages.publishedVersion,
      publishedBodyHtml: pages.publishedBodyHtml,
    })
    .from(pages)
    .where(
      inArray(
        pages.slug,
        REQUIRED_PAGES.map((p) => p.slug),
      ),
    );
  const bySlug = new Map(found.map((p) => [p.slug, p]));
  const legal = settingValue(settings, "legal")?.value ?? null;
  for (const required of REQUIRED_PAGES) {
    const page = bySlug.get(required.slug);
    if (!page) {
      fail(c, `Halaman ${required.slug} tidak ada. Jalankan seed:reference.`);
      continue;
    }
    if (page.publishedVersion === null) {
      fail(c, `Halaman ${required.slug} belum diterbitkan.`);
      continue;
    }
    if ((page.publishedBodyHtml ?? "").includes(DRAFT_SHELL_MARKER)) {
      fail(c, `Halaman ${required.slug} versi ${page.publishedVersion} masih kerangka DRAF seed referensi.`);
      continue;
    }
    c.details.push(`${required.slug}: versi tayang ${page.publishedVersion}`);
    if (required.legalKey) {
      const recorded = legal?.[required.legalKey] ?? null;
      if (recorded !== String(page.publishedVersion))
        fail(
          c,
          `app_settings legal.${required.legalKey} (${recorded ?? "kosong"}) tidak sama dengan versi tayang ` +
            `${required.slug} (${page.publishedVersion}); registrasi memakai versi persetujuan yang salah.`,
        );
    }
  }
  return c;
}

async function checkMasters(tx: DbOrTx): Promise<GateCheck> {
  const c = check(
    "masters",
    "Master profesi dan keahlian sudah ditinjau dan diaktifkan",
    "PRD 8.2 langkah 4",
  );
  const [professions] = await tx
    .select({ n: count() })
    .from(masterProfessions)
    .where(eq(masterProfessions.active, true));
  const [skills] = await tx.select({ n: count() }).from(masterSkills).where(eq(masterSkills.active, true));
  c.details.push(`Profesi aktif: ${professions?.n ?? 0}; keahlian aktif: ${skills?.n ?? 0}.`);
  if ((professions?.n ?? 0) === 0)
    fail(c, "Belum ada master profesi aktif (daftar usulan seed masih nonaktif).");
  if ((skills?.n ?? 0) === 0) fail(c, "Belum ada master keahlian aktif (daftar usulan seed masih nonaktif).");
  return c;
}

function checkSupportContact(settings: SettingRows): GateCheck {
  const c = check("support_contact", "Kontak dukungan email dan WhatsApp admin", "PRD 8.2 langkah 4, 8.3");
  const support = settingValue(settings, "support")?.value ?? null;
  if (!support) {
    fail(c, "app_settings support belum tersimpan atau tidak valid.");
    return c;
  }
  c.details.push(`Email dukungan: ${support.email}; WhatsApp: ${support.whatsapp ? "terisi" : "kosong"}.`);
  if (!support.whatsapp) fail(c, "Nomor WhatsApp admin untuk dukungan belum ditetapkan (PRD 8.3).");
  return c;
}

async function checkDevFixtures(tx: DbOrTx): Promise<GateCheck> {
  const c = check(
    "dev_fixtures",
    "Tanpa fixture dev atau data sintetis",
    "PRD 7.3, 8.2 langkah 2, 9.2; ARCHITECTURE §2.14",
  );
  const devIds = Object.values(DEV_IDS) as string[];
  const marker = `%${FIXTURE_TITLE_MARKER}%`;
  const counts: [string, number][] = [];
  const add = (label: string, n: number | undefined) => {
    if ((n ?? 0) > 0) counts.push([label, n!]);
  };

  const [seedDev] = await tx.select({ n: count() }).from(auditLogs).where(eq(auditLogs.action, "seed.dev"));
  add("eksekusi seed:dev (audit seed.dev)", seedDev?.n);
  const fixtureIdCounts = await Promise.all([
    tx.select({ n: count() }).from(users).where(inArray(users.id, devIds)),
    tx.select({ n: count() }).from(paymentMethods).where(inArray(paymentMethods.id, devIds)),
    tx.select({ n: count() }).from(categories).where(inArray(categories.id, devIds)),
    tx.select({ n: count() }).from(posts).where(inArray(posts.id, devIds)),
    tx.select({ n: count() }).from(events).where(inArray(events.id, devIds)),
    tx.select({ n: count() }).from(payments).where(inArray(payments.id, devIds)),
  ]);
  add(
    "baris dengan id tetap seed dev (DEV_IDS)",
    fixtureIdCounts.reduce((sum, [row]) => sum + (row?.n ?? 0), 0),
  );
  // Akun pending_otp dikecualikan: siapa pun dapat mendaftar dengan email palsu tanpa pernah lolos OTP, jadi akun itu
  // tidak boleh dapat menahan rilis; fixture seed dev selalu berstatus aktif.
  const [fixtureEmails] = await tx
    .select({ n: count() })
    .from(users)
    .where(
      and(
        notInArray(users.status, ["deleted", "pending_otp"]),
        sql`${users.email} ~* ${FIXTURE_EMAIL_PATTERN}`,
      ),
    );
  add("akun dengan domain email uji (.test/.example/.invalid/.localhost)", fixtureEmails?.n);
  const [fixtureAlumni] = await tx
    .select({ n: count() })
    .from(alumni)
    .innerJoin(users, eq(users.id, alumni.userId))
    .where(and(ne(users.status, "deleted"), like(alumni.fullName, marker)));
  add(`alumni bernama ${FIXTURE_TITLE_MARKER}`, fixtureAlumni?.n);
  const [fixturePosts] = await tx.select({ n: count() }).from(posts).where(like(posts.title, marker));
  add(`berita berjudul ${FIXTURE_TITLE_MARKER}`, fixturePosts?.n);
  const [fixtureEvents] = await tx.select({ n: count() }).from(events).where(like(events.title, marker));
  add(`event berjudul ${FIXTURE_TITLE_MARKER}`, fixtureEvents?.n);
  const [fixtureBanners] = await tx.select({ n: count() }).from(banners).where(like(banners.title, marker));
  add(`banner berjudul ${FIXTURE_TITLE_MARKER}`, fixtureBanners?.n);
  const [fixtureMethods] = await tx
    .select({ n: count() })
    .from(paymentMethods)
    .where(
      or(
        like(paymentMethods.provider, marker),
        like(paymentMethods.provider, "%[Bank Contoh]%"),
        like(paymentMethods.accountHolder, "%(Contoh)%"),
      ),
    );
  add("metode bayar contoh", fixtureMethods?.n);
  const [fixtureCategories] = await tx
    .select({ n: count() })
    .from(categories)
    .where(like(categories.label, marker));
  add(`kategori berlabel ${FIXTURE_TITLE_MARKER}`, fixtureCategories?.n);

  for (const [label, n] of counts) fail(c, `Fixture dev terdeteksi: ${n} ${label}.`);
  if (c.ok) c.details.push("Tidak ada penanda fixture dev.");
  else
    c.details.push(
      "Production dimulai dari database kosong (PRD 8.2); hapus lingkungan lalu inisialisasi ulang, jangan menghapus " +
        "baris satu per satu (PRD 8.4).",
    );
  return c;
}

function notesFor(settings: SettingRows): string[] {
  const notes: string[] = [];
  const maintenance = settingValue(settings, "maintenance")?.value;
  if (maintenance?.active) notes.push("Mode maintenance AKTIF: mutasi anggota ditolak 503 sampai dimatikan.");
  const links = settingValue(settings, "store_links")?.value;
  if (links && (!links.android || !links.ios))
    notes.push(
      "Tautan toko aplikasi belum lengkap; wajar sebelum review toko (PRD 8.3 langkah 4), wajib sebelum menaikkan " +
        "versi minimum.",
    );
  const instructions = settingValue(settings, "payment_instructions")?.value;
  if (instructions && instructions.dues_hidden_platforms.length > 0)
    notes.push(
      `Instruksi bayar iuran disembunyikan untuk: ${instructions.dues_hidden_platforms.join(", ")} (D13 cadangan iOS).`,
    );
  return notes;
}

/**
 * Menjalankan seluruh pemeriksaan gerbang. Tidak pernah menulis: pemeriksaan data berjalan dalam satu transaksi
 * `repeatable read, read only` sehingga hasilnya konsisten dan aman dijalankan dengan role pemilik skema.
 */
export async function runGoLiveGate(db: Db, options: { now?: Date } = {}): Promise<GateReport> {
  const now = options.now ?? new Date();
  const [identity] = rows<{ name: string; role: string }>(
    await db.execute(sql`select current_database() as name, current_user as role`),
  );
  const schema = await checkSchema(db);
  const { checks, notes } = await db.transaction(
    async (tx) => {
      const settings = await loadSettings(tx);
      const usable = await usableAdmins(tx);
      return {
        checks: [
          checkSettings(settings),
          await checkFees(tx, settings),
          await checkPaymentMethods(tx),
          await checkSuperAdmins(tx, usable),
          checkPaymentDeciders(usable),
          await checkLegalPages(tx, settings),
          await checkMasters(tx),
          checkSupportContact(settings),
          await checkDevFixtures(tx),
        ],
        notes: notesFor(settings),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  const all = [schema, ...checks];
  return {
    ok: all.every((c) => c.ok),
    checkedAt: now.toISOString(),
    database: { name: identity?.name ?? "?", role: identity?.role ?? "?" },
    checks: all,
    notes,
  };
}
