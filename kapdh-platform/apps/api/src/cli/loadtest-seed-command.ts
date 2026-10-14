import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { rows } from "../core/db/rows.js";
import type { Db } from "../core/db/types.js";
import type { CliOutput } from "./bootstrap-admin-command.js";
import {
  addPendingRenewals,
  DEFAULT_LOAD_DATASET,
  LoadDatasetRefusedError,
  loadProfileUserIds,
  type LoadDatasetOptions,
  seedLoadDataset,
} from "./loadtest-dataset.js";
import { sql } from "drizzle-orm";

export interface LoadtestSeedDeps {
  db: Db;
  env: { NODE_ENV: string; BCRYPT_COST: number; TOTP_ENC_KEY: string };
  now: Date;
  stdout: CliOutput;
  stderr: CliOutput;
}

export const LOADTEST_SEED_USAGE = [
  "Pakai (HANYA staging/dev, PRD 5.3; docs/runbooks/load-test.md):",
  "  loadtest:seed --confirm-database <nama database> --out <berkas kredensial baru> [ukuran]",
  "  loadtest:seed --confirm-database <nama database> --top-up-payments <jumlah>",
  "Ukuran (bawaan PRD 2.4): --profiles 5000 --login-members 100 --admins 5 --messages 100000",
  "  --group-rooms 40 --direct-rooms 200 --events 20 --pending-payments 1000 --posts 30 [--seed <n>]",
].join("\n");

const SIZE_FLAGS: Record<string, keyof typeof DEFAULT_LOAD_DATASET> = {
  profiles: "profiles",
  "login-members": "loginMembers",
  admins: "admins",
  messages: "messages",
  "group-rooms": "groupRooms",
  "direct-rooms": "directRooms",
  events: "events",
  "pending-payments": "pendingPayments",
  posts: "posts",
};

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

function intOption(args: readonly string[], name: string): number | undefined {
  const raw = option(args, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new LoadDatasetRefusedError(`--${name} harus bilangan bulat`);
  return Number(raw);
}

/** Sandi acak yang memenuhi aturan PRD 2.5 (huruf besar, kecil, angka, simbol; < 72 byte). */
export function generateLoadPassword(): string {
  return `Ub#${randomBytes(18).toString("base64url")}9a`;
}

/**
 * CLI dataset uji beban (docs/runbooks/load-test.md). Kode keluar: 0 berhasil, 1 ditolak/gagal, 2 argumen salah.
 * Penjaga: NODE_ENV production ditolak; `--confirm-database` wajib sama dengan current_database() sehingga salah
 * DATABASE_URL tidak menulis ke database lain; berkas kredensial baru ditulis 0600 dan tidak pernah dicetak.
 */
export async function runLoadtestSeedCommand(
  args: readonly string[],
  deps: LoadtestSeedDeps,
): Promise<number> {
  if (deps.env.NODE_ENV === "production") {
    deps.stderr.write("Ditolak: dataset uji beban tidak pernah dibuat di production (PRD 5.3, 8.2).\n");
    return 1;
  }
  const confirm = option(args, "confirm-database");
  const out = option(args, "out");
  let topUp: number | undefined;
  const sizes: Partial<Record<keyof typeof DEFAULT_LOAD_DATASET, number>> = {};
  let seed: number | undefined;
  try {
    topUp = intOption(args, "top-up-payments");
    seed = intOption(args, "seed");
    for (const [flag, key] of Object.entries(SIZE_FLAGS)) {
      const value = intOption(args, flag);
      if (value !== undefined) sizes[key] = value;
    }
  } catch (e) {
    deps.stderr.write(`${(e as Error).message}\n${LOADTEST_SEED_USAGE}\n`);
    return 2;
  }
  if (!confirm || (topUp === undefined && !out)) {
    deps.stderr.write(`${LOADTEST_SEED_USAGE}\n`);
    return 2;
  }
  try {
    const [row] = rows<{ name: string }>(await deps.db.execute(sql`select current_database() as name`));
    if (row?.name !== confirm) {
      deps.stderr.write(
        `Ditolak: --confirm-database "${confirm}" berbeda dari database tujuan DATABASE_URL. Periksa koneksi.\n`,
      );
      return 1;
    }
    if (topUp !== undefined) {
      const candidates = await loadProfileUserIds(deps.db);
      if (candidates.length === 0) {
        deps.stderr.write("Ditolak: dataset uji beban belum ada (jalankan tanpa --top-up-payments).\n");
        return 1;
      }
      const added = await addPendingRenewals(deps.db, candidates, topUp, deps.now);
      deps.stdout.write(`Payment renewal menunggu keputusan ditambahkan: ${added}\n`);
      return 0;
    }
    const options: LoadDatasetOptions = {
      ...DEFAULT_LOAD_DATASET,
      ...sizes,
      memberPassword: generateLoadPassword(),
      adminPassword: generateLoadPassword(),
      bcryptCost: deps.env.BCRYPT_COST,
      totpEncKey: deps.env.TOTP_ENC_KEY,
      now: deps.now,
      seed,
      onProgress: (message) => deps.stdout.write(`- ${message}\n`),
    };
    // Berkas dibuat lebih dahulu (wx: gagal bila sudah ada) agar dataset tidak dibuat tanpa tempat kredensial.
    writeFileSync(out!, "", { mode: 0o600, flag: "wx" });
    const credentials = await seedLoadDataset(deps.db, options);
    writeFileSync(out!, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    deps.stdout.write(
      [
        `Dataset ${credentials.dataset_id} selesai.`,
        ...Object.entries(credentials.counts).map(([k, v]) => `  ${k.padEnd(18)}: ${v}`),
        `Kredensial (0600, JANGAN di-commit/dibagikan): ${out}`,
        "",
      ].join("\n"),
    );
    return 0;
  } catch (e) {
    const message =
      e instanceof LoadDatasetRefusedError
        ? e.message
        : (e as NodeJS.ErrnoException)?.code === "EEXIST"
          ? `berkas ${out} sudah ada; pilih --out baru`
          : `galat ${(e as Error)?.name ?? "tidak dikenal"}`;
    deps.stderr.write(`Gagal: ${message}\n`);
    return 1;
  }
}
