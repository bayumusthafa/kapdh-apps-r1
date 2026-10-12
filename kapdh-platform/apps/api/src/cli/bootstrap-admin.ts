/**
 * Bootstrap Super Admin pertama (PRD 8.2). Dijalankan sekali di server, bukan lewat endpoint publik.
 * Menolak berjalan bila Super Admin aktif sudah ada.
 *
 *   node dist/cli/bootstrap-admin.js --email admin@kapdh.or.id --name "Bayu Musthafa"
 *
 * Sandi awal acak, secret TOTP, dan backup code dicetak SEKALI ke terminal. Simpan di password manager.
 */
import "reflect-metadata";
import { loadServerEnv } from "@kapdh/config";
import { admins, auditLogs, createDb, mfaTotp, users } from "@kapdh/database";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { normalizeEmail } from "../auth/auth.service.js";
import { encryptSecret, newTotpSecret, sha256 } from "../auth/crypto.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const env = loadServerEnv();
  const email = arg("email");
  const name = arg("name");
  if (!email || !name) throw new Error('Pakai: --email <email> --name "<nama>"');
  const { db, sql } = createDb(env.DATABASE_URL);
  try {
    const existing = await db
      .select()
      .from(admins)
      .where(and(eq(admins.role, "super_admin"), eq(admins.status, "active")))
      .limit(1);
    if (existing.length > 0)
      throw new Error("Super Admin aktif sudah ada. Tambahkan admin lain dari web admin.");

    const password = randomBytes(18).toString("base64url") + "#A1";
    const secret = newTotpSecret();
    const backupCodes = Array.from({ length: 8 }, () => randomBytes(5).toString("hex").toUpperCase());
    const userId = uuidv7();
    const adminId = uuidv7();
    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        email: normalizeEmail(email),
        passwordHash: await bcrypt.hash(password, env.BCRYPT_COST),
        status: "active",
        kind: "admin",
        emailVerifiedAt: new Date(),
      });
      await tx.insert(admins).values({
        id: adminId,
        userId,
        displayName: name,
        role: "super_admin",
        status: "active",
        activatedAt: new Date(),
      });
      await tx.insert(mfaTotp).values({
        userId,
        secretEncrypted: encryptSecret(secret, env.TOTP_ENC_KEY),
        verifiedAt: new Date(),
        backupCodeHashes: backupCodes.map((c) => sha256(c)),
      });
      await tx.insert(auditLogs).values({
        id: uuidv7(),
        actorAdminId: adminId,
        effectiveRole: "system",
        action: "admin.bootstrap",
        entityType: "admin",
        entityId: adminId,
        requestId: `cli-${uuidv7()}`,
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
    await sql.end();
  }
}

main().catch((e) => {
  process.stderr.write(`Gagal: ${(e as Error).message}\n`);
  process.exit(1);
});
