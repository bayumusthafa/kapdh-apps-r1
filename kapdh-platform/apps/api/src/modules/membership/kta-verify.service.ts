import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { alumni, users } from "@kapdh/database";
import { eq } from "drizzle-orm";
import type { Clock } from "../../core/adapters/clock.js";
import { tryCtx } from "../../core/context/request-context.js";
import type { Db } from "../../core/db/types.js";
import { FilesService } from "../../core/files/files.service.js";
import { sha256 } from "../../core/identity/crypto.js";
import { type AccountStatus, effectiveStatus } from "../../core/membership/effective-status.js";
import { cohortCode } from "../../core/membership/member-number.js";
import { QR_MAX_TTL_SECONDS, QrTokenService, qrBindingMatches } from "../../core/qr/qr-token.service.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { CLOCK, DB } from "../../core/tokens.js";

type KtaVerification = components["schemas"]["KtaVerification"];
type KtaVerifiedMember = components["schemas"]["KtaVerifiedMember"];
type KtaVerifyRequest = components["schemas"]["KtaVerifyRequest"];

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 3600_000;
/**
 * Batas laju verifikasi (Usulan; nilai final D1). Per IP untuk semua request, per hash token untuk semua request, dan
 * per nomor anggota HANYA untuk token bertanda tangan sah (kontrak verifyKta), sehingga token sampah untuk nomor yang
 * ditebak tidak pernah menghabiskan kuota nomor itu dan pemeriksa sah tidak ikut diblokir (F-06, AC F06-4).
 */
export const KTA_VERIFY_LIMITS = {
  perIp: { limit: 60, windowMs: MINUTE_MS },
  perToken: { limit: 20, windowMs: MINUTE_MS },
  perNumber: { limit: 30, windowMs: MINUTE_MS },
} as const;
/** Identitas pada hasil `expired` dari token lewat exp hanya bila exp paling lama 30 hari sebelum checked_at (C2). */
export const EXPIRED_IDENTITY_WINDOW_MS = 30 * DAY_MS;
/** URL foto pemeriksa berumur pendek (D3, PRD 5.4). */
const AVATAR_URL_TTL_SECONDS = 300;
const RATE_LIMIT_MESSAGE = "Terlalu banyak permintaan verifikasi. Coba lagi sebentar lagi.";

/**
 * Verifikasi KTA publik (F-06, AC F06-1..F06-4, F05-4, F05-5, F05-6, F12-4). Urutan penilaian kontrak public.yaml,
 * langkah pertama yang cocok menentukan hasil:
 * 1. tanda tangan/kid/iss/aud/bentuk klaim gagal → invalid_token, TANPA membaca data anggota;
 * 2. akun `sub` tidak ada/terhapus → not_found (juga bila exp lewat), tanpa identitas;
 * 3. keterikatan gagal (nomor request bukan nomor TERKINI akun, atau seq ≠ N) → invalid_token;
 * 4. exp lewat → expired hanya bila token dipangkas masa keanggotaan (exp < iat + 7 hari) DAN status terkini expired;
 *    selain itu invalid_token; tidak pernah active;
 * 5. exp belum lewat → verified: active; expiring: active + expiring; expired: expired; lainnya: inactive.
 * Status selalu dari DB terkini (AC F05-4); token mentah tidak pernah disimpan atau dicatat (hanya hash untuk kuota).
 */
