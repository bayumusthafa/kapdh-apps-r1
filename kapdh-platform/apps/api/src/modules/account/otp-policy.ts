import { Injectable } from "@nestjs/common";
import { tryCtx } from "../../core/context/request-context.js";
import { AppException } from "../../core/errors/app-exception.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";

/**
 * Kebijakan OTP penghapusan web (PRD 2.5, D1), SAMA dengan challenge OTP modul auth sehingga challenge `deletion`
 * nyata dan challenge pengganti (decoy) tidak dapat dibedakan dari nilai, batas maupun pesan galatnya.
 */
export const OTP_TTL_MS = 10 * 60_000;
export const OTP_RESEND_MS = 60_000;
export const OTP_MAX_ATTEMPTS = 5;
const HOUR_MS = 3600_000;
/** 5 pengiriman OTP per jam per email (kunci `otp:<email>` dipakai bersama semua tujuan, modul auth). */
const OTP_SENDS_PER_HOUR = 5;
/** Batas kirim per IP (kunci `otp-ip:<ip>` sama dengan modul auth). */
const OTP_SENDS_PER_IP_PER_HOUR = 60;
/** Kegagalan verifikasi kode per IP per 15 menit (kunci `otp-verify-ip:<ip>` sama dengan modul auth). */
export const OTP_VERIFY_FAILS_PER_IP = 50;
export const OTP_VERIFY_WINDOW_MS = 15 * 60_000;

export const otpExpired = (message = "Kode tidak berlaku lagi. Minta kode baru.") =>
  new AppException(410, "OTP_EXPIRED", message);

/** Kuota kirim OTP per IP lalu per email, urutan dan pesan identik dengan modul auth (PRD 2.5). */
@Injectable()
export class OtpQuota {
  constructor(private readonly limits: RateLimitService) {}

  async consume(email: string): Promise<void> {
    const ip = tryCtx()?.ip;
    if (ip)
      await this.limits.consumeOrThrow(
        `otp-ip:${ip}`,
        OTP_SENDS_PER_IP_PER_HOUR,
        HOUR_MS,
        "Terlalu banyak permintaan kode dari jaringan ini. Coba lagi nanti.",
      );
    await this.limits.consumeOrThrow(
      `otp:${email}`,
      OTP_SENDS_PER_HOUR,
      HOUR_MS,
      "Terlalu banyak permintaan kode. Coba lagi nanti.",
    );
  }
}
