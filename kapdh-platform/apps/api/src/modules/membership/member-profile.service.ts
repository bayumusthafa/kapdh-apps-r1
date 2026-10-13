import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { alumni, membershipEvents, payments, users } from "@kapdh/database";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Clock } from "../../core/adapters/clock.js";
import type { DbOrTx, Db, Tx } from "../../core/db/types.js";
import { AppException, notFound, versionConflict } from "../../core/errors/app-exception.js";
import type { FileTokenSubject } from "../../core/files/file-token.js";
import { FilesService } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { memberAccessAllows } from "../../core/membership/access.js";
import type { EffectiveStatus } from "../../core/membership/effective-status.js";
import { MembershipKernel } from "../../core/membership/membership.kernel.js";
import { academicYears, cohortCode, educationStatus } from "../../core/membership/member-number.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { renewalState, toMembershipPayment } from "./membership-view.js";
import { loadMemberMasters, replaceProfession, replaceSkills } from "./profile-masters.js";
import type { ProfileUpdateInput } from "./profile-input.js";

type Me = components["schemas"]["Me"];
type Membership = components["schemas"]["Membership"];
type MembershipPeriod = components["schemas"]["MembershipPeriod"];
type MeMembershipPayment = components["schemas"]["MeMembershipPayment"];
type AlumniRow = typeof alumni.$inferSelect;
type UserRow = typeof users.$inferSelect;

export interface MemberAccount {
  user: UserRow;
  profile: AlumniRow;
}

export interface OpenMembershipPayments {
  registration: MeMembershipPayment | null;
  renewal: MeMembershipPayment | null;
}

/** Penampil berkas = sesi pemanggil (URL foto bertanda tangan terikat sesi, PRD 5.4). */
export function fileSubjectOf(
  auth: Pick<AuthContext, "userId" | "sessionId" | "sessionVersion">,
): FileTokenSubject {
  return { userId: auth.userId, sessionId: auth.sessionId, sessionVersion: auth.sessionVersion };
}

/**
 * Profil sendiri, status keanggotaan dan periode (F-05, F-07, F-10; PRD 2.2, 3.5, 3.7). Semua status dihitung dari
 * data canonical pada request (AC F07-3), bukan dari jadwal worker.
 */