@Injectable()
export class KtaVerifyService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly qr: QrTokenService,
    private readonly limits: RateLimitService,
    private readonly files: FilesService,
  ) {}

  async verify(input: KtaVerifyRequest): Promise<KtaVerification> {
    const ip = tryCtx()?.ip;
    if (ip)
      await this.limits.consumeOrThrow(
        `kta-verify-ip:${ip}`,
        KTA_VERIFY_LIMITS.perIp.limit,
        KTA_VERIFY_LIMITS.perIp.windowMs,
        RATE_LIMIT_MESSAGE,
      );
    await this.limits.consumeOrThrow(
      `kta-verify-token:${sha256(input.token)}`,
      KTA_VERIFY_LIMITS.perToken.limit,
      KTA_VERIFY_LIMITS.perToken.windowMs,
      RATE_LIMIT_MESSAGE,
    );

    const now = this.clock.now();
    const result = (
      outcome: KtaVerification["result"],
      member: KtaVerifiedMember | null = null,
      expiring = false,
    ): KtaVerification => ({ result: outcome, checked_at: now.toISOString(), expiring, member });

    // Langkah 1: tanpa membaca data anggota sehingga keberadaan nomor tidak dapat ditebak (AC F06-3).
    const claims = await this.qr.inspect(input.token);
    if (!claims) return result("invalid_token");
    await this.limits.consumeOrThrow(
      `kta-verify-number:${input.member_number}`,
      KTA_VERIFY_LIMITS.perNumber.limit,
      KTA_VERIFY_LIMITS.perNumber.windowMs,
      RATE_LIMIT_MESSAGE,
    );

    // Langkah 2: akun sub tidak ada lagi atau sudah dihapus (F-14) → Tidak ditemukan (AC F06-2).
    const [account] = await this.db
      .select({
        userId: users.id,
        kind: users.kind,
        accountStatus: users.status,
        fullName: alumni.fullName,
        cohort: alumni.cohort,
        memberSeq: alumni.memberSeq,
        memberNumber: alumni.memberNumber,
        expiresAt: alumni.expiresAt,
        suspendedAt: alumni.suspendedAt,
        avatarFileId: alumni.avatarFileId,
      })
      .from(users)
      .innerJoin(alumni, eq(alumni.userId, users.id))
      .where(eq(users.id, claims.userId))
      .limit(1);
    if (!account || account.kind !== "alumni" || account.accountStatus === "deleted")
      return result("not_found");

    // Langkah 3: QR terbit sebelum koreksi nomor, atau nomor rekaan → "perlu diperbarui" (AC F05-6).
    if (!qrBindingMatches(claims, account, input.member_number)) return result("invalid_token");

    const status = effectiveStatus(
      {
        accountStatus: account.accountStatus as AccountStatus,
        expiresAt: account.expiresAt,
        suspendedAt: account.suspendedAt,
      },
      now,
    );
    const identity = async (withPhoto: boolean): Promise<KtaVerifiedMember | null> => {
      if (!account.memberNumber || !account.expiresAt) return null;
      return {
        full_name: account.fullName,
        cohort_code: cohortCode(account.cohort),
        member_number: account.memberNumber,
        expires_at: account.expiresAt.toISOString(),
        avatar_url: withPhoto ? await this.photoUrl(account.avatarFileId) : null,
      };
    };

    // Langkah 4: token lama tunduk expiry (AC F05-5, F06-3): tidak pernah Aktif.
    if (claims.expired) {
      const clampedByMembership =
        claims.expiresAt.getTime() < claims.issuedAt.getTime() + QR_MAX_TTL_SECONDS * 1000;
      if (!clampedByMembership || status !== "expired") return result("invalid_token");
      const recent = claims.expiresAt.getTime() >= now.getTime() - EXPIRED_IDENTITY_WINDOW_MS;
      return result("expired", recent ? await identity(false) : null);
    }

    // Langkah 5: status server terkini, tanpa alasan privat (AC F06-1, F06-2, F12-4).
    switch (status) {
      case "verified":
        return result("active", await identity(true));
      case "expiring":
        return result("active", await identity(true), true);
      case "expired":
        return result("expired", await identity(false));
      default:
        return result("inactive");
    }
  }

  /** Foto untuk dicocokkan pemeriksa: URL anonim berumur pendek (tanpa sesi), hanya untuk hasil active (D3). */
  private async photoUrl(fileId: string | null): Promise<string | null> {
    if (!fileId) return null;
    const file = await this.files.findReady(fileId);
    if (!file || file.purpose !== "avatar") return null;
    return (await this.files.signedUrl(file, null, { ttlSeconds: AVATAR_URL_TTL_SECONDS })).url;
  }
}
