import { Controller, Get, Inject, Req, UseGuards } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { alumni, users } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { AppException } from "../common/app-exception.js";
import { AuthGuard, type AuthedRequest, RequireAuth } from "../auth/auth.guard.js";
import { CLOCK, type Clock } from "../infra/clock.js";
import type { Db } from "../infra/db.js";
import { DB } from "../infra/tokens.js";
import { effectiveStatus } from "../membership/effective-status.js";
import { academicYears, educationStatus } from "../membership/member-number.js";

type Me = components["schemas"]["Me"];

@Controller("me")
@UseGuards(AuthGuard)
export class MeController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Profil dan effective_status yang menentukan rute klien (PRD 2.2). */
  @Get()
  @RequireAuth("mobile")
  async me(@Req() req: AuthedRequest): Promise<Me> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, req.auth!.userId) });
    const profile = await this.db.query.alumni.findFirst({ where: eq(alumni.userId, req.auth!.userId) });
    if (!user || !profile) throw new AppException(404, "NOT_FOUND", "Profil tidak ditemukan.");
    const years = academicYears(profile.cohort, profile.classIn, profile.classOut);
    return {
      user_id: user.id,
      email: user.email,
      effective_status: effectiveStatus(
        { accountStatus: user.status, expiresAt: profile.expiresAt, suspendedAt: profile.suspendedAt },
        this.clock.now(),
      ),
      pending_payment_id: null,
      member_number: profile.memberNumber,
      expires_at: profile.expiresAt?.toISOString() ?? null,
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
        skills: [],
        avatar_file_id: profile.avatarFileId,
        privacy: {
          show_in_directory: profile.showInDirectory,
          show_phone: profile.showPhone,
          show_social: profile.showSocial,
        },
      },
    };
  }
}
