/**
 * Bootstrap Super Admin pertama (PRD 8.2 langkah 3). Dijalankan sekali di server, bukan lewat endpoint publik.
 * Menolak berjalan bila sudah ada Super Admin yang dapat login (admin active DAN akun active), diperiksa di bawah
 * advisory lock transaksi sehingga dua eksekusi bersamaan tidak membuat dua Super Admin pertama.
 *
 *   node dist/cli/bootstrap-admin.js --email admin@kapdh.or.id --name "Bayu Musthafa"
 *
 * Sandi awal acak, secret TOTP, dan backup code dicetak SEKALI ke terminal. Simpan di password manager.
 */
import "reflect-metadata";
import { EnvValidationError, loadApiEnv, loadDevelopmentEnvFile } from "@kapdh/config";
import { admins, createDb, mfaTotp, users } from "@kapdh/database";
import bcrypt from "bcryptjs";
import { and, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { writeAudit } from "../core/audit/write-audit.js";
import { backupCodeHash, encryptSecret, newBackupCode, newTotpSecret } from "../modules/auth/crypto.js";
import { normalizeEmail } from "../modules/auth/auth.service.js";

/** Kunci advisory bootstrap (berbeda dari kunci migrasi 4711000517 dan penjaga Super Admin 4711000518). */
const BOOTSTRAP_LOCK_KEY = 4711000519;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  loadDevelopmentEnvFile([resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]);
  const env = loadApiEnv();
  const email = arg("email");
  const name = arg("name")?.trim();
  if (!email || !name) throw new EnvValidationError('Pakai: --email <email> --name "<nama>"');
  const { db, sql: client } = createDb(env.DATABASE_URL, { max: 1, applicationName: "kapdh-cli-bootstrap" });
  try {
    const password = randomBytes(18).toString("base64url") + "#A1";
    const secret = newTotpSecret();
    const backupCodes = Array.from({ length: 8 }, () => newBackupCode());
    const userId = uuidv7();
    const adminId = uuidv7();
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);
      const existing = await tx
        .select({ id: admins.id })
        .from(admins)
        .innerJoin(users, eq(users.id, admins.userId))
        .where(and(eq(admins.role, "super_admin"), eq(admins.status, "active"), eq(users.status, "active")))
        .limit(1);
      if (existing.length > 0)
        throw new EnvValidationError("Super Admin aktif sudah ada. Tambahkan admin lain dari web admin.");
      await tx.insert(users).values({
        id: userId,
        email: normalizeEmail(email),
        passwordHash: await bcrypt.hash(password, env.BCRYPT_COST),
        status: "active",
        kind: "admin",
        emailVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(admins).values({
        id: adminId,
        userId,
        displayName: name,
        role: "super_admin",
        status: "active",
        activatedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(mfaTotp).values({
        userId,
        secretEncrypted: encryptSecret(secret, env.TOTP_ENC_KEY),
        verifiedAt: now,
        backupCodeHashes: backupCodes.map((c) => backupCodeHash(env.OTP_HMAC_SECRET, c)),
        createdAt: now,
        updatedAt: now,
      });
      // F-17: bootstrap produksi tercatat di audit (tanpa sandi/secret/backup code).
      await writeAudit(tx, {
        actorAdminId: adminId,
        effectiveRole: "system",
        action: "admin.bootstrap",
        entityType: "admin",
        entityId: adminId,
        requestId: `cli-${uuidv7()}`,
        after: { role: "super_admin", display_name: name },
        createdAt: now,
      });
    });
    const issuer = encodeURIComponent("KAPDH Admin");
    const label = encodeURIComponent(`KAPDH Admin:${normalizeEmail(email)}`);
    process.stdout.write(
      [
        "Super Admin dibuat. Informasi berikut hanya ditampilkan sekali:",
        `  Email          : ${normalizeEmail(email)}`,
        `  Sandi awal     : ${password}`,
        `  Secret TOTP    : ${secret}`,
        `  URI autentikator: otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&digits=6&period=30`,
        `  Backup code    : ${backupCodes.join(" ")}`,
        "Masukkan secret ke aplikasi autentikator, lalu ganti sandi awal setelah masuk.",
        "",
      ].join("\n"),
    );
  } finally {
    await client.end();
  }
}

main().catch((e: unknown) => {
  // Pesan galat konfigurasi/validasi aman dicetak; galat lain hanya tipenya (bisa memuat parameter SQL).
  const message = e instanceof EnvValidationError ? e.message : `galat ${(e as Error)?.name ?? "tidak dikenal"}`;
  process.stderr.write(`Gagal: ${message}\n`);
  process.exit(1);
});
