import { Controller, Get, Inject } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import {
  alumni,
  alumniProfessions,
  alumniSkills,
  masterProfessions,
  masterSkills,
  payments,
  users,
} from "@kapdh/database";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Clock } from "../../core/adapters/clock.js";
import type { Db } from "../../core/db/types.js";
import { notFound } from "../../core/errors/app-exception.js";
import { FilesService } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, MemberAccess } from "../../core/guards/decorators.js";
import { MembershipKernel } from "../../core/membership/membership.kernel.js";
import { academicYears, cohortCode, educationStatus } from "../../core/membership/member-number.js";
import { renewalOpensAt } from "../../core/membership/period.js";
import { CLOCK, DB } from "../../core/tokens.js";

type Me = components["schemas"]["Me"];
type MeMembershipPayment = components["schemas"]["MeMembershipPayment"];
type PaymentRow = typeof payments.$inferSelect;

/**
 * Penunjuk iuran keanggotaan nonterminal untuk perutean layar Biaya KTA / unggah bukti / Menunggu / Ditolak
 * (PRD 2.2, 4.3, AC F03-3, F04-2): pending tanpa bukti = awaiting_proof, pending dengan bukti = awaiting_review,
 * rejected = dapat diperbaiki dengan payment yang sama. Alasan penolakan hanya untuk pemilik dan hanya saat ditolak.
 */
export function toMembershipPayment(row: PaymentRow): MeMembershipPayment {
  const stage =
    row.status === "rejected" ? "rejected" : row.proofVersion === 0 ? "awaiting_proof" : "awaiting_review";
  return {
    id: row.id,
    stage,
    amount: row.amount,
    proof_version: row.proofVersion,
    created_at: row.createdAt.toISOString(),
    submitted_at: row.submittedAt?.toISOString() ?? null,
    decided_at: row.decidedAt?.toISOString() ?? null,
    rejection_reason: row.status === "rejected" ? row.rejectionReason : null,
  };
}

@Controller("me")
export class MeController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly membership: MembershipKernel,
    private readonly files: FilesService,
  ) {}

  /**
   * Profil, status akun/keanggotaan dan penunjuk iuran terbuka yang menentukan rute klien (PRD 2.2, AC F02-1);
   * terbuka untuk semua effective_status yang memiliki sesi.
   */
  @Get()
  @Audience("mobile")
  @MemberAccess("any")
  async me(@CurrentAuth() auth: AuthContext): Promise<Me> {
    const userId = auth.userId;
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    const profile = await this.db.query.alumni.findFirst({ where: eq(alumni.userId, userId) });
    if (!user || !profile) throw notFound("Profil tidak ditemukan.");

    const [profession] = await this.db
      .select({ id: masterProfessions.id, label: masterProfessions.label, active: masterProfessions.active })
      .from(alumniProfessions)
      .innerJoin(masterProfessions, eq(alumniProfessions.professionId, masterProfessions.id))
      .where(eq(alumniProfessions.alumniUserId, userId))
      .limit(1);
    // Master nonaktif tetap tampil sebagai label historis (AC F10-4).
    const skills = await this.db
      .select({ id: masterSkills.id, label: masterSkills.label, active: masterSkills.active })
      .from(alumniSkills)
      .innerJoin(masterSkills, eq(alumniSkills.skillId, masterSkills.id))
      .where(eq(alumniSkills.alumniUserId, userId))
      .orderBy(asc(masterSkills.sortOrder), asc(masterSkills.label));
    // Paling banyak satu payment nonterminal per tipe (payments_user_id_type_open_key, PRD 6.4).
    const openPayments = await this.db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.userId, userId),
          inArray(payments.type, ["registration", "renewal"]),
          inArray(payments.status, ["pending", "rejected"]),
        ),
      );
    const openOf = (type: "registration" | "renewal") => {
      const row = openPayments.find((payment) => payment.type === type);
      return row ? toMembershipPayment(row) : null;
    };

    const now = this.clock.now();
    // Dihitung guard pada request ini dari data canonical (PRD 4.2); cadangan bila rute dipanggil tanpa guard.
    const status =
      auth.effectiveStatus ??
      (await this.membership.effectiveStatusFor(userId, { now }))?.status ??
      "unverified";
    // Jendela renewal dibuka 30 hari sebelum habis dan tetap terbuka setelah expired; suspend menutup kelayakan
    // pembayaran baru (AC F07-5, PRD 2.2).
    const opensAt = profile.expiresAt ? renewalOpensAt(profile.expiresAt) : null;
    const years = academicYears(profile.cohort, profile.classIn, profile.classOut);
    return {
      user_id: user.id,
      email: user.email,
      account_status: user.status,
      effective_status: status,
      member_number: profile.memberNumber,
      cohort_code: cohortCode(profile.cohort),
      starts_at: profile.startsAt?.toISOString() ?? null,
      expires_at: profile.expiresAt?.toISOString() ?? null,
      renewal_eligible: opensAt !== null && status !== "suspended" && now.getTime() >= opensAt.getTime(),
      renewal_opens_at: opensAt?.toISOString() ?? null,
      registration_payment: openOf("registration"),
      renewal_payment: openOf("renewal"),
      suspension_message: profile.suspendedAt ? profile.suspensionMessage : null,
      version: String(profile.version),
      profile: {
        full_name: profile.fullName,
        gender: profile.gender,
        cohort: profile.cohort,
        class_in: profile.classIn,
        class_out: profile.classOut,
        graduation_year: years.graduationYear,
        entry_year: years.entryYear,
        exit_year: years.exitYear,
        education_status: educationStatus(profile.classIn, profile.classOut),
        city: profile.city,
        phone: profile.phone,
        bio: profile.bio,
        last_education_institution: profile.lastEducationInstitution,
        last_education_city: profile.lastEducationCity,
        social_instagram: profile.socialInstagram,
        social_x: profile.socialX,
        social_facebook: profile.socialFacebook,
        social_linkedin: profile.socialLinkedin,
        profession: profession ?? null,
        skills,
        avatar_file_id: profile.avatarFileId,
        avatar_url: await this.avatarUrl(profile.avatarFileId, auth),
        privacy: {
          show_in_directory: profile.showInDirectory,
          show_phone: profile.showPhone,
          show_email: profile.showEmail,
          show_social: profile.showSocial,
        },
      },
    };
  }

  /**
   * URL foto milik sendiri (PRD 5.4): publik → URL tetap; privat → URL bertanda tangan <= 10 menit yang terikat sesi
   * pemanggil (logout/suspend mematikannya). Berkas yang belum/tidak lagi `ready` → null (klien memakai inisial).
   */
  private async avatarUrl(fileId: string | null, auth: AuthContext): Promise<string | null> {
    if (!fileId) return null;
    const file = await this.files.findReady(fileId);
    if (!file) return null;
    const { url } = await this.files.signedUrl(file, {
      userId: auth.userId,
      sessionId: auth.sessionId,
      sessionVersion: auth.sessionVersion,
    });
    return url;
  }
}
