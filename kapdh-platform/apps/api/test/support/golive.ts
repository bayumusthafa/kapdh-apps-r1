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

/** Metode bayar yang dibuat lewat web admin (baris + audit payment_method.created dalam satu langkah). */
export async function insertAuditedPaymentMethod(
  db: DbOrTx,
  actor: GoLiveAdmin,
  opts: { provider?: string; accountNumber?: string; accountHolder?: string } = {},
): Promise<string> {
  const id = uuidv7();
  await db.insert(paymentMethods).values({
    id,
    kind: "bank",
    provider: opts.provider ?? "Bank Syariah Indonesia",
    accountNumber: opts.accountNumber ?? "7123456789",
    accountHolder: opts.accountHolder ?? "Keluarga Alumni PDH",
    active: true,
    sortOrder: 1,
  });
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
  return id;
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
 */
export async function approveProductionConfig(db: DbOrTx): Promise<{ superAdmins: GoLiveAdmin[] }> {
  const superAdmins = [
    await insertGateAdmin(db, { displayName: "Super Admin Satu" }),
    await insertGateAdmin(db, { displayName: "Super Admin Dua" }),
  ];
  await insertAuditedPaymentMethod(db, superAdmins[0]!);
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
