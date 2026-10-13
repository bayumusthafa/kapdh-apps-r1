import { checkPassword, PASSWORD_MAX_BYTES, PASSWORD_MIN_BYTES } from "@kapdh/shared";
import { Check, X } from "lucide-react";
import { z } from "zod";
import { cn } from "../../lib/cn";

/**
 * Syarat sandi PRD 2.5 (disahkan v3.2): 8 sampai 72 BYTE UTF-8 (bukan karakter) dengan huruf besar, huruf kecil,
 * angka dan simbol. Daftar periksa menampilkan jumlah byte terpakai agar admin paham bahwa huruf beraksen atau emoji
 * memakai lebih dari satu byte. Setiap butir memuat teks status (bukan hanya warna/ikon, PRD 4.5, N-11). Server tetap
 * sumber kebenaran dan menolak (tidak memotong) sandi yang melampaui batas.
 */
export function PasswordRules({ value, id, className }: { value: string; id?: string; className?: string }) {
  const c = checkPassword(value);
  const rules = [
    {
      ok: c.lengthOk,
      label: `${PASSWORD_MIN_BYTES}-${PASSWORD_MAX_BYTES} byte (terpakai ${c.bytes} byte)`,
    },
    { ok: c.hasUpper, label: "Huruf besar (A-Z)" },
    { ok: c.hasLower, label: "Huruf kecil (a-z)" },
    { ok: c.hasDigit, label: "Angka (0-9)" },
    { ok: c.hasSymbol, label: "Simbol, mis. # ! @ ?" },
  ];
  return (
    <ul id={id} aria-label="Syarat sandi" className={cn("grid gap-1 text-xs sm:grid-cols-2", className)}>
      {rules.map((r) => (
        <li
          key={r.label}
          className={cn("flex items-center gap-1.5", r.ok ? "text-success" : "text-text-muted")}
        >
          {r.ok ? (
            <Check aria-hidden="true" className="size-3.5 shrink-0" />
          ) : (
            <X aria-hidden="true" className="size-3.5 shrink-0" />
          )}
          <span>
            {r.label}
            <span className="sr-only">{r.ok ? ": terpenuhi" : ": belum terpenuhi"}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Pesan untuk syarat pertama yang belum terpenuhi; null bila sandi sah. */
export function passwordProblem(value: string): string | null {
  const c = checkPassword(value);
  if (c.bytes < PASSWORD_MIN_BYTES) return `Sandi minimal ${PASSWORD_MIN_BYTES} byte.`;
  if (c.bytes > PASSWORD_MAX_BYTES)
    return `Sandi maksimal ${PASSWORD_MAX_BYTES} byte (huruf beraksen dan emoji memakai lebih dari 1 byte).`;
  if (!c.hasUpper) return "Sandi wajib memuat huruf besar.";
  if (!c.hasLower) return "Sandi wajib memuat huruf kecil.";
  if (!c.hasDigit) return "Sandi wajib memuat angka.";
  if (!c.hasSymbol) return "Sandi wajib memuat simbol.";
  return null;
}

/** Skema zod sandi baru sesuai aturan byte PRD 2.5 (`checkPassword` dari @kapdh/shared). */
export const newPasswordSchema = z.string().superRefine((value, ctx) => {
  const problem = value === "" ? "Sandi baru wajib diisi." : passwordProblem(value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});
