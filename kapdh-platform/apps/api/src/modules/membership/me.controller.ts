import { Body, Controller, Get, Header, Headers, HttpCode, Patch } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { parseIfMatch } from "../../core/concurrency/if-match.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, MemberAccess } from "../../core/guards/decorators.js";
import { validate } from "../../core/validation/validate.js";
import { MemberCardService } from "./member-card.service.js";
import { MemberProfileService } from "./member-profile.service.js";
import { assertKnownFields, PROFILE_UPDATE_KEYS, profileUpdateSchema } from "./profile-input.js";

export { toMembershipPayment } from "./membership-view.js";

type Me = components["schemas"]["Me"];
type MemberCard = components["schemas"]["MemberCard"];
type Membership = components["schemas"]["Membership"];

/** Profil, KTA dan periode milik sendiri (kontrak me.yaml; F-05, F-07, F-10; PRD 2.2, 3.5, 3.7). */
@Controller("me")
export class MeController {
  constructor(
    private readonly profiles: MemberProfileService,
    private readonly cards: MemberCardService,
  ) {}

  /**
   * Profil, status akun/keanggotaan dan penunjuk iuran terbuka yang menentukan rute klien (PRD 2.2, AC F02-1);
   * terbuka untuk semua effective_status yang memiliki sesi.
   */
  @Get()
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("any")
  me(@CurrentAuth() auth: AuthContext): Promise<Me> {
    return this.profiles.me(auth);
  }

  /**
   * Ubah profil umum, profesi/keahlian, avatar dan privasi sendiri (F-10, AC F10-2, F10-4). Identitas keanggotaan dan
   * nomor tidak dapat diubah di sini (AC F05-6): field di luar skema ditolak 400 sebelum apa pun berubah.
   */
  @Patch("profile")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("nonsuspended")
  async updateProfile(
    @CurrentAuth() auth: AuthContext,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<Me> {
    const expectedVersion = parseIfMatch(ifMatch);
    const known = assertKnownFields(body, PROFILE_UPDATE_KEYS, { identityEditable: false, minFields: 1 });
    const input = validate(profileUpdateSchema, known);
    return this.profiles.updateProfile(auth, expectedVersion, input);
  }

  /**
   * KTA digital dengan token QR bertanda tangan (F-05, AC F05-1..F05-5). Tidak dicache perantara: memuat token QR
   * berumur pendek.
   */
  @Get("card")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("any")
  @Header("cache-control", "no-store")
  card(@CurrentAuth() auth: AuthContext): Promise<MemberCard> {
    return this.cards.cardOf(auth);
  }

  /** Periode keanggotaan, jendela dan kelayakan perpanjangan, histori periode (F-07, AC F07-1..F07-5). */
  @Get("membership")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("any")
  membership(@CurrentAuth() auth: AuthContext): Promise<Membership> {
    return this.profiles.membershipOf(auth);
  }
}
