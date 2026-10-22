import { Inject, Injectable } from "@nestjs/common";
import type { components, Permission } from "@kapdh/contracts";
import {
  admins,
  alumni,
  alumniSkills,
  events,
  files,
  membershipEvents,
  payments,
  reports,
  tickets,
  users,
} from "@kapdh/database";
import {
  type AnyColumn,
  and,
  count,
  desc,
  eq,
  exists,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  ne,
  not,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db, DbOrTx, Tx } from "../../core/db/types.js";
import { AppException, forbidden, notFound, versionConflict } from "../../core/errors/app-exception.js";
import { FilesService } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { type AccountStatus, effectiveStatus } from "../../core/membership/effective-status.js";
import { academicYears, cohortCode, educationStatus } from "../../core/membership/member-number.js";
import { DEFAULT_UNSUSPEND_MESSAGE, MembershipKernel } from "../../core/membership/membership.kernel.js";
import { decodeCursor, encodeCursor, parsePageQuery } from "../../core/pagination/cursor.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { queryBool, queryInt, validateQuery } from "../../core/validation/validate.js";
import { closeAppealsAsGranted, lockActiveAppeals } from "./appeals.js";
import { fileSubjectOf, MemberProfileService } from "./member-profile.service.js";
import { escapeLike, renewalState } from "./membership-view.js";
import { assertGraduationYears, type AdminMemberUpdateInput } from "./profile-input.js";
import {
  applyLegacyInput,
  hasProfession,
  legacyEducationCity,
  loadProfileLists,
  markListWriter,
  primaryProfessionLabel,
  projectLegacyColumns,
  replaceEducation,
  replaceProfessions,
  replaceSocialLinks,
} from "./profile-lists.js";
import { loadMemberMasters, loadProfessionEntries, replaceSkills } from "./profile-masters.js";

type AdminMemberDetail = components["schemas"]["AdminMemberDetail"];
type AdminMemberPage = components["schemas"]["AdminMemberPage"];
type AdminMemberSummary = components["schemas"]["AdminMemberSummary"];
type AdminMemberSort = components["schemas"]["AdminMemberSort"];
type AdminMembershipEventPage = components["schemas"]["AdminMembershipEventPage"];
type AdminMembershipEventKind = components["schemas"]["AdminMembershipEventKind"];
type EffectiveStatusValue = components["schemas"]["EffectiveStatus"];
type AlumniRow = typeof alumni.$inferSelect;
type UserRow = typeof users.$inferSelect;

const DAY_MS = 24 * 3600_000;
const EXPIRING_WINDOW_MS = 30 * DAY_MS;

const MEMBER_SORTS = [
  "registered_desc",
  "registered_asc",
  "name_asc",
  "name_desc",
  "cohort_asc",
  "cohort_desc",
  "member_number_asc",
  "expires_at_asc",
  "expires_at_desc",
] as const satisfies readonly AdminMemberSort[];

const EFFECTIVE_STATUSES = [
  "pending_otp",
  "unverified",
  "verified",
  "expiring",
  "expired",
  "suspended",
  "disabled",
  "deletion_pending",
] as const satisfies readonly EffectiveStatusValue[];

const EVENT_KINDS = [
  "activation",
  "renewal",
  "suspend",
  "unsuspend",
  "number_correction",
  "warn",
] as const satisfies readonly AdminMembershipEventKind[];

const uuidQuery = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Format id tidak valid")
  .transform((value) => value.toLowerCase());

/** Parameter daftar anggota (kontrak adminListMembers). */
const listQuerySchema = z.object({
  q: z.string().trim().min(1, "Minimal 1 karakter").max(100, "Maksimal 100 karakter").optional(),
  cohort: queryInt({ min: 1, max: 99 }).optional(),
  effective_status: z.enum(EFFECTIVE_STATUSES, { message: "Status tidak dikenal" }).optional(),
  city: z.string().trim().min(1, "Minimal 1 karakter").max(80, "Maksimal 80 karakter").optional(),
  gender: z.enum(["male", "female"], { message: "Jenis kelamin tidak valid" }).optional(),
  profession_id: uuidQuery.optional(),
  skill_id: uuidQuery.optional(),
  has_linked_admin: queryBool().optional(),
  sort: z.enum(MEMBER_SORTS, { message: "Urutan tidak dikenal" }).optional(),
});
type ListQuery = z.infer<typeof listQuerySchema>;

const eventsQuerySchema = z.object({
  kind: z.enum(EVENT_KINDS, { message: "Jenis histori tidak dikenal" }).optional(),
});

/** Nilai kunci keyset di cursor: string/angka/boolean/null (Date disimpan ISO). */
const cursorValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

type KeyType = "timestamp" | "text" | "int" | "uuid";

/** Satu kolom urutan keyset; `nullable` memakai NULLS LAST pada kedua arah (kontrak AdminMemberSort). */
interface SortKey<Row> {
  expr: SQL | AnyColumn;
  dir: "asc" | "desc";
  type: KeyType;
  nullable: boolean;
  read: (row: Row) => string | number | null;
}

function param(value: string | number, type: KeyType): SQL {
  switch (type) {
    case "timestamp":
      return sql`${value}::timestamptz`;
    case "uuid":
      return sql`${value}::uuid`;
    case "int":
      return sql`${value}::bigint`;
    case "text":
      return sql`${value}::text`;
  }
}

