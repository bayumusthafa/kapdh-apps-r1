import { admins, mfaTotp, sessions, users } from "@kapdh/database";
import bcrypt from "bcryptjs";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { writeAudit } from "../core/audit/write-audit.js";
import { ADVISORY_LOCK_KEYS, advisoryXactLock } from "../core/db/locks.js";
import type { DbOrTx } from "../core/db/types.js";
import {
  ADMIN_INVITE_TTL_MS,
  adminInviteTokenHash,
  newAdminInviteToken,
  randomToken,
} from "../core/identity/crypto.js";
import { normalizeEmail } from "../core/identity/email.js";

export interface BootstrapSuperAdminInput {
  email: string;
  displayName: string;
  /** Waktu eksekusi (CLI: jam sistem). */
  now: Date;
  bcryptCost: number;
  /** Korelasi audit eksekusi CLI (N-14). */
  requestId: string;
}

export interface BootstrapSuperAdminResult {
  adminId: string;
  userId: string;
  email: string;
  /** Token undangan mentah; hanya dikembalikan untuk dicetak sekali di dalam tautan, tidak pernah disimpan. */
  inviteToken: string;
  inviteExpiresAt: Date;
  /** true bila undangan bootstrap sebelumnya (belum aktif) untuk email yang sama diterbitkan ulang. */
  reissued: boolean;
}

/** Penolakan bootstrap yang aman ditampilkan ke operator (tanpa data rahasia). */
export class BootstrapRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapRefusedError";
  }
}

/** Email bootstrap divalidasi dengan aturan yang sama dengan login admin (AdminLoginRequest: format email, maks. 254). */
const bootstrapEmailSchema = z.string().email().max(254);

/**
 * PRD 8.2 langkah 3: menolak bila sudah ada Super Admin yang dapat login (role super_admin, admins.status `active`,
 * users.status `active`; definisi penjaga `admins_last_super_admin_chk`). Snapshot statement baru (READ COMMITTED)
 * sehingga aktivasi yang commit selama bootstrap menunggu kunci ikut terlihat.
 */
async function refuseIfUsableSuperAdmin(tx: DbOrTx): Promise<void> {
  const usable = await tx
    .select({ id: admins.id })
    .from(admins)
    .innerJoin(users, eq(users.id, admins.userId))
    .where(and(eq(admins.role, "super_admin"), eq(admins.status, "active"), eq(users.status, "active")))
    .limit(1);
  if (usable.length > 0)
    throw new BootstrapRefusedError(
      "Super Admin aktif sudah ada. Tambahkan admin lain dari web admin (menu Admin).",
    );
}

/**
 * Bootstrap Super Admin pertama (PRD 8.2 langkah 3, F-16). Dijalankan sekali di server lewat CLI
 * (`src/cli/bootstrap-admin.ts`), bukan endpoint: tidak ada rute HTTP yang memanggil fungsi ini. Menolak berjalan bila
 * sudah ada Super Admin yang dapat login (role super_admin, admins.status `active` DAN users.status `active`, sama
 * dengan definisi penjaga `admins_last_super_admin_chk`). Pemeriksaan dan pembuatan berjalan di bawah advisory lock
 * transaksi sehingga dua eksekusi bersamaan tidak membuat dua Super Admin pertama.
 *
 * Akun dibuat berstatus `invited` dengan sandi awal acak 256 bit yang tidak pernah ditampilkan (tidak dapat dipakai
 * siapa pun; login admin juga menolak status `invited`) dan token undangan sekali pakai 72 jam (hanya hash yang
 * disimpan). PRD 8.2: "Akun wajib mengganti sandi awal dan mendaftarkan TOTP sebelum aktif", jadi aktivasi memakai
 * alur undangan yang sama dengan admin lain (preview → accept → /totp/enroll → /totp/confirm → active). Audit
 * `admin.bootstrap` (aktor system) ditulis di transaksi yang sama (F-17).
 *
 * Menjalankan ulang untuk email yang sama selama Super Admin itu belum aktif menerbitkan token baru: token lama dan
 * token pendaftaran TOTP yang mungkin sudah terbit batal, sandi kembali acak, dan pendaftaran TOTP yang belum selesai
 * dibuang (audit `admin.bootstrap_reinvited`).
 */
