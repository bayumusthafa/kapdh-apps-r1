import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@kapdh/config";
import type { components, Permission } from "@kapdh/contracts";
import {
  adminPermissions,
  admins,
  alumni,
  alumniProfessions,
  type FilePurpose,
  files,
  masterProfessions,
  mfaTotp,
  sessions,
  users,
} from "@kapdh/database";
import bcrypt from "bcryptjs";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  like,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../core/adapters/clock.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { isCheckViolation, isUniqueViolation } from "../../core/db/errors.js";
import type { Db, DbOrTx, Tx } from "../../core/db/types.js";
import { AppException, fieldError, notFound, versionConflict } from "../../core/errors/app-exception.js";
import { FilesService } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import {
  ADMIN_INVITE_TTL_MS,
  adminInviteTokenHash,
  newAdminInviteToken,
  randomToken,
} from "../../core/identity/crypto.js";
import { normalizeEmail } from "../../core/identity/email.js";
import { effectiveStatus } from "../../core/membership/effective-status.js";
import { OutboxService } from "../../core/outbox/outbox.service.js";
import type { OutboxPayload } from "../../core/outbox/topics.js";
import { decodeCursor, keysetAfter, pageOf, parsePageQuery } from "../../core/pagination/cursor.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { RealtimeService } from "../../core/realtime/realtime.service.js";
import { CLOCK, DB, ENV } from "../../core/tokens.js";
import { validate, validateQuery } from "../../core/validation/validate.js";
import { containsPattern } from "./audit-filter.js";
import {
  AdminCursorSchema,
  CandidateCursorSchema,
  CandidateQuerySchema,
  InviteSchema,
  ListQuerySchema,
  RecoverySchema,
  UpdateSchema,
} from "./admins.schemas.js";
import { assignmentProblems, effectivePermissions, sortPermissions } from "./permissions-catalog.js";

type Schemas = components["schemas"];
type AdminAccount = Schemas["AdminAccount"];
type AdminAccountDetail = Schemas["AdminAccountDetail"];
type AdminAccountPage = Schemas["AdminAccountPage"];
type AdminCandidate = Schemas["AdminCandidate"];
type AdminCandidatePage = Schemas["AdminCandidatePage"];
type AdminInvitationResult = Schemas["AdminInvitationResult"];
type AdminRecoveryResult = Schemas["AdminRecoveryResult"];
type EffectiveStatus = Schemas["EffectiveStatus"];
type SecurityNoticeKind = OutboxPayload<"admin.security_notice">["kind"];

/** Undangan/kirim ulang/pemulihan per Super Admin per jam (429, kontrak C7). */
const INVITE_RATE_LIMIT = 20;
/** Penghapusan identitas admin per Super Admin per jam. */
const DELETE_RATE_LIMIT = 20;
const HOUR_MS = 3600_000;

const inviter = alias(admins, "inviter");

type AdminRow = typeof admins.$inferSelect;

/** Pemegang file token viewer untuk URL avatar bertanda tangan (PRD 5.4). */
type Viewer = Pick<AuthContext, "userId" | "sessionId" | "sessionVersion">;

function conflict(field: string, message: string, current?: unknown): AppException {
  return new AppException(409, "VALIDATION_ERROR", message, {
    fieldErrors: { [field]: [message] },
    ...(current === undefined ? {} : { current }),
  });
}

/** Ronde undangan baru selalu menggeser invite_expires_at (penanda ronde untuk worker email, topik outbox). */
function nextInviteExpiry(now: Date, previous: Date | null): Date {
  const candidate = now.getTime() + ADMIN_INVITE_TTL_MS;
  return new Date(previous ? Math.max(candidate, previous.getTime() + 1) : candidate);
}

/** Hash token undangan yang belum pernah dikirim: membatalkan token lama seketika; worker menerbitkan token email. */
function unsentInviteHash(): string {
  return adminInviteTokenHash(newAdminInviteToken());
}

function adminRowsQuery(db: DbOrTx) {
  return db
    .select({
      id: admins.id,
      userId: admins.userId,
      displayName: admins.displayName,
      role: admins.role,
      status: admins.status,
      inviteExpiresAt: admins.inviteExpiresAt,
      activatedAt: admins.activatedAt,
      disabledAt: admins.disabledAt,
      version: admins.version,
      permissionsVersion: admins.permissionsVersion,
      createdAt: admins.createdAt,
      updatedAt: admins.updatedAt,
      invitedByAdminId: admins.invitedByAdminId,
      inviterName: inviter.displayName,
      linkedAlumniUserId: admins.linkedAlumniUserId,
      email: users.email,
      lastLoginAt: users.lastLoginAt,
      mfaVerifiedAt: mfaTotp.verifiedAt,
      linkedFullName: alumni.fullName,
      linkedMemberNumber: alumni.memberNumber,
      avatarId: files.id,
      avatarPurpose: files.purpose,
      avatarVisibility: files.visibility,
    })
    .from(admins)
    .innerJoin(users, eq(users.id, admins.userId))
    .leftJoin(mfaTotp, eq(mfaTotp.userId, admins.userId))
    .leftJoin(inviter, eq(inviter.id, admins.invitedByAdminId))
    .leftJoin(alumni, eq(alumni.userId, admins.linkedAlumniUserId))
    .leftJoin(files, and(eq(files.id, alumni.avatarFileId), eq(files.status, "ready")));
}

type AdminView = Awaited<ReturnType<ReturnType<typeof adminRowsQuery>["execute"]>>[number];

