import {
  type AccountStatusAction,
  AccountStatusRefusedError,
  type AccountStatusService,
} from "./account-status.service.js";

/** Keluaran yang dapat ditangkap uji (stdout/stderr proses pada CLI nyata). */
export interface CliOutput {
  write(text: string): unknown;
}

export interface AccountStatusCommandDeps {
  service: Pick<AccountStatusService, "apply">;
  stdout: CliOutput;
  stderr: CliOutput;
}

export const ACCOUNT_STATUS_USAGE =
  'Pakai: account:status --action disable|enable|delete --email <email akun alumni> --reason "<alasan + nomor tiket>" --approved-by "<pengurus yang menyetujui>"';

const ACTIONS: readonly AccountStatusAction[] = ["disable", "enable", "delete"];

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
 * Perintah operator untuk akun alumni `disabled` (PRD 2.2, F-14; runbook docs/runbooks/alumni-account-disabled.md),
 * dipisah dari entry `account-status.cli.ts` agar dapat diuji tanpa proses baru. Kode keluar: 0 berhasil, 1 ditolak
 * atau gagal, 2 argumen salah. Keluaran hanya id akun, status dan nomor permintaan (tanpa data pribadi); galat selain
 * penolakan hanya dicetak nama tipenya (pesan dapat memuat parameter SQL, N-14).
 */
export async function runAccountStatusCommand(
  args: readonly string[],
  deps: AccountStatusCommandDeps,
): Promise<number> {
  const action = option(args, "action") as AccountStatusAction | undefined;
  const email = option(args, "email");
  const reason = option(args, "reason");
  const approvedBy = option(args, "approved-by");
  if (!action || !ACTIONS.includes(action) || !email || !reason || !approvedBy) {
    deps.stderr.write(`${ACCOUNT_STATUS_USAGE}\n`);
    return 2;
  }
  try {
    const result = await deps.service.apply({ action, email, reason, approvedBy });
    deps.stdout.write(
      [
        `Akun          : ${result.userId}`,
        `Status        : ${result.before} -> ${result.after}`,
        ...(result.action === "disable" ? [`Sesi dicabut  : ${result.sessionsRevoked}`] : []),
        ...(result.requestNumber ? [`Nomor permintaan penghapusan: ${result.requestNumber}`] : []),
        "Tindakan tercatat di audit (aktor system, alasan dan penyetuju).",
        "",
      ].join("\n"),
    );
    return 0;
  } catch (e) {
    const message =
      e instanceof AccountStatusRefusedError ? e.message : `galat ${(e as Error)?.name ?? "tidak dikenal"}`;
    deps.stderr.write(`Gagal: ${message}\n`);
    return 1;
  }
}
