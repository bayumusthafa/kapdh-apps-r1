/** Galat argumen/penolakan CLI ledger-reapply; pesannya aman dicetak (tanpa data pribadi). */
export class CliRefusedError extends Error {
  override name = "CliRefusedError";
}

/**
 * Semua nilai argumen `--<name> <nilai>` (boleh diulang, mis. `--dir a --dir b`). Argumen tanpa nilai ditolak agar
 * salah ketik di runbook restore tidak diam-diam memakai folder bawaan (AC F14-6).
 */
export function argValues(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== `--${name}`) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--"))
      throw new CliRefusedError(`Argumen --${name} membutuhkan nilai`);
    values.push(value);
    i++;
  }
  return values;
}