/**
 * Predikat keyset "sesudah posisi cursor" untuk urutan multi-kolom berarah campuran dengan NULLS LAST:
 * OR_i (AND_{j<i} k_j = v_j) AND k_i > v_i, dengan nilai null diperlakukan setelah semua nilai bukan null.
 */
function keysetAfterNullable<Row>(
  keys: readonly SortKey<Row>[],
  values: readonly (string | number | null)[],
): SQL {
  const equal = (key: SortKey<Row>, value: string | number | null): SQL =>
    value === null ? sql`${key.expr} is null` : sql`${key.expr} = ${param(value, key.type)}`;
  const after = (key: SortKey<Row>, value: string | number | null): SQL | null => {
    if (value === null) return null; // NULLS LAST: tidak ada nilai sesudah null.
    const step =
      key.dir === "asc"
        ? sql`${key.expr} > ${param(value, key.type)}`
        : sql`${key.expr} < ${param(value, key.type)}`;
    return key.nullable ? sql`(${step} or ${key.expr} is null)` : step;
  };
  const branches: SQL[] = [];
  keys.forEach((key, index) => {
    const step = after(key, values[index] ?? null);
    if (!step) return;
    const prefix = keys.slice(0, index).map((prev, j) => equal(prev, values[j] ?? null));
    branches.push(and(...prefix, step)!);
  });
  return branches.length === 0 ? sql`false` : or(...branches)!;
}

function orderOf<Row>(keys: readonly SortKey<Row>[]): SQL[] {
  return keys.map((key) =>
    key.nullable ? sql`${key.expr} ${sql.raw(key.dir)} nulls last` : sql`${key.expr} ${sql.raw(key.dir)}`,
  );
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

/** Ringkasan filter untuk mengikat cursor pada kombinasi filter+sort yang sama (kontrak adminListMembers). */
function filterFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 16);
}

interface ListRow {
  userId: string;
  email: string;
  accountStatus: string;
  registeredAt: Date;
  fullName: string;
  nameKey: string;
  gender: "male" | "female";
  cohort: number;
  memberNumber: string | null;
  memberPrefix: string | null;
  memberSeq: number | null;
  city: string | null;
  expiresAt: Date | null;
  suspendedAt: Date | null;
  professionLabel: string | null;
  hasLinkedAdmin: boolean;
  avatarFileId: string | null;
  avatarPurpose: string | null;
  avatarVisibility: string | null;
  avatarStatus: string | null;
}

const NAME_KEY = sql<string>`lower(${alumni.fullName})`;
const MEMBER_PREFIX = sql<string | null>`left(${alumni.memberNumber}, 8)`;
/**
 * Kunci waktu keyset dipotong ke milidetik (presisi cursor/Date JS) sehingga baris yang ditulis dengan default now()
 * berpresisi mikrodetik tetap tidak terduplikasi/terlewat; seri dalam milidetik yang sama diurai user_id.
 */
const REGISTERED_KEY = sql`date_trunc('milliseconds', ${users.createdAt})`;
const EXPIRES_KEY = sql`date_trunc('milliseconds', ${alumni.expiresAt})`;
const EVENT_TIME_KEY = sql`date_trunc('milliseconds', ${membershipEvents.createdAt})`;

function sortKeys(sort: AdminMemberSort): SortKey<ListRow>[] {
  const id = (dir: "asc" | "desc"): SortKey<ListRow> => ({
    expr: users.id,
    dir,
    type: "uuid",
    nullable: false,
    read: (r) => r.userId,
  });
  switch (sort) {
    case "registered_desc":
    case "registered_asc": {
      const dir = sort === "registered_desc" ? "desc" : "asc";
      return [
        { expr: REGISTERED_KEY, dir, type: "timestamp", nullable: false, read: (r) => iso(r.registeredAt) },
        id(dir),
      ];
    }
    case "name_asc":
    case "name_desc": {
      const dir = sort === "name_asc" ? "asc" : "desc";
      return [{ expr: NAME_KEY, dir, type: "text", nullable: false, read: (r) => r.nameKey }, id(dir)];
    }
    case "cohort_asc":
    case "cohort_desc": {
      const dir = sort === "cohort_asc" ? "asc" : "desc";
      return [{ expr: alumni.cohort, dir, type: "int", nullable: false, read: (r) => r.cohort }, id(dir)];
    }
    case "member_number_asc":
      // Prefix AA.SS.JK lalu N numerik (bukan urutan teks "10" < "7"); belum bernomor (pending_otp) di akhir.
      return [
        { expr: MEMBER_PREFIX, dir: "asc", type: "text", nullable: true, read: (r) => r.memberPrefix },
        { expr: alumni.memberSeq, dir: "asc", type: "int", nullable: true, read: (r) => r.memberSeq },
        id("asc"),
      ];
    case "expires_at_asc":
    case "expires_at_desc": {
      const dir = sort === "expires_at_asc" ? "asc" : "desc";
      // expires_at null (belum paid) diletakkan di akhir pada kedua arah (kontrak AdminMemberSort).
      return [
        { expr: EXPIRES_KEY, dir, type: "timestamp", nullable: true, read: (r) => iso(r.expiresAt) },
        id(dir),
      ];
    }
  }
}

