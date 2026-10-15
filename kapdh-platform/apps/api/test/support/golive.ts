/**
 * Penyiapan konfigurasi production yang SUDAH disahkan untuk uji gerbang go-live (PRD 9.2, 9.3, 8.2 langkah 3-4).
 * Hanya memakai query builder Drizzle sehingga berjalan di PGlite (jalur bawaan) maupun PostgreSQL 17 (jalur PG).
 * Database harus sudah berisi seed referensi (app_settings D4, master usulan nonaktif, kerangka halaman DRAF).
 */
import {
  adminPermissions,
  admins,
  appSettings,
  auditLogs,
  files,
  masterProfessions,
  masterSkills,
  mfaTotp,
  pages,
  paymentMethods,
  users,
} from "@kapdh/database";
import { eq, inArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { REQUIRED_PAGES } from "../../src/cli/golive-gate.js";
import type { DbOrTx } from "../../src/core/db/types.js";

export interface GoLiveAdmin {
  adminId: string;
  userId: string;
}

/** Admin yang dapat login (status admin dan akun `active`) dengan TOTP terverifikasi (atau belum, bila diminta). */
export async function insertGateAdmin(
  db: DbOrTx,
  opts: {
    role?: "super_admin" | "admin";
    status?: "invited" | "active" | "disabled";
    totpVerified?: boolean;
    permissions?: string[];
    displayName?: string;
  } = {},
): Promise<GoLiveAdmin> {
  const now = new Date();
  const userId = uuidv7();
  const adminId = uuidv7();
  const status = opts.status ?? "active";
  await db.insert(users).values({
    id: userId,
    email: `pengurus-${userId}@kapdh.or.id`,
    passwordHash: "hash-uji",
    status: "active",
    kind: "admin",
    emailVerifiedAt: now,
  });
  await db.insert(admins).values({
    id: adminId,
    userId,
    displayName: opts.displayName ?? `Pengurus ${adminId.slice(-4)}`,
    role: opts.role ?? "super_admin",
    status,
    activatedAt: status === "active" || status === "disabled" ? now : null,
    disabledAt: status === "disabled" ? now : null,
    inviteTokenHash: status === "invited" ? `hash-${adminId}` : null,
    inviteExpiresAt: status === "invited" ? new Date(now.getTime() + 72 * 3600_000) : null,
  });
  // Undangan: pendaftaran TOTP belum dikonfirmasi. Aktif: TOTP terverifikasi kecuali diminta tanpa TOTP (tanpa baris).
  if (status === "invited")
    await db.insert(mfaTotp).values({ userId, secretEncrypted: "terenkripsi-uji", verifiedAt: null });
  else if (opts.totpVerified !== false)
    await db.insert(mfaTotp).values({ userId, secretEncrypted: "terenkripsi-uji", verifiedAt: now });
  for (const permission of opts.permissions ?? [])
    await db.insert(adminPermissions).values({ adminId, permission: permission as never });
  return { adminId, userId };
}

/** Audit payment_method.created seperti alur web admin (dipakai bersama helper metode di bawah). */
async function auditMethodCreated(db: DbOrTx, actor: GoLiveAdmin, id: string): Promise<void> {
  await db.insert(auditLogs).values({
    id: uuidv7(),
    actorUserId: actor.userId,
    actorAdminId: actor.adminId,
    effectiveRole: "super_admin",
    action: "payment_method.created",
    entityType: "payment_method",
    entityId: id,
    requestId: `uji-${uuidv7()}`,
  });
}

/** Metode bayar yang dibuat lewat web admin (baris + audit payment_method.created dalam satu langkah). */
export async function insertAuditedPaymentMethod(
  db: DbOrTx,
  actor: GoLiveAdmin,
  opts: { provider?: string; accountNumber?: string; accountHolder?: string; kind?: "bank" | "ewallet" } = {},
): Promise<string> {
  const id = uuidv7();
  await db.insert(paymentMethods).values({
    id,
    kind: opts.kind ?? "bank",
    provider: opts.provider ?? "Bank Syariah Indonesia",
    accountNumber: opts.accountNumber ?? "7123456789",
    accountHolder: opts.accountHolder ?? "Keluarga Alumni PDH",
    active: true,
    sortOrder: 1,
  });
  await auditMethodCreated(db, actor, id);
  return id;
}

/** sha256 tetap berkas gambar QRIS uji (sidik jari yang ditandatangani bendahara: 12 karakter awal). */
export const QRIS_TEST_SHA256 = `0123456789ab${"c".repeat(52)}`;

/**
 * Metode QRIS lewat web admin (ADR-026): berkas `payment_qr` publik ready 1024x1024 (objek storage tidak dibuat; gerbang
 * hanya membaca metadata), metode `qris` yang merujuknya, dan audit payment_method.created. Mengembalikan id metode
 * dan id berkas. Hanya untuk skema 0008 ke atas.
 */
export async function seedQrisMethod(
  db: DbOrTx,
  actor: GoLiveAdmin,
  opts: { provider?: string; nmid?: string; merchant?: string } = {},
): Promise<{ methodId: string; fileId: string }> {
  const fileId = uuidv7();
  await db.insert(files).values({
    id: fileId,
    ownerUserId: actor.userId,
    purpose: "payment_qr",
    storageDriver: "local",
    objectKey: `payment_qr/2026/10/${fileId}`,
    mime: "image/png",
    bytes: 20_480,
    sha256: QRIS_TEST_SHA256,
    visibility: "public",
    status: "ready",
    width: 1024,
    height: 1024,
    attachedAt: new Date(),
  });
  const methodId = uuidv7();
  await db.insert(paymentMethods).values({
    id: methodId,
    kind: "qris",
    provider: opts.provider ?? "QRIS",
    accountNumber: opts.nmid ?? "ID1020304050607",
    accountHolder: opts.merchant ?? "KAPDH Pusat",
    active: true,
    sortOrder: 2,
    qrImageFileId: fileId,
  });
  await auditMethodCreated(db, actor, methodId);
  return { methodId, fileId };
}

/** Menerbitkan naskah resmi halaman wajib dan menyelaraskan app_settings legal (alur publish F-01). */
export async function publishOfficialPages(db: DbOrTx): Promise<void> {
  const now = new Date();
  await db
    .update(pages)
    .set({
      publishedTitle: sql`${pages.title}`,
      publishedBodyHtml: "<p>Naskah resmi yang disahkan pengurus.</p>",
      publishedVersion: 1,
      publishedAt: now,
      updatedAt: now,
    })
    .where(
      inArray(
        pages.slug,
        REQUIRED_PAGES.map((p) => p.slug),
      ),
    );
  await db
    .update(appSettings)
    .set({
      value: { privacy_version: "1", terms_version: "1", community_version: "1" },
      version: sql`${appSettings.version} + 1`,
      updatedAt: now,
    })
    .where(eq(appSettings.key, "legal"));
}

/**
 * Seluruh langkah PRD 8.2 butir 3-4 yang disahkan: dua Super Admin ber-TOTP, metode bayar resmi, halaman legal dan
 * bantuan terbit, master ditinjau dan diaktifkan, nomor WhatsApp dukungan. Nominal tetap nilai D4 dari seed.
 * `paymentMethod: false` melewati metode bayar (skema lama sebelum 0008: insert Drizzle memuat kolom baru, sehingga
 * pemanggil menyisipkan metode dengan SQL mentah).
 */
export async function approveProductionConfig(
  db: DbOrTx,
  opts: { paymentMethod?: boolean } = {},
): Promise<{ superAdmins: GoLiveAdmin[] }> {
  const superAdmins = [
    await insertGateAdmin(db, { displayName: "Super Admin Satu" }),
    await insertGateAdmin(db, { displayName: "Super Admin Dua" }),
  ];
  if (opts.paymentMethod !== false) await insertAuditedPaymentMethod(db, superAdmins[0]!);
  await publishOfficialPages(db);
  await db.update(masterProfessions).set({ active: true }).where(eq(masterProfessions.label, "Guru"));
  await db.update(masterSkills).set({ active: true }).where(eq(masterSkills.label, "Bahasa Arab"));
  await db
    .update(appSettings)
    .set({
      value: { email: "bantuan@kapdh.or.id", whatsapp: "+6281234567890" },
      version: sql`${appSettings.version} + 1`,
    })
    .where(eq(appSettings.key, "support"));
  return { superAdmins };
}
