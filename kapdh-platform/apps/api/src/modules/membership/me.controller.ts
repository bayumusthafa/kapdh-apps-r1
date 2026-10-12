import { Controller, Get, Inject } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { alumni, users } from "@kapdh/database";
import { eq } from "drizzle-orm";
import type { Db } from "../../core/db/types.js";
import { notFound } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, MemberAccess } from "../../core/guards/decorators.js";
import { academicYears, educationStatus } from "../../core/membership/member-number.js";
import { DB } from "../../core/tokens.js";

type Me = components["schemas"]["Me"];

@Controller("me")
export class MeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Profil dan effective_status yang menentukan rute klien (PRD 2.2, AC F02-1); terbuka untuk semua status. */
  @Get()
  @Audience("mobile")
  @MemberAccess("any")
  async me(@CurrentAuth() auth: AuthContext): Promise<Me> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, auth.userId) });
    const profile = await this.db.query.alumni.findFirst({ where: eq(alumni.userId, auth.userId) });
    if (!user || !profile) throw notFound("Profil tidak ditemukan.");
    const years = academicYears(profile.cohort, profile.classIn, profile.classOut);
    return {
      user_id: user.id,
      email: user.email,
      // Dihitung guard pada request ini dari data canonical (PRD 4.2).
      effective_status: auth.effectiveStatus!,
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