@Injectable()
export class MemberProfileService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly membership: MembershipKernel,
    private readonly files: FilesService,
  ) {}

  /** Akun alumni (users + alumni) atau null bila tidak ada/bukan alumni. */
  async loadAccount(userId: string, db: DbOrTx = this.db): Promise<MemberAccount | null> {
    const [row] = await db
      .select({ user: users, profile: alumni })
      .from(users)
      .innerJoin(alumni, eq(alumni.userId, users.id))
      .where(and(eq(users.id, userId), eq(users.kind, "alumni")))
      .limit(1);
    return row ?? null;
  }

  /** Paling banyak satu payment nonterminal per tipe (payments_user_id_type_open_key, PRD 6.4). */
  async openPayments(userId: string, db: DbOrTx = this.db): Promise<OpenMembershipPayments> {
    const rows = await db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.userId, userId),
          inArray(payments.type, ["registration", "renewal"]),
          inArray(payments.status, ["pending", "rejected"]),
        ),
      )
      .orderBy(desc(payments.createdAt));
    const of = (type: "registration" | "renewal") => {
      const row = rows.find((payment) => payment.type === type);
      return row ? toMembershipPayment(row) : null;
    };
    return { registration: of("registration"), renewal: of("renewal") };
  }

  /**
   * URL foto (PRD 5.4): publik → URL tetap; privat → URL bertanda tangan <= 10 menit terikat sesi penampil
   * (logout/suspend mematikannya). Berkas yang belum/tidak lagi `ready` → null (klien memakai inisial).
   */
  async avatarUrl(
    fileId: string | null,
    viewer: FileTokenSubject | null,
    db: DbOrTx = this.db,
  ): Promise<string | null> {
    if (!fileId) return null;
    const file = await this.files.findReady(fileId, db);
    if (!file || file.purpose !== "avatar") return null;
    return (await this.files.signedUrl(file, viewer)).url;
  }

  /**
   * Foto profil pemanggil sendiri (GET /me, GET /me/card). URL privat dibuka ulang lewat FileAccessPolicy yang hanya
   * menerima penampil anggota nonsuspended (PRD 2.2, 5.4), sehingga anggota suspended mendapat null (klien memakai
   * inisial, juga pada salinan offline kartu) alih-alih URL yang selalu 404.
   */
  async ownAvatarUrl(
    auth: AuthContext,
    status: EffectiveStatus,
    fileId: string | null,
    db: DbOrTx = this.db,
  ): Promise<string | null> {
    if (!memberAccessAllows("nonsuspended", status)) return null;
    return this.avatarUrl(fileId, fileSubjectOf(auth), db);
  }

  /** effective_status pemanggil: hasil guard request ini, atau dihitung ulang dari data canonical. */
  async statusOf(auth: AuthContext, db: DbOrTx = this.db): Promise<EffectiveStatus> {
    return (
      auth.effectiveStatus ??
      (await this.membership.effectiveStatusFor(auth.userId, { db, now: this.clock.now() }))?.status ??
      "unverified"
    );
  }

  /**
   * GET /me (PRD 2.2, AC F02-1): profil lengkap, status akun/keanggotaan, penunjuk iuran terbuka untuk perutean
   * Biaya KTA / Menunggu / Ditolak (AC F03-3, F04-2), jendela renewal (AC F07-5), label master historis (AC F10-4).
   */
  async me(auth: AuthContext, db: DbOrTx = this.db): Promise<Me> {
    const account = await this.loadAccount(auth.userId, db);
    if (!account) throw notFound("Profil tidak ditemukan.");
    const { user, profile } = account;
    // Berurutan: `db` dapat berupa transaksi (satu koneksi) saat membangun `current` untuk 409.
    const masters = await loadMemberMasters(db, user.id);
    const open = await this.openPayments(user.id, db);
    const status = await this.statusOf(auth, db);
    const now = this.clock.now();
    const renewal = renewalState(profile.expiresAt, status, now);
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
      renewal_eligible: renewal.eligible,
      renewal_opens_at: renewal.opensAt?.toISOString() ?? null,
      registration_payment: open.registration,
      renewal_payment: open.renewal,
      // Hanya pesan aman; alasan internal moderasi tidak pernah dikirim ke anggota (PRD 2.2).
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
        profession: masters.profession,
        skills: masters.skills,
        avatar_file_id: profile.avatarFileId,
        avatar_url: await this.ownAvatarUrl(auth, status, profile.avatarFileId, db),
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
   * PATCH /me/profile (F-10, PRD 3.5, 6.4; AC F10-2, F10-4, F05-6, F15-4). Satu transaksi dengan baris alumni
   * terkunci: versi If-Match dibandingkan (409 VERSION_CONFLICT dengan `current` berbentuk Me), master baru wajib
   * aktif, keahlian diganti hapus-lalu-sisipkan, avatar wajib berkas `avatar` milik sendiri yang `ready` (422
   * FILE_INVALID; foto lama dibuang), lalu field yang berubah ditulis dengan version + 1. Identitas keanggotaan dan
   * kolom keanggotaan tidak pernah disentuh (ditolak di validasi body).
   */
  async updateProfile(auth: AuthContext, expectedVersion: number, input: ProfileUpdateInput): Promise<Me> {
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(alumni).where(eq(alumni.userId, auth.userId)).for("update");
      if (!locked) throw notFound("Profil tidak ditemukan.");
      if (locked.version !== expectedVersion) throw versionConflict(await this.me(auth, tx));
      const now = this.clock.now();

      const changes: Partial<typeof alumni.$inferInsert> = {};
      const setIfChanged = <K extends keyof AlumniRow>(key: K, value: AlumniRow[K] | undefined) => {
        if (value !== undefined && value !== locked[key]) (changes as Record<string, unknown>)[key] = value;
      };
      setIfChanged("city", input.city);
      setIfChanged("phone", input.phone);
      setIfChanged("bio", input.bio);
      setIfChanged("lastEducationInstitution", input.last_education_institution);
      setIfChanged("lastEducationCity", input.last_education_city);
      setIfChanged("socialInstagram", input.social_instagram);
      setIfChanged("socialX", input.social_x);
      setIfChanged("socialFacebook", input.social_facebook);
      setIfChanged("socialLinkedin", input.social_linkedin);
      if (input.privacy) {
        setIfChanged("showInDirectory", input.privacy.show_in_directory);
        setIfChanged("showPhone", input.privacy.show_phone);
        setIfChanged("showEmail", input.privacy.show_email);
        setIfChanged("showSocial", input.privacy.show_social);
      }

      const professionChanged = await replaceProfession(tx, auth.userId, input.profession_id, now);
      const skillsChanged = await replaceSkills(tx, auth.userId, input.skill_ids, now);
      const avatarChanged = await this.replaceAvatar(
        tx,
        auth.userId,
        locked.avatarFileId,
        input.avatar_file_id,
      );
      if (avatarChanged) changes.avatarFileId = input.avatar_file_id ?? null;

      if (Object.keys(changes).length === 0 && !professionChanged && !skillsChanged) return;
      const [updated] = await tx
        .update(alumni)
        .set({ ...changes, version: sql`${alumni.version} + 1`, updatedAt: now })
        .where(and(eq(alumni.userId, auth.userId), eq(alumni.version, expectedVersion)))
        .returning({ version: alumni.version });
      if (!updated) throw versionConflict(await this.me(auth, tx));
    });
    return this.me(auth);
  }

  /**
   * Avatar baru: berkas milik pemanggil, purpose avatar, `ready`, belum pernah dilampirkan; selain itu 422 FILE_INVALID
   * tanpa membedakan berkas milik orang lain dari berkas yang tidak ada (N-09). Foto lama dibuang (status deleted,
   * objek dihapus setelah commit). Mengembalikan true bila kolom avatar berubah.
   */
  private async replaceAvatar(
    tx: Tx,
    userId: string,
    currentId: string | null,
    nextId: string | null | undefined,
  ): Promise<boolean> {
    if (nextId === undefined || nextId === currentId) return false;
    if (nextId !== null) {
      try {
        await this.files.attach(tx, nextId, userId, "avatar", { field: "avatar_file_id" });
      } catch (error) {
        if (error instanceof AppException && error.code === "VALIDATION_ERROR")
          throw new AppException(
            422,
            "FILE_INVALID",
            "Foto profil tidak valid atau sudah dipakai. Unggah ulang foto lalu simpan kembali.",
          );
        throw error;
      }
    }
    if (currentId) await this.files.discard(tx, currentId);
    return true;
  }

  /**
   * GET /me/membership (F-07, AC F07-1..F07-5): status dari timestamp saat request, jendela renewal 30 hari sebelum
   * habis dan tetap terbuka setelah expired, histori periode activation/renewal terbaru lebih dulu.
   */
  async membershipOf(auth: AuthContext): Promise<Membership> {
    const account = await this.loadAccount(auth.userId);
    if (!account) throw notFound("Profil tidak ditemukan.");
    const { user, profile } = account;
    const status = await this.statusOf(auth);
    const open = await this.openPayments(user.id);
    const periods = await this.periodsOf(user.id);
    const renewal = renewalState(profile.expiresAt, status, this.clock.now());
    return {
      effective_status: status,
      member_number: profile.memberNumber,
      // Nomor dialokasikan dan KTA Tidak Aktif dibuat saat OTP pendaftaran terverifikasi (AC F01-2, F05-1).
      card_issued_at: profile.memberNumber ? (user.emailVerifiedAt?.toISOString() ?? null) : null,
      starts_at: profile.startsAt?.toISOString() ?? null,
      expires_at: profile.expiresAt?.toISOString() ?? null,
      renewal_eligible: renewal.eligible,
      renewal_opens_at: renewal.opensAt?.toISOString() ?? null,
      renewal_payment: open.renewal,
      periods,
    };
  }

  /** Periode activation/renewal (satu per payment paid, PRD 6.4), terbaru lebih dulu. */
  async periodsOf(userId: string, db: DbOrTx = this.db): Promise<MembershipPeriod[]> {
    const rows = await db
      .select({
        kind: membershipEvents.kind,
        startsAt: membershipEvents.afterStartsAt,
        expiresAt: membershipEvents.afterExpiresAt,
        createdAt: membershipEvents.createdAt,
        paymentId: membershipEvents.paymentId,
        decidedAt: payments.decidedAt,
      })
      .from(membershipEvents)
      .leftJoin(payments, eq(payments.id, membershipEvents.paymentId))
      .where(
        and(eq(membershipEvents.userId, userId), inArray(membershipEvents.kind, ["activation", "renewal"])),
      )
      .orderBy(desc(membershipEvents.createdAt), desc(membershipEvents.id));
    return rows
      .filter((row) => row.startsAt && row.expiresAt)
      .map((row) => ({
        kind: row.kind as "activation" | "renewal",
        starts_at: row.startsAt!.toISOString(),
        expires_at: row.expiresAt!.toISOString(),
        // Waktu persetujuan pengurus = decided_at payment; histori dibuat pada transaksi persetujuan yang sama.
        approved_at: (row.decidedAt ?? row.createdAt).toISOString(),
        payment_id: row.paymentId,
      }));
  }
}
