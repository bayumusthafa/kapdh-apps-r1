import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import type { Clock } from "../../core/adapters/clock.js";
import { AppException } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { academicYears, cohortCode } from "../../core/membership/member-number.js";
import { QrTokenService } from "../../core/qr/qr-token.service.js";
import type { Db } from "../../core/db/types.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { MemberProfileService } from "./member-profile.service.js";
import {
  cardAction,
  cardAllowsQr,
  cardStatusFor,
  offlineValidUntil,
  renewalState,
} from "./membership-view.js";
import { loadMemberMasters } from "./profile-masters.js";

type MemberCard = components["schemas"]["MemberCard"];

/**
 * KTA digital (F-05, PRD 3.5, guideline hal. 6). Isi dan status selalu dari server (AC F05-4); QR hanya untuk kartu
 * active/expiring, token baru setiap pemanggilan dengan exp = min(iat + 7 hari, expires_at) (AC F05-5). Cache offline
 * diputuskan klien dari `offline_valid_until` (AC F05-2, F05-3). Hanya runtime API (QrTokenService).
 */
@Injectable()
export class MemberCardService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly profiles: MemberProfileService,
    private readonly qr: QrTokenService,
  ) {}

  async cardOf(auth: AuthContext): Promise<MemberCard> {
    const account = await this.profiles.loadAccount(auth.userId);
    const profile = account?.profile;
    // Nomor dialokasikan saat OTP pendaftaran (AC F05-1); sesi biasa hanya ada setelah itu.
    if (!profile || !profile.memberNumber || profile.memberSeq === null)
      throw new AppException(404, "NOT_FOUND", "KTA belum tersedia.");
    const status = await this.profiles.statusOf(auth);
    const syncedAt = this.clock.now();
    const statusLabel = cardStatusFor(status);
    const masters = await loadMemberMasters(this.db, auth.userId);
    const open = await this.profiles.openPayments(auth.userId);
    const renewal = renewalState(profile.expiresAt, status, syncedAt);
    const { action, openPaymentId } = cardAction({
      status,
      registrationPaymentId: open.registration?.id ?? null,
      renewalPaymentId: open.renewal?.id ?? null,
      renewalOpen: renewal.eligible,
    });

    // QR bertanda tangan server tanpa kontak/secret (PRD 3.5); terikat user_id dan N, bukan prefix (AC F05-6).
    const signed =
      cardAllowsQr(statusLabel) && profile.expiresAt
        ? await this.qr.sign({
            userId: profile.userId,
            memberSeq: profile.memberSeq,
            membershipExpiresAt: profile.expiresAt,
          })
        : null;
    const years = academicYears(profile.cohort, profile.classIn, profile.classOut);
    const validUntil = offlineValidUntil(syncedAt, profile.expiresAt, signed?.expiresAt ?? null);
    return {
      status_label: statusLabel,
      member_number: profile.memberNumber,
      full_name: profile.fullName,
      cohort: profile.cohort,
      cohort_code: cohortCode(profile.cohort),
      graduation_year: years.graduationYear,
      qr: signed
        ? {
            url: this.qr.qrContent(profile.memberNumber, signed.token),
            token_expires_at: signed.expiresAt.toISOString(),
          }
        : null,
      expires_at: profile.expiresAt?.toISOString() ?? null,
      // Label historis tetap tampil walau master dinonaktifkan (AC F10-4).
      profession_label: masters.profession?.label ?? null,
      // Kota saja, bukan alamat lengkap (disahkan v3.3).
      city: profile.city,
      // Suspended → null: URL privat tidak dapat dibuka penampil suspended (PRD 2.2, 5.4).
      avatar_url: await this.profiles.ownAvatarUrl(auth, status, profile.avatarFileId),
      action,
      open_payment_id: openPaymentId,
      renewal_opens_at: renewal.opensAt?.toISOString() ?? null,
      offline_valid_until: validUntil?.toISOString() ?? null,
      synced_at: syncedAt.toISOString(),
    };
  }
}