export async function bootstrapSuperAdmin(
  db: DbOrTx,
  input: BootstrapSuperAdminInput,
): Promise<BootstrapSuperAdminResult> {
  const email = normalizeEmail(input.email);
  const displayName = input.displayName.trim();
  if (!bootstrapEmailSchema.safeParse(email).success) throw new BootstrapRefusedError("Email tidak valid.");
  if (displayName.length < 2 || displayName.length > 120)
    throw new BootstrapRefusedError("Nama tampilan wajib 2 sampai 120 karakter.");

  const inviteToken = newAdminInviteToken();
  const inviteTokenHash = adminInviteTokenHash(inviteToken);
  const inviteExpiresAt = new Date(input.now.getTime() + ADMIN_INVITE_TTL_MS);
  // Sandi awal acak yang tidak pernah ditampilkan: login hanya mungkin setelah undangan diterima dan TOTP aktif.
  const unusablePasswordHash = await bcrypt.hash(randomToken(32), input.bcryptCost);

  return db.transaction(async (tx) => {
    // Semua eksekusi bootstrap berurutan di bawah kunci ini (cek "sudah ada" lalu tulis tanpa celah balapan).
    await advisoryXactLock(tx, ADVISORY_LOCK_KEYS.bootstrapSuperAdmin);
    await refuseIfUsableSuperAdmin(tx);

    const [existing] = await tx
      .select({
        userId: users.id,
        userStatus: users.status,
        adminId: admins.id,
        role: admins.role,
        status: admins.status,
      })
      .from(users)
      .leftJoin(admins, eq(admins.userId, users.id))
      .where(and(eq(users.email, email), eq(users.kind, "admin"), ne(users.status, "deleted")))
      .limit(1);

    if (existing) {
      if (!existing.adminId || existing.role !== "super_admin" || existing.status !== "invited")
        throw new BootstrapRefusedError("Email sudah dipakai identitas admin lain.");
      if (existing.userStatus !== "active")
        throw new BootstrapRefusedError("Akun admin untuk email ini tidak aktif; gunakan email lain.");
      // ARCHITECTURE §2 butir 11: baca di atas tanpa kunci hanya menemukan kandidat. Baris dikunci dengan urutan
      // identitas admin (admins → users → mfa_totp; penjaga Super Admin terakhir migrasi 0002) lalu keadaan diperiksa
      // ULANG di bawah kunci. Aktivasi /totp/confirm yang memegang kunci admins dan commit selagi CLI menunggu terlihat
      // di sini (READ COMMITTED): Super Admin yang baru aktif tidak pernah direset menjadi tanpa TOTP dan sandi acak.
      const [lockedAdmin] = await tx
        .select({ userId: admins.userId, role: admins.role, status: admins.status })
        .from(admins)
        .where(eq(admins.id, existing.adminId))
        .for("update");
      const [lockedUser] = await tx
        .select({ status: users.status, kind: users.kind })
        .from(users)
        .where(eq(users.id, existing.userId))
        .for("update");
      if (
        !lockedAdmin ||
        lockedAdmin.userId !== existing.userId ||
        lockedAdmin.role !== "super_admin" ||
        lockedAdmin.status !== "invited"
      ) {
        await refuseIfUsableSuperAdmin(tx);
        throw new BootstrapRefusedError(
          "Status akun admin untuk email ini berubah saat bootstrap berjalan; tidak ada yang diubah. Jalankan ulang.",
        );
      }
      if (!lockedUser || lockedUser.status !== "active" || lockedUser.kind !== "admin")
        throw new BootstrapRefusedError("Akun admin untuk email ini tidak aktif; gunakan email lain.");
      // Super Admin lain yang aktif sejak pemeriksaan pertama (commit selagi CLI menunggu kunci) → tetap menolak.
      await refuseIfUsableSuperAdmin(tx);
      const reinvited = await tx
        .update(admins)
        .set({
          inviteTokenHash,
          inviteExpiresAt,
          updatedAt: input.now,
          version: sql`${admins.version} + 1`,
        })
        .where(and(eq(admins.id, existing.adminId), eq(admins.status, "invited")))
        .returning({ id: admins.id });
      // Pertahanan berlapis: predikat status harus tetap cocok di bawah kunci; bila tidak, tidak ada yang diubah.
      if (reinvited.length === 0)
        throw new BootstrapRefusedError(
          "Status akun admin untuk email ini berubah saat bootstrap berjalan; tidak ada yang diubah. Jalankan ulang.",
        );
      await tx
        .update(users)
        .set({
          passwordHash: unusablePasswordHash,
          sessionVersion: sql`${users.sessionVersion} + 1`,
          updatedAt: input.now,
        })
        .where(eq(users.id, existing.userId));
      await tx.delete(mfaTotp).where(eq(mfaTotp.userId, existing.userId));
      await tx
        .update(sessions)
        .set({ revokedAt: input.now })
        .where(and(eq(sessions.userId, existing.userId), isNull(sessions.revokedAt)));
      await writeAudit(tx, {
        effectiveRole: "system",
        action: "admin.bootstrap_reinvited",
        entityType: "admin",
        entityId: existing.adminId,
        requestId: input.requestId,
        after: { role: "super_admin", status: "invited", invite_expires_at: inviteExpiresAt.toISOString() },
        createdAt: input.now,
      });
      return {
        adminId: existing.adminId,
        userId: existing.userId,
        email,
        inviteToken,
        inviteExpiresAt,
        reissued: true,
      };
    }

    const userId = uuidv7();
    const adminId = uuidv7();
    await tx.insert(users).values({
      id: userId,
      email,
      passwordHash: unusablePasswordHash,
      status: "active",
      kind: "admin",
      createdAt: input.now,
      updatedAt: input.now,
    });
    await tx.insert(admins).values({
      id: adminId,
      userId,
      displayName,
      role: "super_admin",
      status: "invited",
      inviteTokenHash,
      inviteExpiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    });
    // F-17: bootstrap produksi tercatat di audit sebagai aktor system (tanpa sandi, token, atau secret).
    await writeAudit(tx, {
      effectiveRole: "system",
      action: "admin.bootstrap",
      entityType: "admin",
      entityId: adminId,
      requestId: input.requestId,
      after: {
        role: "super_admin",
        status: "invited",
        display_name: displayName,
        invite_expires_at: inviteExpiresAt.toISOString(),
      },
      createdAt: input.now,
    });
    return { adminId, userId, email, inviteToken, inviteExpiresAt, reissued: false };
  });
}
