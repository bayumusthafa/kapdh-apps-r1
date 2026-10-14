import { createHmac } from "node:crypto";
import { normalizeEmail } from "./email.js";

/**
 * Kunci email OTP (PRD 2.5, N-09): HMAC-SHA256 secret server (OTP_HMAC_SECRET) atas email ternormalisasi. Dipakai
 * sebagai kunci kuota kirim per email dan slot challenge pengganti, sehingga store rate limit (Redis) tidak pernah
 * memuat email mentah orang yang tidak terdaftar.
 */
export function otpEmailKey(secret: string, email: string): string {
  return createHmac("sha256", secret)
    .update(`otp-email:${normalizeEmail(email)}`)
    .digest("hex");
}

/**
 * Kunci store rate limit untuk kuota kirim OTP per email (PRD 2.5: 5 pengiriman per jam per email). SATU bucket
 * untuk semua tujuan dan semua modul: OTP aktivasi/koreksi email/lupa sandi (modul auth), hapus akun web (modul
 * account), dan pemulihan sandi oleh Super Admin (modul membership). Semua pemakai kuota WAJIB memakai fungsi ini;
 * kunci berbeda per modul membuat satu alamat dapat dikirimi lebih dari 5 OTP per jam (email bombing).
 */
export function otpSendQuotaKey(secret: string, email: string): string {
  return `otp:${otpEmailKey(secret, email)}`;
}
