import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import type { components } from "@kapdh/contracts";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import type { RedisClient } from "../../core/adapters/redis.js";
import { AppException } from "../../core/errors/app-exception.js";
import { decryptSecret, encryptSecret } from "../../core/identity/crypto.js";
import { maskEmail } from "../../core/identity/email.js";
import { CLOCK, ENV, REDIS } from "../../core/tokens.js";
import { OtpQuota, OTP_MAX_ATTEMPTS, OTP_RESEND_MS, OTP_TTL_MS, otpExpired } from "./otp-policy.js";

type OtpChallenge = components["schemas"]["OtpChallenge"];

/**
 * Challenge pengganti (decoy) alur non-enumerasi /public/deletion/challenge (kontrak account.yaml startWebDeletion,
 * auth.yaml resendOtp/getOtpChallengeStatus; PRD 2.5). Untuk email yang tidak terdaftar, akun admin, atau akun yang
 * sudah selesai dihapus, server mengembalikan challenge dengan bentuk, nilai, waktu dan batas 429 yang sama dengan
 * challenge nyata tanpa mengirim email:
 *
 * - `challenge_id` berbentuk UUID v7 biasa (stempel waktu Clock + bit acak) yang 56 bit terakhirnya adalah HMAC
 *   (OTP_HMAC_SECRET) atas 9 byte pertama. Tanpa secret tidak dapat dibedakan dari challenge nyata; server
 *   mengenalinya tanpa tabel (otp_codes mewajibkan user_id).
 * - Keadaan yang harus konsisten dengan challenge nyata (email tersamar, waktu kirim ulang, sudah diganti, jumlah
 *   percobaan) disimpan di {@link DecoyChallengeStore} (Redis bila REDIS_URL diisi, wajib di production; memori di
 *   development/uji) dengan TTL 24 jam. Email asli hanya disimpan terenkripsi (AES-256-GCM, kunci turunan
 *   OTP_HMAC_SECRET) karena kirim ulang wajib memakai batas kirim per email yang sama (PRD 2.5).
 * - Verifikasi selalu "kode salah" sampai percobaan habis, lalu 410 (kontrak verifyWebDeletion).
 *
 * Integrasi modul auth (pemilik POST /auth/otp/resend dan /auth/otp/status): sebelum mencari otp_codes, panggil
 * `resendIfDecoy(challengeId)` / `statusIfDecoy(challengeId)`; hasil null berarti bukan decoy (lanjutkan alur biasa).
 */

const DECOY_TAG_BYTES = 7;
const DECOY_DOMAIN = "kapdh-deletion-decoy:v1";
/** Masa simpan keadaan decoy; challenge nyata juga dapat dikirim ulang setelah kedaluwarsa (kontrak resendOtp). */
export const DECOY_STATE_TTL_MS = 24 * 3600_000;

