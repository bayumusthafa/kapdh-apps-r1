import { v7 as uuidv7 } from "uuid";
import type { DbOrTx } from "../core/db/types.js";
import { adminInviteLink } from "../core/identity/crypto.js";
import { bootstrapSuperAdmin, BootstrapRefusedError } from "./bootstrap-super-admin.js";

/** Keluaran yang dapat ditangkap uji (stdout/stderr proses pada CLI nyata). */
export interface CliOutput {
  write(text: string): unknown;
}

export interface BootstrapAdminCommandDeps {
  db: DbOrTx;
  /** ADMIN_ORIGIN (tautan undangan) dan BCRYPT_COST dari env API yang tervalidasi. */
  env: { ADMIN_ORIGIN: string; BCRYPT_COST: number };
  /** Jam eksekusi (CLI: jam sistem). */
  now: Date;
  stdout: CliOutput;
  stderr: CliOutput;
}

export const BOOTSTRAP_USAGE = 'Pakai: admin:bootstrap --email <email> --name "<nama tampilan>"';

/** `--nama nilai` atau `--nama=nilai`; nilai yang diawali `--` dianggap tidak ada. */
function option(args: readonly string[], name: string): string | undefined {
  const flag = `--${name}`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === flag) {
      const value = args[i + 1];
      return value === undefined || value.startsWith("--") ? undefined : value;
    }
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

/**
 * Perintah bootstrap Super Admin pertama (PRD 8.2 langkah 3, F-16), dipisah dari entry `bootstrap-admin.ts` agar dapat
 * diuji tanpa proses baru. Mengembalikan kode keluar: 0 berhasil, 1 ditolak/gagal, 2 argumen salah.
 *
 * Berhasil: mencetak SATU tautan undangan `${ADMIN_ORIGIN}/invite#t=<token>` (token di fragmen URL, kontrak C1
 * admin-auth.yaml) beserta batas berlakunya; token tidak dicetak di tempat lain dan tidak disimpan selain hash-nya.
 * Ditolak (Super Admin aktif sudah ada, email dipakai admin lain, masukan tidak valid): pesan aman ke stderr tanpa
 * tautan. Galat lain hanya dicetak nama tipenya karena pesannya dapat memuat parameter SQL (N-14).
 */
export async function runBootstrapAdminCommand(
  args: readonly string[],
  deps: BootstrapAdminCommandDeps,
): Promise<number> {
  const email = option(args, "email");
  const name = option(args, "name");
  if (!email || !name) {
    deps.stderr.write(`${BOOTSTRAP_USAGE}\n`);
    return 2;
  }
  try {
    const result = await bootstrapSuperAdmin(deps.db, {
      email,
      displayName: name,
      now: deps.now,
      bcryptCost: deps.env.BCRYPT_COST,
      requestId: `cli-${uuidv7()}`,
    });
    deps.stdout.write(
      [
        result.reissued
          ? "Undangan Super Admin diterbitkan ulang; tautan sebelumnya tidak berlaku lagi."
          : "Super Admin pertama dibuat dengan status menunggu aktivasi (invited).",
        `  Email           : ${result.email}`,
        `  Tautan undangan : ${adminInviteLink(deps.env.ADMIN_ORIGIN, result.inviteToken)}`,
        `  Berlaku sampai  : ${result.inviteExpiresAt.toISOString()}`,
        "Buka tautan itu di peramban, ganti sandi awal, lalu daftarkan TOTP di aplikasi autentikator (PRD 8.2).",
        "Akun baru aktif setelah kode autentikator pertama dikonfirmasi. Tautan hanya ditampilkan sekali dan hanya",
        "dapat dipakai sekali; jangan menempelkannya ke chat, tiket, atau log.",
        "",
      ].join("\n"),
    );
    return 0;
  } catch (e) {
    const message =
      e instanceof BootstrapRefusedError ? e.message : `galat ${(e as Error)?.name ?? "tidak dikenal"}`;
    deps.stderr.write(`Gagal: ${message}\n`);
    return 1;
  }
}