/**
 * Predikat SQL effective_status pada waktu `now` (PRD 4.2; sama dengan core effectiveStatus): status akun lebih
 * dulu, lalu suspend, lalu periode dari timestamp (AC F07-3, tidak menunggu worker).
 */
function effectiveStatusPredicate(status: EffectiveStatusValue, now: Date): SQL {
  const active = and(eq(users.status, "active"), isNull(alumni.suspendedAt))!;
  const expiringEdge = new Date(now.getTime() + EXPIRING_WINDOW_MS);
  switch (status) {
    case "pending_otp":
      return eq(users.status, "pending_otp");
    case "disabled":
      return eq(users.status, "disabled");
    case "deletion_pending":
      return eq(users.status, "deletion_pending");
    case "suspended":
      return and(eq(users.status, "active"), isNotNull(alumni.suspendedAt))!;
    case "unverified":
      return and(active, isNull(alumni.expiresAt))!;
    case "expired":
      return and(active, isNotNull(alumni.expiresAt), lte(alumni.expiresAt, now))!;
    case "expiring":
      return and(active, gt(alumni.expiresAt, now), lte(alumni.expiresAt, expiringEdge))!;
    case "verified":
      return and(active, gt(alumni.expiresAt, expiringEdge))!;
  }
}

/**
 * Field kontak/PII dan isian bebas profil yang hanya dicatat namanya pada audit, tanpa nilai (audit bukan salinan
 * payload, F-17).
 */
const CONTACT_FIELDS = new Set([
  "professions",
  "education",
  "social_links",
  "city",
  "phone",
  "bio",
  "last_education_institution",
  "last_education_city",
  "social_instagram",
  "social_x",
  "social_facebook",
  "social_linkedin",
]);

interface LockedMember {
  user: Pick<UserRow, "id" | "status" | "kind">;
  profile: AlumniRow;
}

/**
 * Anggota untuk pengurus (F-15, F-16; kontrak admin-members.yaml): daftar dengan filter/urutan/paging server, detail
 * administratif yang disaring per izin, koreksi identitas lewat MembershipKernel (AC F05-6), suspend/unsuspend
 * (AC F12-3..F12-5) dan histori keanggotaan. Konflik kepentingan (PRD 2.3): pengurus tidak dapat mengubah akun alumni
 * yang tertaut ke identitas adminnya sendiri.
 */
