import type { components } from "@kapdh/contracts";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuditService } from "../../core/audit/audit.service.js";
import type { Db } from "../../core/db/types.js";
import { AppException } from "../../core/errors/app-exception.js";
import { ADMIN_IDLE_MS } from "../../core/guards/auth.guard.js";
import { backupCodeHash, newBackupCode } from "../../core/identity/crypto.js";
import type { IssuedSession } from "../../core/identity/session-issuer.js";

type AdminSession = components["schemas"]["AdminSession"];

/**
 * Audit penguncian kode MFA admin (F-17; F-02): ditulis sekali ketika kegagalan ke-5 dalam jendela 15 menit membuat
 * tahap kode terkunci (429 berikutnya tidak diaudit lagi, sehingga audit append-only tidak dapat dibanjiri). Aktor
 * bawaan konteks (anonim: pemanggil belum terautentikasi). Transaksi tersendiri karena transaksi percobaan kode sudah
 * dibatalkan; tanpa kode, token, atau secret.
 */
export async function auditMfaLockout(
  db: Db,
  audit: AuditService,
  adminId: string,
  stage: "login" | "enrollment",
): Promise<void> {
  await db.transaction(async (tx) => {
    await audit.write(tx, {
      action: "admin.mfa_locked",
      entityType: "admin",
      entityId: adminId,
      after: { stage, failed_attempts: MFA_FAILS_LIMIT, window_minutes: MFA_WINDOW_MS / 60_000 },
    });
  });
}

/** Jendela batas kegagalan kode MFA admin (kontrak adminVerifyMfa, /totp/confirm): 15 menit. */
export const MFA_WINDOW_MS = 15 * 60_000;
/** Kontrak adminVerifyMfa dan adminConfirmTotpEnrollment: 429 setelah 5 kode salah dalam 15 menit per admin. */
export const MFA_FAILS_LIMIT = 5;
/** Jumlah backup code per penerbitan (kontrak AdminTotpEnrollmentResult/AdminBackupCodes: tepat 10). */
export const BACKUP_CODE_COUNT = 10;

/** Penerbit di aplikasi autentikator (kontrak AdminTotpEnrollment.issuer). */
export const TOTP_ISSUER = "KAPDH Admin";

/**
 * Penanda internal kode MFA salah (TOTP tidak cocok/diputar ulang, backup code tidak dikenal). Diubah menjadi 400
 * VALIDATION_ERROR dengan sisa percobaan setelah transaksi dibatalkan (kontrak adminVerifyMfa, /totp/confirm).
 */
export class WrongMfaCode extends Error {
  constructor(
    readonly field: "totp_code" | "backup_code",
    /** Admin pemilik kode (untuk audit penguncian). */
    readonly adminId: string,
  ) {
    super("kode MFA salah");
    this.name = "WrongMfaCode";
  }
}

/** 400 VALIDATION_ERROR untuk kode salah dengan sisa percobaan (kontrak C1: galat formulir, bukan 401). */
export function wrongCodeError(field: "totp_code" | "backup_code", usedAttempts: number): AppException {
  const left = Math.max(0, MFA_FAILS_LIMIT - usedAttempts);
  const message =
    left > 0
      ? `Kode salah. Sisa percobaan ${left}.`
      : "Kode salah. Batas percobaan tercapai; coba lagi dalam 15 menit.";
  return new AppException(400, "VALIDATION_ERROR", message, { fieldErrors: { [field]: [message] } });
}

/**
 * Pengikat token pendaftaran TOTP ke password_hash yang disimpan saat penerimaan undangan (kontrak C1
 * adminAcceptInvitation): HMAC dengan secret server sehingga isi JWT (dapat dibaca pemegangnya) tidak membuka apa pun
 * tentang hash sandi. Sandi diganti (undangan ulang, pemulihan) → pengikat tidak cocok → token pendaftaran mati.
 */
export function enrollmentBinding(serverSecret: string, passwordHash: string): string {
  return createHmac("sha256", serverSecret).update(`admin-enroll:${passwordHash}`).digest("base64url");
}

/** Perbandingan waktu-konstan dua string (pengikat token). */
export function safeEqualText(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * 10 backup code sekali pakai baru (F-02): kode mentah hanya untuk respons (ditampilkan sekali), yang disimpan hanya
 * HMAC-nya (mfa_totp.backup_code_hashes; ARCHITECTURE §2 butir 3). Kode dijamin unik dalam satu set.
 */
export function newBackupCodeSet(serverSecret: string): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  const hashes = new Set<string>();
  while (codes.length < BACKUP_CODE_COUNT) {
    const code = newBackupCode();
    const hash = backupCodeHash(serverSecret, code);
    if (hashes.has(hash)) continue;
    hashes.add(hash);
    codes.push(code);
  }
  return { codes, hashes: [...hashes] };
}

/** Respons AdminSession: access token di body, refresh token hanya lewat cookie HttpOnly (PRD 5.2, AC F02-5). */
export function toAdminSession(issued: IssuedSession): AdminSession {
  return {
    access_token: issued.pair.access_token,
    access_expires_at: issued.pair.access_expires_at,
    idle_timeout_seconds: ADMIN_IDLE_MS / 1000,
  };
}

/** URI otpauth (Key Uri Format) untuk QR pendaftaran: SHA1, 6 digit, 30 detik (RFC 6238, kontrak AdminTotpEnrollment). */
export function otpauthUri(secret: string, accountName: string): string {
  // encodeURIComponent (spasi → %20), bukan URLSearchParams (spasi → "+") yang tampil apa adanya di sebagian aplikasi.
  const issuer = encodeURIComponent(TOTP_ISSUER);
  const label = `${issuer}:${encodeURIComponent(accountName)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}