function uuidBytes(id: string): Buffer | null {
  const hex = id.toLowerCase().replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function decoyTag(secret: string, head: Buffer): Buffer {
  return createHmac("sha256", secret).update(DECOY_DOMAIN).update(head).digest().subarray(0, DECOY_TAG_BYTES);
}

/** UUID v7 decoy bertanda HMAC dengan stempel waktu `issuedAt` (Clock aplikasi). */
export function issueDecoyChallengeId(secret: string, issuedAt: Date): string {
  const bytes = uuidBytes(uuidv7({ msecs: issuedAt.getTime() }))!;
  decoyTag(secret, bytes.subarray(0, 16 - DECOY_TAG_BYTES)).copy(bytes, 16 - DECOY_TAG_BYTES);
  return formatUuid(bytes);
}

/** Waktu terbit decoy bila `id` adalah decoy sah bertanda HMAC; null untuk id lain (termasuk challenge nyata). */
export function decoyIssuedAt(secret: string, id: string): Date | null {
  const bytes = uuidBytes(id);
  if (!bytes || bytes[6]! >> 4 !== 7) return null;
  const expected = decoyTag(secret, bytes.subarray(0, 16 - DECOY_TAG_BYTES));
  if (!timingSafeEqual(expected, bytes.subarray(16 - DECOY_TAG_BYTES))) return null;
  return new Date(bytes.readUIntBE(0, 6));
}

/** Keadaan decoy yang disimpan; tidak memuat email polos. */
export interface DecoyState {
  /** Email tersamar yang ditampilkan (`ab***@domain`). */
  emailMasked: string;
  /** Email ternormalisasi terenkripsi, untuk batas kirim per email saat kirim ulang. */
  emailSealed: string;
  resendAvailableAt: number;
  superseded: boolean;
}

/** Penyimpanan keadaan decoy: Redis (lintas instance) atau memori. */
export interface DecoyChallengeStore {
  put(id: string, state: DecoyState, ttlMs: number): Promise<void>;
  get(id: string): Promise<DecoyState | null>;
  /** Menambah satu percobaan secara atomik; mengembalikan jumlah percobaan sesudahnya. */
  addAttempt(id: string, ttlMs: number): Promise<number>;
  attempts(id: string): Promise<number>;
}

class MemoryDecoyStore implements DecoyChallengeStore {
  private readonly states = new Map<string, { state: DecoyState; expiresAt: number }>();
  private readonly counters = new Map<string, { count: number; expiresAt: number }>();
  private static readonly MAX_ENTRIES = 10_000;

  constructor(private readonly clock: Clock) {}

  private now() {
    return this.clock.now().getTime();
  }

  private prune<T extends { expiresAt: number }>(map: Map<string, T>) {
    const now = this.now();
    for (const [key, value] of map) if (value.expiresAt <= now) map.delete(key);
    while (map.size > MemoryDecoyStore.MAX_ENTRIES) map.delete(map.keys().next().value!);
  }

  async put(id: string, state: DecoyState, ttlMs: number): Promise<void> {
    this.prune(this.states);
    this.states.set(id, { state: { ...state }, expiresAt: this.now() + ttlMs });
  }

  async get(id: string): Promise<DecoyState | null> {
    const entry = this.states.get(id);
    if (!entry || entry.expiresAt <= this.now()) return null;
    return { ...entry.state };
  }

  async addAttempt(id: string, ttlMs: number): Promise<number> {
    this.prune(this.counters);
    const current = this.counters.get(id);
    const count = (current && current.expiresAt > this.now() ? current.count : 0) + 1;
    this.counters.set(id, { count, expiresAt: current?.expiresAt ?? this.now() + ttlMs });
    return count;
  }

  async attempts(id: string): Promise<number> {
    const entry = this.counters.get(id);
    return entry && entry.expiresAt > this.now() ? entry.count : 0;
  }
}

class RedisDecoyStore implements DecoyChallengeStore {
  constructor(private readonly redis: RedisClient) {}

  private key(kind: "s" | "a", id: string) {
    return `kapdh:decoy:${kind}:${id}`;
  }

  async put(id: string, state: DecoyState, ttlMs: number): Promise<void> {
    await this.redis.set(this.key("s", id), JSON.stringify(state), "PX", ttlMs);
  }

  async get(id: string): Promise<DecoyState | null> {
    const raw = await this.redis.get(this.key("s", id));
    return raw ? (JSON.parse(raw) as DecoyState) : null;
  }

  async addAttempt(id: string, ttlMs: number): Promise<number> {
    const key = this.key("a", id);
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.pexpire(key, ttlMs);
    return count;
  }

  async attempts(id: string): Promise<number> {
    return Number((await this.redis.get(this.key("a", id))) ?? 0);
  }
}

/**
 * Penerbit dan penilai challenge decoy penghapusan web (lihat kepala berkas). Khusus runtime API (memerlukan
 * OTP_HMAC_SECRET); diekspor AccountModule agar modul auth dapat mendelegasikan resend/status challenge decoy.
 */
@Injectable()
export class WebDeletionDecoys {
  private readonly store: DecoyChallengeStore;
  private readonly sealKey: string;

  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(REDIS) redis: RedisClient | null,
    private readonly quota: OtpQuota,
  ) {
    this.store = redis ? new RedisDecoyStore(redis) : new MemoryDecoyStore(clock);
    this.sealKey = createHash("sha256").update(`kapdh-decoy-seal:${env.OTP_HMAC_SECRET}`).digest("hex");
  }

  /** true bila `challengeId` adalah decoy sah (tanpa melihat keadaannya). */
  isDecoy(challengeId: string): boolean {
    return decoyIssuedAt(this.env.OTP_HMAC_SECRET, challengeId) !== null;
  }

  /**
   * Menerbitkan decoy untuk email ternormalisasi `email` SETELAH kuota kirim dikonsumsi pemanggil (urutan dan pesan
   * 429 sama dengan challenge nyata). Tidak mengirim email.
   */
  async issue(email: string): Promise<OtpChallenge> {
    const now = this.clock.now();
    const id = issueDecoyChallengeId(this.env.OTP_HMAC_SECRET, now);
    const state: DecoyState = {
      emailMasked: maskEmail(email),
      emailSealed: encryptSecret(email, this.sealKey),
      resendAvailableAt: now.getTime() + OTP_RESEND_MS,
      superseded: false,
    };
    await this.store.put(id, state, DECOY_STATE_TTL_MS);
    return this.toChallenge(id, now, state, 0);
  }

  /**
   * Verifikasi kode untuk decoy (kontrak verifyWebDeletion "selalu diperlakukan sebagai kode salah sampai percobaan
   * habis"). Mengembalikan null bila bukan decoy. Melempar 400 VALIDATION_ERROR (sisa percobaan) atau 410 seperti
   * challenge nyata: 410 tanpa menghitung percobaan bila sudah diganti, kedaluwarsa atau percobaan habis.
   */
  async verify(challengeId: string): Promise<{ counted: boolean; error: AppException } | null> {
    const issuedAt = decoyIssuedAt(this.env.OTP_HMAC_SECRET, challengeId);
    if (!issuedAt) return null;
    const now = this.clock.now();
    const state = await this.store.get(challengeId);
    if (!state || state.superseded || issuedAt.getTime() + OTP_TTL_MS <= now.getTime())
      return { counted: false, error: otpExpired() };
    if ((await this.store.attempts(challengeId)) >= OTP_MAX_ATTEMPTS)
      return { counted: false, error: otpExpired() };
    const attempts = await this.store.addAttempt(challengeId, DECOY_STATE_TTL_MS);
    const left = OTP_MAX_ATTEMPTS - attempts;
    if (left <= 0) return { counted: true, error: otpExpired() };
    return {
      counted: true,
      error: new AppException(400, "VALIDATION_ERROR", `Kode salah. Sisa percobaan ${left}.`, {
        fieldErrors: { code: [`Kode salah. Sisa percobaan ${left}.`] },
      }),
    };
  }

  /**
   * POST /auth/otp/resend untuk decoy (kontrak resendOtp): null bila bukan decoy. Sama dengan challenge nyata:
   * 410 bila tidak dikenal/sudah diganti, 429 sebelum cooldown 60 detik, kuota kirim per IP dan per email yang sama,
   * lalu decoy baru menggantikan yang lama (tanpa email).
   */
  async resendIfDecoy(challengeId: string): Promise<OtpChallenge | null> {
    if (!this.isDecoy(challengeId)) return null;
    const now = this.clock.now();
    const state = await this.store.get(challengeId);
    if (!state) throw otpExpired("Mulai ulang pendaftaran atau masuk kembali.");
    if (state.superseded) throw otpExpired("Kode ini sudah diganti kode yang lebih baru.");
    if (state.resendAvailableAt > now.getTime()) {
      const wait = Math.ceil((state.resendAvailableAt - now.getTime()) / 1000);
      throw new AppException(429, "RATE_LIMITED", `Kirim ulang tersedia dalam ${wait} detik.`, {
        retryAfterSeconds: wait,
      });
    }
    const email = decryptSecret(state.emailSealed, this.sealKey);
    await this.quota.consume(email);
    await this.store.put(challengeId, { ...state, superseded: true }, DECOY_STATE_TTL_MS);
    return this.issue(email);
  }

  /** POST /auth/otp/status untuk decoy (kontrak getOtpChallengeStatus): null bila bukan decoy. */
  async statusIfDecoy(challengeId: string): Promise<OtpChallenge | null> {
    const issuedAt = decoyIssuedAt(this.env.OTP_HMAC_SECRET, challengeId);
    if (!issuedAt) return null;
    const state = await this.store.get(challengeId);
    if (!state || state.superseded) throw otpExpired("Mulai ulang pendaftaran atau masuk kembali.");
    return this.toChallenge(challengeId, issuedAt, state, await this.store.attempts(challengeId));
  }

  private toChallenge(id: string, issuedAt: Date, state: DecoyState, attempts: number): OtpChallenge {
    return {
      challenge_id: id,
      purpose: "deletion",
      email_masked: state.emailMasked,
      expires_at: new Date(issuedAt.getTime() + OTP_TTL_MS).toISOString(),
      resend_available_at: new Date(state.resendAvailableAt).toISOString(),
      attempts_left: Math.max(0, OTP_MAX_ATTEMPTS - attempts),
      max_attempts: OTP_MAX_ATTEMPTS,
    };
  }
}