/**
 * Administrasi admin dan izin (F-16, AC F16-1..F16-3, PRD 2.3, 3.16, 8.2; kontrak C7 admin-admins). Hanya Super Admin
 * (admins.manage tidak dapat ditugaskan) dengan MFA dan reautentikasi untuk perubahan. Setiap perubahan peran, izin
 * atau status menaikkan permissions_version; izin dievaluasi dari database setiap request sehingga pencabutan berlaku
 * seketika, dan socket admin diputus agar tersambung ulang dengan hak terbaru (AC F16-3). Super Admin aktif terakhir
 * dijaga trigger transaksi admins_last_super_admin_chk (AC F16-2) yang dipetakan ke 409. Undangan membuat identitas
 * login admin TERPISAH (users.kind=admin) yang hanya ditautkan ke akun alumni untuk konflik kepentingan; sesi
 * aplikasi alumni tidak pernah memperoleh hak admin. Tautan undangan dikirim lewat outbox, tidak pernah di respons.
 */
@Injectable()
export class AdminsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly files: FilesService,
    private readonly realtime: RealtimeService,
    private readonly limits: RateLimitService,
  ) {}

  // ================================================================================================= baca

  private async permissionsOf(db: DbOrTx, adminIds: readonly string[]): Promise<Map<string, Permission[]>> {
    const result = new Map<string, Permission[]>();
    if (adminIds.length === 0) return result;
    const rows = await db
      .select({ adminId: adminPermissions.adminId, permission: adminPermissions.permission })
      .from(adminPermissions)
      .where(inArray(adminPermissions.adminId, [...adminIds]));
    for (const row of rows) {
      const list = result.get(row.adminId) ?? [];
      list.push(row.permission as Permission);
      result.set(row.adminId, list);
    }
    return result;
  }

  private async avatarUrl(
    file: { id: string | null; purpose: FilePurpose | null; visibility: string | null },
    viewer: Viewer,
  ): Promise<string | null> {
    if (!file.id || !file.purpose || !file.visibility) return null;
    const signed = await this.files.signedUrl(
      { id: file.id, purpose: file.purpose, visibility: file.visibility },
      { userId: viewer.userId, sessionId: viewer.sessionId, sessionVersion: viewer.sessionVersion },
    );
    return signed.url;
  }

  private async toAccount(row: AdminView, assigned: Permission[], viewer: Viewer): Promise<AdminAccount> {
    return {
      id: row.id,
      display_name: row.displayName,
      email: row.email,
      role: row.role,
      status: row.status,
      permissions: effectivePermissions(row.role, assigned),
      linked_alumni:
        row.linkedAlumniUserId && row.linkedFullName !== null
          ? {
              user_id: row.linkedAlumniUserId,
              full_name: row.linkedFullName,
              member_number: row.linkedMemberNumber,
              avatar_url: await this.avatarUrl(
                { id: row.avatarId, purpose: row.avatarPurpose, visibility: row.avatarVisibility },
                viewer,
              ),
            }
          : null,
      mfa_enrolled: row.mfaVerifiedAt !== null,
      last_login_at: row.lastLoginAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
      invite_expires_at: row.inviteExpiresAt?.toISOString() ?? null,
      activated_at: row.activatedAt?.toISOString() ?? null,
      disabled_at: row.disabledAt?.toISOString() ?? null,
      version: String(row.version),
    };
  }

  /** Detail admin (AdminAccountDetail) atau null bila tidak ada. */
  async findDetail(db: DbOrTx, adminId: string, viewer: Viewer): Promise<AdminAccountDetail | null> {
    const [row] = await adminRowsQuery(db).where(eq(admins.id, adminId)).limit(1);
    if (!row) return null;
    const [assigned, [sessionCount]] = await Promise.all([
      this.permissionsOf(db, [row.id]),
      db
        .select({ n: count() })
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, row.userId),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, this.clock.now()),
          ),
        ),
    ]);
    return {
      ...(await this.toAccount(row, assigned.get(row.id) ?? [], viewer)),
      invited_by: row.invitedByAdminId
        ? { admin_id: row.invitedByAdminId, display_name: row.inviterName ?? null }
        : null,
      permissions_version: row.permissionsVersion,
      active_session_count: Number(sessionCount?.n ?? 0),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  async get(auth: AuthContext, adminId: string): Promise<AdminAccountDetail> {
    const detail = await this.findDetail(this.db, adminId, auth);
    if (!detail) throw notFound("Admin tidak ditemukan.");
    return detail;
  }

  async list(auth: AuthContext, query: unknown): Promise<AdminAccountPage> {
    const filter = validateQuery(ListQuerySchema, query);
    const page = parsePageQuery(query);
    const sort = filter.sort ?? "display_name_asc";
    const cursor = page.cursor ? decodeCursor(page.cursor, AdminCursorSchema) : null;
    if (cursor && cursor.sort !== sort)
      throw fieldError("cursor", "Cursor tidak valid. Muat ulang daftar dari awal.");

    const conditions: (SQL | undefined)[] = [];
    if (filter.q) {
      const pattern = containsPattern(filter.q);
      conditions.push(or(ilike(admins.displayName, pattern), ilike(users.email, pattern)));
    }
    if (filter.role) conditions.push(eq(admins.role, filter.role));
    if (filter.status) conditions.push(eq(admins.status, filter.status));
    if (filter.permission)
      // Izin efektif: super_admin selalu cocok (ARCHITECTURE §4.5).
      conditions.push(
        or(
          eq(admins.role, "super_admin"),
          sql`exists (select 1 from ${adminPermissions} where ${adminPermissions.adminId} = ${admins.id} and ${adminPermissions.permission} = ${filter.permission})`,
        ),
      );
    const where = and(...conditions);

    let keyset: SQL | undefined;
    let order: SQL[];
    // Skema cursor per urutan (AdminCursorSchema) sudah menjamin bentuk `v`; sort cursor = sort query (cek di atas).
    if (sort === "created_at_desc") {
      order = [desc(admins.createdAt), desc(admins.id)];
      if (cursor?.sort === "created_at_desc")
        keyset = keysetAfter([
          { column: admins.createdAt, value: new Date(cursor.v), direction: "desc" },
          { column: admins.id, value: cursor.id, direction: "desc" },
        ]);
    } else if (sort === "last_login_at_desc") {
      // Belum pernah login di akhir (NULLS LAST eksplisit; DESC bawaan PostgreSQL menaruh NULL di awal).
      order = [sql`${users.lastLoginAt} desc nulls last`, desc(admins.id)];
      if (cursor?.sort === "last_login_at_desc") {
        const at = cursor.v === null ? null : new Date(cursor.v).toISOString();
        keyset =
          at === null
            ? and(isNull(users.lastLoginAt), sql`${admins.id} < ${cursor.id}`)
            : sql`(${users.lastLoginAt} < ${at}::timestamptz or (${users.lastLoginAt} = ${at}::timestamptz and ${admins.id} < ${cursor.id}) or ${users.lastLoginAt} is null)`;
      }
    } else {
      order = [asc(admins.displayName), asc(admins.id)];
      if (cursor?.sort === "display_name_asc")
        keyset = keysetAfter([
          { column: admins.displayName, value: cursor.v, direction: "asc" },
          { column: admins.id, value: cursor.id, direction: "asc" },
        ]);
    }

    const [rows, [total], [counts]] = await Promise.all([
      adminRowsQuery(this.db)
        .where(and(where, keyset))
        .orderBy(...order)
        .limit(page.limit + 1),
      this.db.select({ n: count() }).from(admins).innerJoin(users, eq(users.id, admins.userId)).where(where),
      this.db
        .select({
          total: count(),
          active: sql<number>`count(*) filter (where ${admins.status} = 'active')`.mapWith(Number),
          invited: sql<number>`count(*) filter (where ${admins.status} = 'invited')`.mapWith(Number),
          disabled: sql<number>`count(*) filter (where ${admins.status} = 'disabled')`.mapWith(Number),
        })
        .from(admins),
    ]);
    const pageRows = rows.slice(0, page.limit);
    const assigned = await this.permissionsOf(
      this.db,
      pageRows.map((row) => row.id),
    );
    const items = await Promise.all(
      pageRows.map((row) => this.toAccount(row, assigned.get(row.id) ?? [], auth)),
    );
    const next = pageOf(rows, page.limit, {
      cursorOf: (row) => ({
        sort,
        v:
          sort === "created_at_desc"
            ? row.createdAt.toISOString()
            : sort === "last_login_at_desc"
              ? (row.lastLoginAt?.toISOString() ?? null)
              : row.displayName,
        id: row.id,
      }),
    }).next_cursor;
    return {
      items,
      next_cursor: next,
      total: Number(total?.n ?? 0),
      counts: {
        total: Number(counts?.total ?? 0),
        active: counts?.active ?? 0,
        invited: counts?.invited ?? 0,
        disabled: counts?.disabled ?? 0,
      },
    };
  }

  /**
   * Kandidat "Delegasi User jadi Admin" (PRD 3.16, guideline hlm. 15): alumni berdasarkan nama, nomor anggota (awalan)
   * atau email; akun deleted/deletion_pending tidak pernah muncul. Kelayakan: belum tertaut ke identitas admin mana pun,
   * akun active, tidak suspended.
   */
  async candidates(auth: AuthContext, query: unknown): Promise<AdminCandidatePage> {
    const filter = validateQuery(CandidateQuerySchema, query);
    const page = parsePageQuery(query);
    const cursor = page.cursor ? decodeCursor(page.cursor, CandidateCursorSchema) : null;
    const conditions: (SQL | undefined)[] = [
      eq(users.kind, "alumni"),
      notInArray(users.status, ["deleted", "deletion_pending"]),
    ];
    if (filter.q) {
      const pattern = containsPattern(filter.q);
      const prefix = `${filter.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      conditions.push(
        or(ilike(alumni.fullName, pattern), like(alumni.memberNumber, prefix), ilike(users.email, pattern)),
      );
    }
    const where = and(...conditions);
    const now = this.clock.now();
    const [rows, [total]] = await Promise.all([
      this.db
        .select({
          userId: alumni.userId,
          fullName: alumni.fullName,
          memberNumber: alumni.memberNumber,
          email: users.email,
          accountStatus: users.status,
          expiresAt: alumni.expiresAt,
          suspendedAt: alumni.suspendedAt,
          createdAt: users.createdAt,
          profession: masterProfessions.label,
          avatarId: files.id,
          avatarPurpose: files.purpose,
          avatarVisibility: files.visibility,
          alreadyAdmin:
            sql<boolean>`exists (select 1 from ${admins} where ${admins.linkedAlumniUserId} = ${alumni.userId})`.mapWith(
              Boolean,
            ),
        })
        .from(alumni)
        .innerJoin(users, eq(users.id, alumni.userId))
        .leftJoin(alumniProfessions, eq(alumniProfessions.alumniUserId, alumni.userId))
        .leftJoin(masterProfessions, eq(masterProfessions.id, alumniProfessions.professionId))
        .leftJoin(files, and(eq(files.id, alumni.avatarFileId), eq(files.status, "ready")))
        .where(
          and(
            where,
            cursor
              ? keysetAfter([
                  { column: users.createdAt, value: cursor.created_at, direction: "desc" },
                  { column: users.id, value: cursor.id, direction: "desc" },
                ])
              : undefined,
          ),
        )
        .orderBy(desc(users.createdAt), desc(users.id))
        .limit(page.limit + 1),
      this.db.select({ n: count() }).from(alumni).innerJoin(users, eq(users.id, alumni.userId)).where(where),
    ]);
    const pageRows = rows.slice(0, page.limit);
    const items: AdminCandidate[] = await Promise.all(
      pageRows.map(async (row) => {
        const ineligible: AdminCandidate["ineligible_reason"] = row.alreadyAdmin
          ? "already_admin"
          : row.accountStatus !== "active"
            ? "account_inactive"
            : row.suspendedAt
              ? "suspended"
              : null;
        return {
          user_id: row.userId,
          full_name: row.fullName,
          member_number: row.memberNumber,
          email: row.email,
          profession: row.profession ?? null,
          avatar_url: await this.avatarUrl(
            { id: row.avatarId, purpose: row.avatarPurpose, visibility: row.avatarVisibility },
            auth,
          ),
          effective_status: effectiveStatus(
            { accountStatus: row.accountStatus, expiresAt: row.expiresAt, suspendedAt: row.suspendedAt },
            now,
          ) as EffectiveStatus,
          eligible: ineligible === null,
          ineligible_reason: ineligible,
        };
      }),
    );
    return {
      items,
      next_cursor: pageOf(rows, page.limit, {
        cursorOf: (row) => ({ created_at: row.createdAt, id: row.userId }),
      }).next_cursor,
      total: Number(total?.n ?? 0),
    };
  }

  // ============================================================================================== ubah

  private async consumeLimit(auth: AuthContext, kind: "invite" | "delete"): Promise<void> {
    await this.limits.consumeOrThrow(
      `admin-${kind}:${auth.adminId}`,
      kind === "invite" ? INVITE_RATE_LIMIT : DELETE_RATE_LIMIT,
      HOUR_MS,
      "Terlalu banyak perubahan admin dalam satu jam. Coba lagi nanti.",
    );
  }

  /** Mengunci baris admins saja (bukan users) agar urutan kunci admins -> users terjaga (handoff skema 0002). */
  private async lockAdmin(tx: Tx, adminId: string): Promise<AdminRow | undefined> {
    const [row] = await tx.select().from(admins).where(eq(admins.id, adminId)).for("update");
    return row;
  }

  private async loginFacts(tx: DbOrTx, userId: string) {
    const [row] = await tx
      .select({ email: users.email, mfaVerifiedAt: mfaTotp.verifiedAt })
      .from(users)
      .leftJoin(mfaTotp, eq(mfaTotp.userId, users.id))
      .where(eq(users.id, userId))
      .limit(1);
    return { email: row?.email ?? "", mfaEnrolled: row?.mfaVerifiedAt != null };
  }

  /** Email login admin lain (kind admin, belum dihapus) yang sudah memakai alamat ini. */
  private async emailTaken(tx: DbOrTx, email: string, exceptUserId?: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.kind, "admin"),
          eq(users.email, email),
          ne(users.status, "deleted"),
          exceptUserId ? ne(users.id, exceptUserId) : undefined,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** Mencabut seluruh sesi akun login admin dan menaikkan session_version (token yang belum expired ikut mati). */
  private async revokeSessions(tx: Tx, userId: string, now: Date): Promise<number> {
    // Aturan pencabutan sesi modul auth (modules/auth/session-locks.ts): baris users dikunci FOR UPDATE sebelum baris
    // sesi disentuh, sehingga rotasi refresh/penerbitan sesi yang bersamaan selesai lebih dulu (sesinya ikut dicabut)
    // atau menunggu lalu gagal. Pemanggil sudah memegang kunci admins (urutan admins → users → mfa_totp).
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    const revoked = await tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    await tx
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: now })
      .where(eq(users.id, userId));
    return revoked.length;
  }

  private async scheduleInvitation(tx: Tx, adminId: string, expiresAt: Date): Promise<void> {
    await this.outbox.publish(tx, {
      topic: "admin.invitation.requested",
      dedupKey: `admin.invitation.requested:${adminId}:${expiresAt.getTime()}`,
      payload: { admin_id: adminId, invite_expires_at: expiresAt.toISOString() },
    });
  }

  private async securityNotice(
    tx: Tx,
    adminId: string,
    kind: SecurityNoticeKind,
    version: number,
    auditId?: string,
  ): Promise<void> {
    await this.outbox.publish(tx, {
      topic: "admin.security_notice",
      dedupKey: `admin.security_notice:${adminId}:${kind}:${version}`,
      payload: { admin_id: adminId, kind, ...(auditId ? { audit_id: auditId } : {}) },
    });
  }

  private async requireDetail(adminId: string, auth: AuthContext): Promise<AdminAccountDetail> {
    const detail = await this.findDetail(this.db, adminId, auth);
    if (!detail) throw notFound("Admin tidak ditemukan.");
    return detail;
  }

  /**
   * Undangan admin (AC F16-1, PRD 3.16): identitas login baru `invited` dengan sandi awal acak (tidak diketahui siapa
   * pun) dan hash token undangan yang belum pernah dikirim; worker menerbitkan token email lewat outbox. Bentrok
   * unique (email login, tautan alumni) menjadi 409, termasuk saat dua undangan bersamaan berebut alumni yang sama.
   */
  async invite(auth: AuthContext, body: unknown): Promise<AdminInvitationResult> {
    const input = validate(InviteSchema, body);
    if (input.role === "super_admin" && input.permissions.length > 0)
      throw fieldError("permissions", "Super Admin memiliki semua izin; kosongkan daftar izin.");
    if (input.role === "admin") {
      const problems = assignmentProblems(input.permissions);
      if (problems.length > 0)
        throw new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
          fieldErrors: { permissions: problems },
        });
    }
    if (!input.alumni_user_id) {
      const missing: Record<string, string[]> = {};
      if (!input.email) missing.email = ["Email login admin wajib diisi bila tanpa alumni."];
      if (!input.display_name) missing.display_name = ["Nama tampilan wajib diisi bila tanpa alumni."];
      if (Object.keys(missing).length > 0)
        throw new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
          fieldErrors: missing,
        });
    }
    await this.consumeLimit(auth, "invite");
    // bcrypt di luar transaksi: sandi awal acak yang tidak pernah ditampilkan (PRD 3.16).
    const passwordHash = await bcrypt.hash(randomToken(32), this.env.BCRYPT_COST);
    const now = this.clock.now();
    const adminId = uuidv7();
    const userId = uuidv7();
    const inviteExpiresAt = nextInviteExpiry(now, null);

    try {
      await this.db.transaction(async (tx) => {
        let email = input.email ? normalizeEmail(input.email) : null;
        let displayName = input.display_name ?? null;
        if (input.alumni_user_id) {
          // Kunci NO KEY UPDATE baris akun alumni (urutan global users -> alumni): suspend/penghapusan bersamaan
          // menunggu sampai undangan selesai, DAN dua undangan untuk alumni yang sama berurutan sehingga yang kedua
          // melihat tautan yang pertama dan ditolak 409 pada `alumni_user_id` (kontrak C7 adminInviteAdmin), bukan
          // bentrok email bawaan alumni di users_kind_email_key. Tidak menghalangi FOR KEY SHARE (insert FK ke users).
          const [account] = await tx
            .select({ kind: users.kind, status: users.status, email: users.email })
            .from(users)
            .where(eq(users.id, input.alumni_user_id))
            .for("no key update");
          if (!account || account.kind !== "alumni")
            throw fieldError("alumni_user_id", "Alumni tidak ditemukan.");
          if (account.status !== "active")
            throw fieldError(
              "alumni_user_id",
              "Akun alumni tidak aktif atau sedang dalam proses penghapusan.",
            );
          const [profile] = await tx
            .select({ fullName: alumni.fullName, suspendedAt: alumni.suspendedAt })
            .from(alumni)
            .where(eq(alumni.userId, input.alumni_user_id))
            .for("share");
          if (!profile) throw fieldError("alumni_user_id", "Alumni tidak ditemukan.");
          if (profile.suspendedAt)
            throw fieldError(
              "alumni_user_id",
              "Alumni sedang dibatasi pengurus dan tidak dapat dijadikan admin.",
            );
          const [linked] = await tx
            .select({ id: admins.id })
            .from(admins)
            .where(eq(admins.linkedAlumniUserId, input.alumni_user_id))
            .limit(1);
          if (linked) throw conflict("alumni_user_id", "Alumni ini sudah tertaut ke identitas admin.");
          email ??= account.email;
          displayName ??= profile.fullName.trim().slice(0, 120);
        }
        if (!email || !displayName) throw fieldError("email", "Email login admin wajib diisi.");
        if (await this.emailTaken(tx, email))
          throw conflict("email", "Email login ini sudah dipakai identitas admin lain.");

        await tx.insert(users).values({
          id: userId,
          email,
          passwordHash,
          status: "active",
          kind: "admin",
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(admins).values({
          id: adminId,
          userId,
          linkedAlumniUserId: input.alumni_user_id ?? null,
          displayName,
          role: input.role,
          status: "invited",
          inviteTokenHash: unsentInviteHash(),
          inviteExpiresAt,
          invitedByAdminId: auth.adminId,
          createdAt: now,
          updatedAt: now,
        });
        const permissions = input.role === "admin" ? sortPermissions(input.permissions) : [];
        if (permissions.length > 0)
          await tx.insert(adminPermissions).values(
            permissions.map((permission) => ({
              adminId,
              permission,
              grantedByAdminId: auth.adminId,
              createdAt: now,
            })),
          );
        await this.audit.write(tx, {
          action: "admin.invited",
          entityType: "admin",
          entityId: adminId,
          after: {
            display_name: displayName,
            email,
            role: input.role,
            permissions,
            status: "invited",
            linked_alumni_user_id: input.alumni_user_id ?? null,
            invite_expires_at: inviteExpiresAt.toISOString(),
          },
        });
        await this.scheduleInvitation(tx, adminId, inviteExpiresAt);
      });
    } catch (error) {
      if (isUniqueViolation(error, "users_kind_email_key"))
        throw conflict("email", "Email login ini sudah dipakai identitas admin lain.");
      if (isUniqueViolation(error, "admins_linked_alumni_user_id_key"))
        throw conflict("alumni_user_id", "Alumni ini sudah tertaut ke identitas admin.");
      throw error;
    }
    return {
      admin: await this.requireDetail(adminId, auth),
      invitation_expires_at: inviteExpiresAt.toISOString(),
      invitation_sent_at: now.toISOString(),
    };
  }

  /**
   * PATCH admin (AC F16-1..F16-3, F15-4): nama, peran, izin, status, atau email login identitas tanpa kredensial
   * terpakai. Baris admins dikunci lebih dulu lalu UPDATE bersyarat versi; penurunan/penonaktifan Super Admin terakhir
   * ditolak trigger (23514) dan dipetakan ke 409 VALIDATION_ERROR dengan `current` (AC F16-2).
   */
  async update(
    auth: AuthContext,
    adminId: string,
    body: unknown,
    expectedVersion: number,
  ): Promise<AdminAccountDetail> {
    const input = validate(UpdateSchema, body);
    const changes = ["display_name", "email", "role", "permissions", "status"] as const;
    if (!changes.some((key) => input[key] !== undefined))
      throw fieldError("_", "Kirim minimal satu perubahan (nama, email, peran, izin, atau status).");
    if (input.email !== undefined && input.status !== undefined)
      throw fieldError("email", "Koreksi email tidak dapat digabung dengan perubahan status.");
    if (input.status === "disabled" && !input.reason)
      throw fieldError("reason", "Alasan wajib diisi saat menonaktifkan admin.");
    if (input.permissions !== undefined) {
      const problems = assignmentProblems(input.permissions);
      if (problems.length > 0)
        throw new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
          fieldErrors: { permissions: problems },
        });
    }
    const newEmail = input.email !== undefined ? normalizeEmail(input.email) : undefined;
    const now = this.clock.now();

    try {
      await this.db.transaction(async (tx) => {
        const current = await this.lockAdmin(tx, adminId);
        if (!current) throw notFound("Admin tidak ditemukan.");
        if (current.version !== expectedVersion)
          throw versionConflict(await this.findDetail(tx, adminId, auth));
        const facts = await this.loginFacts(tx, current.userId);
        const assigned = (await this.permissionsOf(tx, [adminId])).get(adminId) ?? [];

        // ---- peran dan izin
        const targetRole = input.role ?? current.role;
        if (targetRole === "super_admin" && input.permissions && input.permissions.length > 0)
          throw fieldError("permissions", "Super Admin memiliki semua izin; kosongkan daftar izin.");
        if (targetRole === "admin" && current.role === "super_admin" && input.permissions === undefined)
          throw fieldError("permissions", "Sertakan izin (boleh kosong) saat mengubah peran menjadi Admin.");
        const targetPermissions =
          targetRole === "super_admin" ? [] : sortPermissions(input.permissions ?? assigned);
        const storedBefore = sortPermissions(assigned);
        const roleChanged = targetRole !== current.role;
        const permissionsChanged =
          targetPermissions.length !== storedBefore.length ||
          targetPermissions.some((permission, index) => permission !== storedBefore[index]);

        // ---- status
        const targetStatus = input.status ?? current.status;
        const statusChanged = targetStatus !== current.status;
        if (statusChanged && targetStatus === "active") {
          if (current.status !== "disabled" || !current.activatedAt)
            throw conflict(
              "status",
              "Admin yang belum pernah aktif diaktifkan lewat kirim ulang undangan, bukan perubahan status.",
            );
          if (!facts.mfaEnrolled)
            throw conflict(
              "status",
              "TOTP admin tidak lagi terverifikasi; pulihkan akun lewat pemulihan admin.",
            );
        }

        // ---- email login (hanya selama tidak ada kredensial yang dapat dipakai)
        const emailChanged = newEmail !== undefined && newEmail !== facts.email;
        if (emailChanged) {
          const credentialless =
            current.status === "invited" || (current.status === "disabled" && !current.activatedAt);
          if (!credentialless)
            throw conflict(
              "email",
              "Email admin yang pernah aktif hanya dapat diganti lewat pemulihan admin (reset sandi dan MFA).",
            );
          if (await this.emailTaken(tx, newEmail!, current.userId))
            throw conflict("email", "Email login ini sudah dipakai identitas admin lain.");
        }
        const nameChanged = input.display_name !== undefined && input.display_name !== current.displayName;
        // Nilai yang sama dengan keadaan sekarang tidak mengubah apa pun (tanpa versi baru dan tanpa audit).
        if (!roleChanged && !permissionsChanged && !statusChanged && !emailChanged && !nameChanged) return;

        const reissue = emailChanged && current.status === "invited";
        const inviteExpiresAt = reissue ? nextInviteExpiry(now, current.inviteExpiresAt) : null;
        const accessChanged = roleChanged || permissionsChanged || statusChanged;
        const [updated] = await tx
          .update(admins)
          .set({
            displayName: input.display_name ?? current.displayName,
            role: targetRole,
            status: targetStatus,
            ...(statusChanged && targetStatus === "disabled"
              ? { disabledAt: now, inviteTokenHash: null, inviteExpiresAt: null }
              : {}),
            ...(statusChanged && targetStatus === "active" ? { disabledAt: null } : {}),
            ...(reissue ? { inviteTokenHash: unsentInviteHash(), inviteExpiresAt } : {}),
            ...(accessChanged ? { permissionsVersion: sql`${admins.permissionsVersion} + 1` } : {}),
            version: sql`${admins.version} + 1`,
            updatedAt: now,
          })
          .where(and(eq(admins.id, adminId), eq(admins.version, expectedVersion)))
          .returning({ version: admins.version });
        if (!updated) throw versionConflict(await this.findDetail(tx, adminId, auth));

        if (permissionsChanged) {
          await tx.delete(adminPermissions).where(eq(adminPermissions.adminId, adminId));
          if (targetPermissions.length > 0)
            await tx.insert(adminPermissions).values(
              targetPermissions.map((permission) => ({
                adminId,
                permission,
                grantedByAdminId: auth.adminId,
                createdAt: now,
              })),
            );
        }

        if (emailChanged) {
          await tx
            .update(users)
            .set({ email: newEmail!, updatedAt: now })
            .where(eq(users.id, current.userId));
          if (reissue) {
            // Token lama tidak berlaku; pendaftaran TOTP yang sedang berjalan dibatalkan (kontrak adminUpdateAdmin).
            // Sesi dicabut lebih dulu (kunci users) lalu TOTP: urutan admins → users → mfa_totp.
            await this.revokeSessions(tx, current.userId, now);
            await tx
              .delete(mfaTotp)
              .where(and(eq(mfaTotp.userId, current.userId), isNull(mfaTotp.verifiedAt)));
          }
        }
        if (statusChanged && targetStatus === "disabled") {
          await this.revokeSessions(tx, current.userId, now);
          this.realtime.disconnectUser(current.userId, "account_disabled");
        }
        // Perubahan peran/izin saja TIDAK mencabut sesi, sehingga `session.revoked` (C6: "sesi ini dicabut", klien
        // menghapus token) tidak dikirim. Pencabutan berlaku seketika karena izin dibaca ulang dari database setiap
        // request dan permissions_version naik (AC F16-3); identitas admin tidak memiliki socket realtime (gateway
        // hanya menerima audience mobile), dan sesi alumni tertaut tidak pernah membawa hak admin.

        const auditId = await this.audit.write(tx, {
          action: "admin.updated",
          entityType: "admin",
          entityId: adminId,
          reason: input.reason ?? null,
          before: {
            display_name: current.displayName,
            email: facts.email,
            role: current.role,
            permissions: effectivePermissions(current.role, assigned),
            status: current.status,
          },
          after: {
            display_name: input.display_name ?? current.displayName,
            email: emailChanged ? newEmail : facts.email,
            role: targetRole,
            permissions: effectivePermissions(targetRole, targetPermissions),
            status: targetStatus,
          },
        });

        if (reissue) {
          await this.scheduleInvitation(tx, adminId, inviteExpiresAt!);
          // Identitas pernah aktif (sedang dipulihkan): alamat lama diberi tahu pengalihan (kontrak C7).
          if (current.activatedAt)
            await this.securityNotice(tx, adminId, "email_changed", updated.version, auditId);
        }
        if (current.activatedAt) {
          if (statusChanged && targetStatus === "disabled")
            await this.securityNotice(tx, adminId, "disabled", updated.version);
          if (roleChanged) await this.securityNotice(tx, adminId, "role_changed", updated.version);
          else if (permissionsChanged)
            await this.securityNotice(tx, adminId, "permissions_changed", updated.version);
        }
      });
    } catch (error) {
      if (isCheckViolation(error, "admins_last_super_admin_chk")) {
        const field = input.status === "disabled" ? "status" : "role";
        throw conflict(
          field,
          "Super Admin aktif terakhir tidak dapat diturunkan atau dinonaktifkan. Tetapkan Super Admin lain lebih dulu.",
          await this.requireDetail(adminId, auth),
        );
      }
      if (isUniqueViolation(error, "users_kind_email_key"))
        throw conflict("email", "Email login ini sudah dipakai identitas admin lain.");
      throw error;
    }
    return this.requireDetail(adminId, auth);
  }

  /**
   * Hapus identitas yang belum pernah aktif (kontrak adminDeleteAdmin): DELETE bersyarat baris admins (versi + belum
   * pernah aktif) lalu akun login admin (kaskade sesi, OTP, TOTP belum selesai). Identitas yang pernah aktif adalah
   * jejak keputusan dan konflik kepentingan (PRD 2.3, 3.17), sehingga ditolak 409.
   */
  async remove(auth: AuthContext, adminId: string, expectedVersion: number): Promise<void> {
    await this.consumeLimit(auth, "delete");
    await this.db.transaction(async (tx) => {
      const current = await this.lockAdmin(tx, adminId);
      if (!current) throw notFound("Admin tidak ditemukan.");
      if (current.activatedAt)
        throw conflict(
          "_",
          "Admin yang pernah aktif tidak dapat dihapus; nonaktifkan dengan mengubah status menjadi nonaktif.",
        );
      if (current.version !== expectedVersion)
        throw versionConflict(await this.findDetail(tx, adminId, auth));
      const facts = await this.loginFacts(tx, current.userId);
      const assigned = (await this.permissionsOf(tx, [adminId])).get(adminId) ?? [];
      const [deleted] = await tx
        .delete(admins)
        .where(and(eq(admins.id, adminId), eq(admins.version, expectedVersion), isNull(admins.activatedAt)))
        .returning({ userId: admins.userId });
      if (!deleted) throw versionConflict(await this.findDetail(tx, adminId, auth));
      await tx.delete(users).where(and(eq(users.id, deleted.userId), eq(users.kind, "admin")));
      await this.audit.write(tx, {
        action: "admin.deleted",
        entityType: "admin",
        entityId: adminId,
        before: {
          display_name: current.displayName,
          email: facts.email,
          role: current.role,
          permissions: effectivePermissions(current.role, assigned),
          status: current.status,
          linked_alumni_user_id: current.linkedAlumniUserId,
        },
      });
    });
  }

  /**
   * Kirim ulang undangan (kontrak adminResendAdminInvitation): admin `invited` (termasuk yang sedang dipulihkan) atau
   * `disabled` yang belum pernah aktif (kembali `invited`). Token lama langsung tidak berlaku; email lewat outbox.
   */
  async resendInvitation(
    auth: AuthContext,
    adminId: string,
    expectedVersion: number,
  ): Promise<AdminInvitationResult> {
    await this.consumeLimit(auth, "invite");
    const now = this.clock.now();
    let inviteExpiresAt!: Date;
    await this.db.transaction(async (tx) => {
      const current = await this.lockAdmin(tx, adminId);
      if (!current) throw notFound("Admin tidak ditemukan.");
      if (current.version !== expectedVersion)
        throw versionConflict(await this.findDetail(tx, adminId, auth));
      const resendable =
        current.status === "invited" || (current.status === "disabled" && !current.activatedAt);
      if (!resendable)
        throw conflict(
          "_",
          current.status === "active"
            ? "Admin sudah aktif. Gunakan pemulihan admin bila sandi atau TOTP hilang."
            : "Admin pernah aktif. Aktifkan kembali atau gunakan pemulihan admin.",
        );
      inviteExpiresAt = nextInviteExpiry(now, current.inviteExpiresAt);
      const statusChanged = current.status !== "invited";
      await tx
        .update(admins)
        .set({
          status: "invited",
          disabledAt: null,
          inviteTokenHash: unsentInviteHash(),
          inviteExpiresAt,
          ...(statusChanged ? { permissionsVersion: sql`${admins.permissionsVersion} + 1` } : {}),
          version: sql`${admins.version} + 1`,
          updatedAt: now,
        })
        .where(and(eq(admins.id, adminId), eq(admins.version, expectedVersion)));
      // Pendaftaran TOTP yang belum terverifikasi dari token lama dibatalkan.
      await tx.delete(mfaTotp).where(and(eq(mfaTotp.userId, current.userId), isNull(mfaTotp.verifiedAt)));
      await this.audit.write(tx, {
        action: "admin.invitation_resent",
        entityType: "admin",
        entityId: adminId,
        before: { status: current.status, invite_expires_at: current.inviteExpiresAt?.toISOString() ?? null },
        after: { status: "invited", invite_expires_at: inviteExpiresAt.toISOString() },
      });
      await this.scheduleInvitation(tx, adminId, inviteExpiresAt);
    });
    return {
      admin: await this.requireDetail(adminId, auth),
      invitation_expires_at: inviteExpiresAt.toISOString(),
      invitation_sent_at: now.toISOString(),
    };
  }

  /**
   * Pemulihan admin yang pernah aktif (kontrak adminRecoverAdmin, PRD 3.16, risiko PRD 10): satu transaksi READ
   * COMMITTED dengan baris admins diubah sebelum users: status invited + token undangan baru, TOTP dan backup code
   * dihapus, sandi diganti hash acak, seluruh sesi dicabut + session_version naik + socket diputus, email opsional
   * dialihkan, audit `admin.recovery_initiated`, outbox email pemulihan dan pemberitahuan keamanan.
   */
  async recover(
    auth: AuthContext,
    adminId: string,
    body: unknown,
    expectedVersion: number,
  ): Promise<AdminRecoveryResult> {
    const input = validate(RecoverySchema, body);
    const newEmail = input.email ? normalizeEmail(input.email) : undefined;
    await this.consumeLimit(auth, "invite");
    const passwordHash = await bcrypt.hash(randomToken(32), this.env.BCRYPT_COST);
    const now = this.clock.now();
    let inviteExpiresAt!: Date;
    let revokedSessions = 0;
    try {
      await this.db.transaction(async (tx) => {
        const current = await this.lockAdmin(tx, adminId);
        if (!current) throw notFound("Admin tidak ditemukan.");
        if (current.id === auth.adminId)
          throw conflict(
            "_",
            "Super Admin tidak dapat memulihkan dirinya sendiri; gunakan ganti sandi atau backup code.",
          );
        if (current.status === "invited" || !current.activatedAt)
          throw conflict("_", "Admin belum pernah aktif atau sedang diundang; gunakan kirim ulang undangan.");
        if (current.version !== expectedVersion)
          throw versionConflict(await this.findDetail(tx, adminId, auth));
        const facts = await this.loginFacts(tx, current.userId);
        const emailChanged = newEmail !== undefined && newEmail !== facts.email;
        if (emailChanged && (await this.emailTaken(tx, newEmail!, current.userId)))
          throw conflict("email", "Email login ini sudah dipakai identitas admin lain.");

        inviteExpiresAt = nextInviteExpiry(now, current.inviteExpiresAt);
        // Baris admins lebih dahulu (urutan kunci admins -> users); trigger Super Admin terakhir dapat menolak.
        const [updated] = await tx
          .update(admins)
          .set({
            status: "invited",
            disabledAt: null,
            inviteTokenHash: unsentInviteHash(),
            inviteExpiresAt,
            permissionsVersion: sql`${admins.permissionsVersion} + 1`,
            version: sql`${admins.version} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(admins.id, adminId),
              eq(admins.version, expectedVersion),
              inArray(admins.status, ["active", "disabled"]),
              sql`${admins.activatedAt} is not null`,
              ne(admins.id, auth.adminId!),
            ),
          )
          .returning({ version: admins.version });
        if (!updated) throw versionConflict(await this.findDetail(tx, adminId, auth));
        // Urutan kunci identitas admin admins → users → mfa_totp (modules/admin-auth/admin-auth.shared.ts): baris users
        // dikunci (UPDATE, lalu FOR UPDATE untuk pencabutan sesi) sebelum baris TOTP dihapus, sama dengan verifikasi
        // MFA dan pendaftaran TOTP.
        await tx
          .update(users)
          .set({ passwordHash, ...(emailChanged ? { email: newEmail! } : {}), updatedAt: now })
          .where(eq(users.id, current.userId));
        revokedSessions = await this.revokeSessions(tx, current.userId, now);
        await tx.delete(mfaTotp).where(eq(mfaTotp.userId, current.userId));
        this.realtime.disconnectUser(current.userId, "password_reset");

        const auditId = await this.audit.write(tx, {
          action: "admin.recovery_initiated",
          entityType: "admin",
          entityId: adminId,
          reason: input.reason,
          before: { status: current.status, ...(emailChanged ? { email: facts.email } : {}) },
          after: {
            status: "invited",
            ...(emailChanged ? { email: newEmail } : {}),
            invite_expires_at: inviteExpiresAt.toISOString(),
            sessions_revoked: revokedSessions,
          },
        });
        await this.scheduleInvitation(tx, adminId, inviteExpiresAt);
        await this.securityNotice(tx, adminId, "mfa_reset", updated.version);
        if (emailChanged) await this.securityNotice(tx, adminId, "email_changed", updated.version, auditId);
      });
    } catch (error) {
      if (isCheckViolation(error, "admins_last_super_admin_chk"))
        throw conflict(
          "status",
          "Super Admin aktif terakhir tidak dapat dipulihkan; tetapkan Super Admin lain lebih dulu.",
          await this.requireDetail(adminId, auth),
        );
      if (isUniqueViolation(error, "users_kind_email_key"))
        throw conflict("email", "Email login ini sudah dipakai identitas admin lain.");
      throw error;
    }
    return {
      admin: await this.requireDetail(adminId, auth),
      invitation_expires_at: inviteExpiresAt.toISOString(),
      invitation_sent_at: now.toISOString(),
      revoked_session_count: revokedSessions,
    };
  }
}
