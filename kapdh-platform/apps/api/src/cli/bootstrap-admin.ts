/**
 * CLI bootstrap Super Admin pertama (PRD 8.2 langkah 3). Dijalankan sekali di server, bukan lewat endpoint publik:
 *
 *   node dist/cli/bootstrap-admin.js --email admin@kapdh.or.id --name "Bayu Musthafa"
 *
 * Mencetak SEKALI tautan undangan `${ADMIN_ORIGIN}/invite/<token>` (berlaku 72 jam). Pemilik membuka tautan itu,
 * mengganti sandi awal, lalu mendaftarkan TOTP; akun baru aktif setelah itu (F-16). Token tidak disimpan di mana pun
 * selain hash-nya; jangan menempelkan keluaran ini ke chat atau tiket.
 */
import "reflect-metadata";
import { EnvValidationError, loadApiEnv, loadDevelopmentEnvFile } from "@kapdh/config";
import { createDb } from "@kapdh/database";
import { resolve } from "node:path";
import { v7 as uuidv7 } from "uuid";
import type { Db } from "../core/db/types.js";
import { bootstrapSuperAdmin, BootstrapRefusedError } from "./bootstrap-super-admin.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  loadDevelopmentEnvFile([resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]);
  const env = loadApiEnv();
  const email = arg("email");
  const name = arg("name");
  if (!email || !name) throw new BootstrapRefusedError('Pakai: --email <email> --name "<nama>"');
  const { db, sql: client } = createDb(env.DATABASE_URL, { max: 1, applicationName: "kapdh-cli-bootstrap" });
  try {
    const result = await bootstrapSuperAdmin(db as unknown as Db, {
      email,
      displayName: name,
      now: new Date(),
      bcryptCost: env.BCRYPT_COST,
      requestId: `cli-${uuidv7()}`,
    });
    process.stdout.write(
      [
        result.reissued
          ? "Undangan Super Admin diterbitkan ulang (tautan lama tidak berlaku lagi)."
          : "Super Admin pertama dibuat dengan status menunggu aktivasi.",
        `  Email           : ${result.email}`,
        `  Tautan undangan : ${env.ADMIN_ORIGIN}/invite/${result.inviteToken}`,
        `  Berlaku sampai  : ${result.inviteExpiresAt.toISOString()}`,
        "Buka tautan itu, ganti sandi awal, lalu daftarkan TOTP di aplikasi autentikator (PRD 8.2).",
        "Tautan hanya ditampilkan sekali dan hanya dapat dipakai sekali.",
        "",
      ].join("\n"),
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((e: unknown) => {
  // Pesan galat konfigurasi/penolakan aman dicetak; galat lain hanya tipenya (bisa memuat parameter SQL, N-14).
  const message =
    e instanceof EnvValidationError || e instanceof BootstrapRefusedError
      ? e.message
      : `galat ${(e as Error)?.name ?? "tidak dikenal"}`;
  process.stderr.write(`Gagal: ${message}\n`);
  process.exit(1);
});