@Injectable()
export class AdminMembersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly kernel: MembershipKernel,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly profiles: MemberProfileService,
  ) {}

  // -------------------------------------------------------------------------------------------------- daftar

  /** GET /admin/members (F-15, guideline hal. 16, AC F10-1): filter, urutan, paging keyset dan total dari server. */
  async list(auth: AuthContext, query: unknown): Promise<AdminMemberPage> {
    const filters = validateQuery(listQuerySchema, query);
    const page = parsePageQuery(query);
    const sort: AdminMemberSort = filters.sort ?? "registered_desc";
    const keys = sortKeys(sort);
    const fingerprint = filterFingerprint({ ...filters, sort, cursor: undefined });
    const now = this.clock.now();

    let after: SQL | undefined;
    if (page.cursor) {
      const decoded = decodeCursor(
        page.cursor,
        z.object({ f: z.string(), s: z.string(), k: z.array(cursorValue) }),
      );
      // Cursor dari kombinasi filter/urutan lain ditolak (kontrak: 400 VALIDATION_ERROR).
      if (decoded.f !== fingerprint || decoded.s !== sort || decoded.k.length !== keys.length)
        throw new AppException(400, "VALIDATION_ERROR", "Parameter pencarian tidak valid.", {
          fieldErrors: {
            cursor: ["Cursor tidak cocok dengan filter atau urutan. Muat ulang daftar dari awal."],
          },
        });
      const values = decoded.k.map((value, index) => {
        const key = keys[index]!;
        if (value === null && key.nullable) return null;
        if (key.type === "int" && typeof value === "number" && Number.isSafeInteger(value)) return value;
        if (key.type !== "int" && typeof value === "string" && value.length <= 300) {
          if (key.type === "timestamp" && Number.isNaN(Date.parse(value))) return undefined;
          if (key.type === "uuid" && !/^[0-9a-f-]{36}$/i.test(value)) return undefined;
          return value;
        }
        return undefined;
      });
      if (values.some((value) => value === undefined))
        throw new AppException(400, "VALIDATION_ERROR", "Parameter pencarian tidak valid.", {
          fieldErrors: { cursor: ["Cursor tidak valid. Muat ulang daftar dari awal."] },
        });
      after = keysetAfterNullable(keys, values as (string | number | null)[]);
    }

    const where = and(...this.listConditions(filters, now));
    const rows = (await this.db
      .select({
        userId: users.id,
        email: users.email,
        accountStatus: users.status,
        registeredAt: users.createdAt,
        fullName: alumni.fullName,
        nameKey: NAME_KEY,
        gender: alumni.gender,
        cohort: alumni.cohort,
        memberNumber: alumni.memberNumber,
        memberPrefix: MEMBER_PREFIX,
        memberSeq: alumni.memberSeq,
        city: alumni.city,
        expiresAt: alumni.expiresAt,
        suspendedAt: alumni.suspendedAt,
        professionLabel: primaryProfessionLabel(users.id),
        hasLinkedAdmin: sql<boolean>`exists (select 1 from ${admins} where ${admins.linkedAlumniUserId} = ${users.id})`,
        avatarFileId: files.id,
        avatarPurpose: files.purpose,
        avatarVisibility: files.visibility,
        avatarStatus: files.status,
      })
      .from(users)
      .innerJoin(alumni, eq(alumni.userId, users.id))
      .leftJoin(files, eq(files.id, alumni.avatarFileId))
      .where(after ? and(where, after) : where)
      .orderBy(...orderOf(keys))
      .limit(page.limit + 1)) as ListRow[];
    const [totalRow] = await this.db
      .select({ value: count() })
      .from(users)
      .innerJoin(alumni, eq(alumni.userId, users.id))
      .where(where);

    const hasMore = rows.length > page.limit;
    const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
    const items: AdminMemberSummary[] = [];
    for (const row of pageRows) items.push(await this.summaryOf(auth, row, now));
    const last = pageRows[pageRows.length - 1];
    return {
      items,
      next_cursor:
        hasMore && last
          ? encodeCursor({ f: fingerprint, s: sort, k: keys.map((key) => key.read(last)) })
          : null,
      total: Number(totalRow?.value ?? 0),
    };
  }

  private listConditions(filters: ListQuery, now: Date): SQL[] {
    // Akun alumni pending_otp sampai deletion_pending; akun terhapus tidak tampil (kontrak adminListMembers).
    const conditions: SQL[] = [eq(users.kind, "alumni"), ne(users.status, "deleted")];
    if (filters.q) {
      const escaped = escapeLike(filters.q);
      conditions.push(
        or(
          ilike(alumni.fullName, `%${escaped}%`),
          ilike(users.email, `%${escaped}%`),
          ilike(alumni.memberNumber, `${escaped}%`),
          ilike(alumni.city, `%${escaped}%`),
        )!,
      );
    }
    if (filters.cohort !== undefined) conditions.push(eq(alumni.cohort, filters.cohort));
    if (filters.effective_status) conditions.push(effectiveStatusPredicate(filters.effective_status, now));
    if (filters.city) conditions.push(sql`lower(${alumni.city}) = lower(${filters.city})`);
    if (filters.gender) conditions.push(eq(alumni.gender, filters.gender));
    // Profesi boleh lebih dari satu: cocok bila salah satunya tertaut master ini (master nonaktif juga).
    if (filters.profession_id) conditions.push(hasProfession(this.db, users.id, filters.profession_id));
    if (filters.skill_id)
      conditions.push(
        exists(
          this.db
            .select({ one: sql`1` })
            .from(alumniSkills)
            .where(and(eq(alumniSkills.alumniUserId, users.id), eq(alumniSkills.skillId, filters.skill_id))),
        ),
      );
    if (filters.has_linked_admin !== undefined) {
      const linked = exists(
        this.db
          .select({ one: sql`1` })
          .from(admins)
          .where(eq(admins.linkedAlumniUserId, users.id)),
      );
      conditions.push(filters.has_linked_admin ? linked : not(linked));
    }
    return conditions;
  }

  private async summaryOf(auth: AuthContext, row: ListRow, now: Date): Promise<AdminMemberSummary> {
    const status = effectiveStatus(
      {
        accountStatus: row.accountStatus as AccountStatus,
        expiresAt: row.expiresAt,
        suspendedAt: row.suspendedAt,
      },
      now,
    );
    const avatarReady = row.avatarFileId && row.avatarStatus === "ready" && row.avatarPurpose === "avatar";
    const avatarUrl = avatarReady
      ? (
          await this.files.signedUrl(
            { id: row.avatarFileId!, purpose: "avatar", visibility: row.avatarVisibility ?? "private" },
            fileSubjectOf(auth),
          )
        ).url
      : null;
    return {
      user_id: row.userId,
      full_name: row.fullName,
      email: row.email,
      gender: row.gender,
      cohort: row.cohort,
      cohort_code: cohortCode(row.cohort),
      member_number: row.memberNumber,
      city: row.city,
      avatar_url: avatarUrl,
      profession_label: row.professionLabel,
      account_status: row.accountStatus as AdminMemberSummary["account_status"],
      effective_status: status,
      expires_at: iso(row.expiresAt),
      has_linked_admin: row.hasLinkedAdmin === true,
      registered_at: row.registeredAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------------------------------- detail

  /**
   * GET /admin/members/{userId}: detail administratif (kontak terlepas dari flag privasi, F-10) disaring per izin
   * pemanggil (PRD 2.3, AC F15-1); setiap pembukaan dicatat audit `member.viewed` tanpa salinan data.
   */
  async view(auth: AuthContext, userId: string): Promise<AdminMemberDetail> {
    const detail = await this.detail(auth, userId);
    await this.audit.write(this.db, { action: "member.viewed", entityType: "alumni", entityId: userId });
    return detail;
  }

  /**
   * AdminMemberDetail untuk pemanggil (juga `current` pada 409): tanpa payments.read → recent_payments null; tanpa
   * events.manage DAN payments.read → recent_tickets null; tanpa moderation.read → moderation null dan alasan suspend
   * disembunyikan (`reason_redacted`). Akun bukan alumni atau sudah terhapus → 404.
   */
  async detail(auth: AuthContext, userId: string, db: DbOrTx = this.db): Promise<AdminMemberDetail> {
    const [row] = await db
      .select({
        user: users,
        profile: alumni,
        suspendedByName: admins.displayName,
      })
      .from(users)
      .innerJoin(alumni, eq(alumni.userId, users.id))
      .leftJoin(admins, eq(admins.id, alumni.suspendedByAdminId))
      .where(and(eq(users.id, userId), eq(users.kind, "alumni"), ne(users.status, "deleted")))
      .limit(1);
    if (!row) throw notFound("Anggota tidak ditemukan.");
    const { user, profile } = row;
    const now = this.clock.now();
    const can = (permission: Permission) => auth.permissions.has(permission);
    const status = effectiveStatus(
      {
        accountStatus: user.status as AccountStatus,
        expiresAt: profile.expiresAt,
        suspendedAt: profile.suspendedAt,
      },
      now,
    );
    const masters = await loadMemberMasters(db, userId);
    const lists = await loadProfileLists(db, userId);
    // Penanda master per profesi (AC F10-4): setiap profesi bertaut master nonaktif, bukan hanya `profession`.
    const professionEntries = await loadProfessionEntries(db, userId, lists.professions);
    const [linked] = await db
      .select({
        adminId: admins.id,
        displayName: admins.displayName,
        role: admins.role,
        status: admins.status,
      })
      .from(admins)
      .where(eq(admins.linkedAlumniUserId, userId))
      .limit(1);
    const periods = await this.profiles.periodsOf(userId, db);
    const avatarUrl = await this.profiles.avatarUrl(profile.avatarFileId, fileSubjectOf(auth), db);
    const years = academicYears(profile.cohort, profile.classIn, profile.classOut);
    const renewal = renewalState(profile.expiresAt, status, now);
    const moderationRead = can("moderation.read");

    return {
      user_id: user.id,
      full_name: profile.fullName,
      email: user.email,
      gender: profile.gender,
      cohort: profile.cohort,
      cohort_code: cohortCode(profile.cohort),
      member_number: profile.memberNumber,
      city: profile.city,
      avatar_url: avatarUrl,
      profession_label: lists.professions[0] ?? null,
      account_status: user.status,
      effective_status: status,
      expires_at: iso(profile.expiresAt),
      has_linked_admin: linked !== undefined,
      registered_at: user.createdAt.toISOString(),
      class_in: profile.classIn,
      class_out: profile.classOut,
      education_status: educationStatus(profile.classIn, profile.classOut),
      entry_year: years.entryYear,
      exit_year: years.exitYear,
      graduation_year: years.graduationYear,
      phone: profile.phone,
      bio: profile.bio,
      last_education_institution: profile.lastEducationInstitution,
      last_education_city: profile.lastEducationCity,
      social_instagram: profile.socialInstagram,
      social_x: profile.socialX,
      social_facebook: profile.socialFacebook,
      social_linkedin: profile.socialLinkedin,
      privacy: {
        show_in_directory: profile.showInDirectory,
        show_phone: profile.showPhone,
        show_email: profile.showEmail,
        show_social: profile.showSocial,
      },
      profession: masters.profession,
      professions: lists.professions,
      profession_entries: professionEntries,
      education: lists.education,
      social_links: lists.social_links,
      skills: masters.skills,
      avatar_file_id: profile.avatarFileId,
      email_verified_at: iso(user.emailVerifiedAt),
      last_login_at: iso(user.lastLoginAt),
      starts_at: iso(profile.startsAt),
      renewal_opens_at: iso(renewal.opensAt),
      suspension: profile.suspendedAt
        ? {
            suspended_at: profile.suspendedAt.toISOString(),
            reason: moderationRead ? profile.suspensionReason : null,
            reason_redacted: !moderationRead,
            member_message: profile.suspensionMessage,
            suspended_by:
              profile.suspendedByAdminId && row.suspendedByName
                ? { admin_id: profile.suspendedByAdminId, display_name: row.suspendedByName }
                : null,
          }
        : null,
      linked_admin: linked
        ? {
            admin_id: linked.adminId,
            display_name: linked.displayName,
            role: linked.role,
            status: linked.status,
          }
        : null,
      periods,
      recent_payments: can("payments.read") ? await this.recentPayments(db, userId) : null,
      recent_tickets:
        can("events.manage") || can("payments.read") ? await this.recentTickets(db, userId) : null,
      moderation: moderationRead ? await this.moderationSummary(db, auth, userId) : null,
      version: String(profile.version),
    };
  }

  private async recentPayments(db: DbOrTx, userId: string): Promise<AdminMemberDetail["recent_payments"]> {
    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.userId, userId))
      .orderBy(desc(payments.createdAt), desc(payments.id))
      .limit(10);
    // Tanpa bukti/metode/rekening: bukti hanya di /admin/payments/{paymentId} (payments.read).
    return rows.map((p) => ({
      id: p.id,
      type: p.type,
      status: p.status,
      amount: p.amount,
      proof_version: p.proofVersion,
      created_at: p.createdAt.toISOString(),
      submitted_at: iso(p.submittedAt),
      decided_at: iso(p.decidedAt),
    }));
  }

  private async recentTickets(db: DbOrTx, userId: string): Promise<AdminMemberDetail["recent_tickets"]> {
    const rows = await db
      .select({
        id: tickets.id,
        eventId: tickets.eventId,
        eventTitle: events.title,
        eventStartsAt: events.startsAt,
        status: tickets.status,
        total: tickets.totalSnapshot,
        checkedInAt: tickets.checkedInAt,
        createdAt: tickets.createdAt,
      })
      .from(tickets)
      .innerJoin(events, eq(events.id, tickets.eventId))
      .where(eq(tickets.userId, userId))
      .orderBy(desc(tickets.createdAt), desc(tickets.id))
      .limit(10);
    return rows.map((t) => ({
      id: t.id,
      event_id: t.eventId,
      event_title: t.eventTitle,
      event_starts_at: t.eventStartsAt.toISOString(),
      status: t.status,
      total: t.total,
      checked_in_at: iso(t.checkedInAt),
      created_at: t.createdAt.toISOString(),
    }));
  }

  /**
   * Ringkasan moderasi (F-12) tanpa bukti. Hitungan laporan memakai aturan visibilitas konflik kepentingan C6 butir a/c:
   * laporan terhadap akun alumni tertaut pemanggil tidak pernah terlihat olehnya, sehingga hitungannya 0 saat pemanggil
   * membuka akun tertautnya sendiri (tidak dapat dibandingkan dengan antrean untuk menyimpulkan laporan tersembunyi).
   * Banding (kategori appeal) bukan laporan terhadap anggota.
   */
  private async moderationSummary(
    db: DbOrTx,
    auth: AuthContext,
    userId: string,
  ): Promise<AdminMemberDetail["moderation"]> {
    let open = 0;
    let total = 0;
    if (auth.linkedAlumniUserId !== userId) {
      const [counts] = await db
        .select({
          open: sql<number>`count(*) filter (where ${reports.status} in ('open', 'in_review'))`.mapWith(
            Number,
          ),
          total: count(),
        })
        .from(reports)
        .where(and(eq(reports.targetUserId, userId), sql`${reports.category}::text <> 'appeal'`));
      open = counts?.open ?? 0;
      total = Number(counts?.total ?? 0);
    }
    const [warnings] = await db
      .select({ value: count() })
      .from(membershipEvents)
      .where(and(eq(membershipEvents.userId, userId), eq(membershipEvents.kind, "warn")));
    const [last] = await db
      .select({ at: max(membershipEvents.createdAt) })
      .from(membershipEvents)
      .where(
        and(
          eq(membershipEvents.userId, userId),
          inArray(membershipEvents.kind, ["warn", "suspend", "unsuspend"]),
        ),
      );
    return {
      open_report_count: open,
      total_report_count: total,
      warning_count: Number(warnings?.value ?? 0),
      last_action_at: last?.at ? new Date(last.at).toISOString() : null,
    };
  }

  // ------------------------------------------------------------------------------------------------ perubahan

  /**
   * Mengunci akun dengan URUTAN KUNCI kernel (users FOR NO KEY UPDATE → alumni FOR UPDATE) lalu memeriksa keberadaan
   * (404), konflik kepentingan (403, PRD 2.3) dan If-Match (409 dengan `current` AdminMemberDetail tersaring).
   */
  private async lockForAdmin(
    tx: Tx,
    auth: AuthContext,
    userId: string,
    expectedVersion: number,
  ): Promise<LockedMember> {
    const [user] = await tx
      .select({ id: users.id, status: users.status, kind: users.kind })
      .from(users)
      .where(eq(users.id, userId))
      .for("no key update");
    if (!user || user.kind !== "alumni" || user.status === "deleted")
      throw notFound("Anggota tidak ditemukan.");
    const [profile] = await tx.select().from(alumni).where(eq(alumni.userId, userId)).for("update");
    if (!profile) throw notFound("Anggota tidak ditemukan.");
    if (auth.linkedAlumniUserId === userId)
      throw forbidden(
        "Akun alumni yang tertaut ke akun admin Anda harus ditangani pengurus lain (konflik kepentingan).",
      );
    if (profile.version !== expectedVersion) throw versionConflict(await this.detail(auth, userId, tx));
    return { user, profile };
  }

  /**
   * PATCH /admin/members/{userId} (PRD 2.3, 3.5; AC F05-6, F10-4, F15-4, F17-1). Satu transaksi: koreksi identitas
   * angkatan/kelas/jenis kelamin lewat MembershipKernel.correctIdentity (prefix dihitung ulang, N tetap, histori
   * number_correction, audit member.number_corrected, notifikasi /kta; QR lama menjadi "perlu diperbarui"), lalu field
   * administratif lain dengan audit `member.updated` beralasan. Nomor anggota tidak pernah diterima dari klien.
   */
  async update(
    auth: AuthContext,
    userId: string,
    expectedVersion: number,
    input: AdminMemberUpdateInput,
  ): Promise<AdminMemberDetail> {
    assertGraduationYears(input.education, this.clock.now());
    await this.db.transaction(async (tx) => {
      const { user, profile } = await this.lockForAdmin(tx, auth, userId, expectedVersion);
      if (user.status === "deletion_pending")
        throw new AppException(
          400,
          "VALIDATION_ERROR",
          "Akun sedang dalam proses penghapusan dan tidak dapat diubah.",
          {
            fieldErrors: { _: ["Akun sedang dalam proses penghapusan dan tidak dapat diubah."] },
          },
        );
      const now = this.clock.now();
      const reason = input.reason;

      if (
        input.cohort !== undefined ||
        input.class_in !== undefined ||
        input.class_out !== undefined ||
        input.gender !== undefined
      )
        await this.kernel.correctIdentity(
          tx,
          userId,
          { cohort: input.cohort, classIn: input.class_in, classOut: input.class_out, gender: input.gender },
          { adminId: auth.adminId },
          reason,
          { expectedVersion },
        );

      const changes: Partial<typeof alumni.$inferInsert> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const changedContactFields: string[] = [];
      const track = <K extends keyof AlumniRow>(field: string, key: K, value: AlumniRow[K] | undefined) => {
        if (value === undefined || value === profile[key]) return;
        (changes as Record<string, unknown>)[key] = value;
        if (CONTACT_FIELDS.has(field)) changedContactFields.push(field);
        else {
          before[field] = profile[key];
          after[field] = value;
        }
      };
      track("full_name", "fullName", input.full_name);
      track("city", "city", input.city);
      track("phone", "phone", input.phone);
      track("bio", "bio", input.bio);

      // Daftar profil berulang (sumber kebenaran) lalu proyeksi ke kolom lama; field lama diterapkan ke entri padanannya.
      const mastersBefore = await loadMemberMasters(tx, userId);
      await markListWriter(tx);
      const legacyChanged = await applyLegacyInput(tx, userId, input, profile);
      const listChanges = [
        ...legacyChanged.filter((field) => field !== "profession_id"),
        ...((await replaceProfessions(tx, userId, input.professions, now)) ? ["professions"] : []),
        ...((await replaceEducation(tx, userId, input.education, now)) ? ["education"] : []),
        ...((await replaceSocialLinks(tx, userId, input.social_links, now)) ? ["social_links"] : []),
      ];
      const listsChanged = legacyChanged.length > 0 || listChanges.length > 0;
      if (listsChanged) await projectLegacyColumns(tx, userId);
      changedContactFields.push(...listChanges);
      if (legacyChanged.includes("profession_id")) {
        before.profession_id = mastersBefore.profession?.id ?? null;
        after.profession_id = input.profession_id ?? null;
      }
      const legacyCity = legacyEducationCity(input, profile, listsChanged);
      if (legacyCity !== undefined) {
        changes.lastEducationCity = legacyCity;
        if (legacyCity !== profile.lastEducationCity) changedContactFields.push("last_education_city");
      }
      if (await replaceSkills(tx, userId, input.skill_ids, now)) {
        before.skill_ids = mastersBefore.skills.map((skill) => skill.id);
        after.skill_ids = input.skill_ids;
      }
      // Foto tidak pantas dihapus pengurus: kolom dikosongkan dan berkas dibuang (objek dihapus setelah commit).
      if (input.remove_avatar === true && profile.avatarFileId) {
        changes.avatarFileId = null;
        before.avatar_removed = false;
        after.avatar_removed = true;
        await this.files.discard(tx, profile.avatarFileId);
      }

      const anyChange =
        Object.keys(changes).length > 0 || Object.keys(after).length > 0 || changedContactFields.length > 0;
      if (!anyChange) return;
      await tx
        .update(alumni)
        .set({ ...changes, version: sql`${alumni.version} + 1`, updatedAt: now })
        .where(eq(alumni.userId, userId));
      await this.audit.write(tx, {
        action: "member.updated",
        entityType: "alumni",
        entityId: userId,
        reason,
        before,
        after: {
          ...after,
          ...(changedContactFields.length ? { changed_contact_fields: changedContactFields } : {}),
        },
      });
    });
    return this.detail(auth, userId);
  }

  /**
   * POST /admin/members/{userId}/suspend (PRD 4.2; AC F12-3, F12-4, F07-4): MembershipKernel.suspend dalam transaksi
   * yang sama dengan pemeriksaan If-Match (tanggal periode tidak diubah, sesi dicabut, socket diputus setelah commit,
   * audit member.suspended, notifikasi /restricted). Prasyarat gagal → 400 dengan keadaan terkini.
   */
  async suspend(
    auth: AuthContext,
    userId: string,
    expectedVersion: number,
    input: { reason: string; member_message: string },
  ): Promise<AdminMemberDetail> {
    await this.db.transaction(async (tx) => {
      await this.lockForAdmin(tx, auth, userId, expectedVersion);
      await this.kernel.suspend(tx, userId, {
        reason: input.reason,
        memberMessage: input.member_message,
        actorAdminId: auth.adminId,
      });
    });
    return this.detail(auth, userId);
  }

  /**
   * POST /admin/members/{userId}/unsuspend (PRD 4.2; AC F12-3, F12-5): satu transaksi dengan baris alumni terkunci:
   * pembatasan dicabut lewat MembershipKernel.unsuspend (status dihitung ulang dari expires_at, bukan otomatis
   * verified), setiap banding aktif ditutup sebagai dikabulkan, dan SATU notifikasi account yang menyatakan banding
   * dikabulkan bila ada.
   */
  async unsuspend(
    auth: AuthContext,
    userId: string,
    expectedVersion: number,
    input: { reason: string; member_message?: string | undefined },
  ): Promise<AdminMemberDetail> {
    await this.db.transaction(async (tx) => {
      const { user, profile } = await this.lockForAdmin(tx, auth, userId, expectedVersion);
      if (!profile.suspendedAt)
        throw new AppException(400, "VALIDATION_ERROR", "Anggota tidak sedang dibatasi.", {
          current: {
            suspended_at: null,
            account_status: user.status,
            version: String(profile.version),
          },
        });
      const appeals = await lockActiveAppeals(tx, userId);
      const memberMessage = input.member_message?.trim() || DEFAULT_UNSUSPEND_MESSAGE;
      await this.kernel.unsuspend(tx, userId, {
        reason: input.reason,
        memberMessage,
        appealGranted: appeals.length > 0,
        actorAdminId: auth.adminId,
      });
      await closeAppealsAsGranted(tx, this.audit, appeals, {
        actorAdminId: auth.adminId,
        reason: input.reason,
        memberMessage,
        resolutionNote: `Banding dikabulkan melalui pencabutan pembatasan dari menu anggota. Alasan: ${input.reason}`,
        now: this.clock.now(),
      });
    });
    return this.detail(auth, userId);
  }

  // ----------------------------------------------------------------------------------------------- histori

  /**
   * GET /admin/members/{userId}/membership-events (PRD 4.2, 6.3): terbaru lebih dulu, keyset (created_at, id) dengan
   * total. Tanpa moderation.read: entri warn tidak dikembalikan maupun dihitung (filter kind=warn → 403) dan alasan
   * suspend/unsuspend disembunyikan (`reason_redacted`); alasan koreksi nomor tetap tampil (PRD 2.3, AC F15-1).
   */
  async membershipEvents(
    auth: AuthContext,
    userId: string,
    query: unknown,
  ): Promise<AdminMembershipEventPage> {
    const { kind } = validateQuery(eventsQuerySchema, query);
    const page = parsePageQuery(query);
    const moderationRead = auth.permissions.has("moderation.read");
    const [member] = await this.db
      .select({ id: users.id })
      .from(users)
      .innerJoin(alumni, eq(alumni.userId, users.id))
      .where(and(eq(users.id, userId), eq(users.kind, "alumni"), ne(users.status, "deleted")))
      .limit(1);
    if (!member) throw notFound("Anggota tidak ditemukan.");
    if (kind === "warn" && !moderationRead)
      throw forbidden("Histori peringatan hanya untuk pemegang izin moderasi.");

    const conditions: SQL[] = [eq(membershipEvents.userId, userId)];
    if (kind) conditions.push(eq(membershipEvents.kind, kind));
    if (!moderationRead) conditions.push(ne(membershipEvents.kind, "warn"));
    const where = and(...conditions)!;
    const fingerprint = filterFingerprint({ kind: kind ?? null, moderationRead });

    let after: SQL | undefined;
    if (page.cursor) {
      const decoded = decodeCursor(
        page.cursor,
        z.object({ f: z.string(), c: z.iso.datetime(), i: uuidQuery }),
      );
      if (decoded.f !== fingerprint)
        throw new AppException(400, "VALIDATION_ERROR", "Parameter pencarian tidak valid.", {
          fieldErrors: { cursor: ["Cursor tidak cocok dengan filter. Muat ulang histori dari awal."] },
        });
      after = or(
        sql`${EVENT_TIME_KEY} < ${decoded.c}::timestamptz`,
        and(
          sql`${EVENT_TIME_KEY} = ${decoded.c}::timestamptz`,
          sql`${membershipEvents.id} < ${decoded.i}::uuid`,
        ),
      );
    }
    const rows = await this.db
      .select({ event: membershipEvents, actorName: admins.displayName })
      .from(membershipEvents)
      .leftJoin(admins, eq(admins.id, membershipEvents.actorAdminId))
      .where(after ? and(where, after) : where)
      .orderBy(desc(EVENT_TIME_KEY), desc(membershipEvents.id))
      .limit(page.limit + 1);
    const [totalRow] = await this.db.select({ value: count() }).from(membershipEvents).where(where);
    const hasMore = rows.length > page.limit;
    const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map(({ event, actorName }) => {
        const redacted = !moderationRead && (event.kind === "suspend" || event.kind === "unsuspend");
        return {
          id: event.id,
          kind: event.kind,
          created_at: event.createdAt.toISOString(),
          actor:
            event.actorAdminId && actorName
              ? { admin_id: event.actorAdminId, display_name: actorName }
              : null,
          payment_id: event.paymentId,
          reason: redacted ? null : event.reason,
          reason_redacted: redacted,
          before_starts_at: iso(event.beforeStartsAt),
          after_starts_at: iso(event.afterStartsAt),
          before_expires_at: iso(event.beforeExpiresAt),
          after_expires_at: iso(event.afterExpiresAt),
          before_member_number: event.beforeMemberNumber,
          after_member_number: event.afterMemberNumber,
        };
      }),
      next_cursor:
        hasMore && last
          ? encodeCursor({ f: fingerprint, c: last.event.createdAt.toISOString(), i: last.event.id })
          : null,
      total: Number(totalRow?.value ?? 0),
    };
  }
}
