import { Inject, Injectable } from "@nestjs/common";
import { alumni, membershipEvents, payments, reports, sessions, users } from "@kapdh/database";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../adapters/clock.js";
import { AuditService } from "../audit/audit.service.js";
import { rows } from "../db/rows.js";
import { afterCommit, assertCommitAware } from "../db/tx.js";
import type { Db, DbOrTx, Tx } from "../db/types.js";
import { AppException, fieldError, notFound, versionConflict } from "../errors/app-exception.js";
import { NotificationService } from "../notifications-kernel/notification.service.js";
import { RealtimeService } from "../realtime/realtime.service.js";
import { CLOCK, DB } from "../tokens.js";
import { assertMemberAccess, type MemberAccessLevel, memberAccessAllows } from "./access.js";
import { type AccountStatus, effectiveStatus, type EffectiveStatus } from "./effective-status.js";
import {
  assertClasses,
  COHORT_BASE_YEAR,
  type Gender,
  InvalidAcademicDataError,
  memberNumber,
} from "./member-number.js";
import { jakartaYear, registrationPeriod, renewalPeriod } from "./period.js";

type PaymentRow = typeof payments.$inferSelect;
type AlumniRow = typeof alumni.$inferSelect;

export interface MemberStatusSnapshot {
  userId: string;
  accountStatus: AccountStatus;
  status: EffectiveStatus;
  memberNumber: string | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  suspendedAt: Date | null;
}

/**
 * Hasil {@link MembershipKernel.applyPaidPayment}:
 * - `applied`: periode baru diterapkan oleh pemanggilan ini;
 * - `already_applied`: payment ini sudah pernah diterapkan (idempoten, AC F04-5); periode yang sama dikembalikan;
 * - `owner_deleted`: pemilik sudah dihapus (payments.user_id NULL, akun `deleted` atau tanpa profil alumni; F-14,
 *   D2): payment tetap paid TANPA efek keanggotaan (kontrak adminDecidePayment "member null").
 */
export type AppliedPeriod =
  | {
      outcome: "applied" | "already_applied";
      /** true hanya untuk `applied`. */
      applied: boolean;
      kind: "activation" | "renewal";
      eventId: string;
      /** Awal dan akhir periode milik payment ini (membership_events.after_*). */
      periodStartsAt: Date;
      periodExpiresAt: Date;
    }
  | {
      outcome: "owner_deleted";
      applied: false;
      kind: "activation" | "renewal";
      eventId: null;
      periodStartsAt: null;
      periodExpiresAt: null;
    };

export interface SuspendInput {
  /** Alasan internal pengurus (audit, membership_events); tidak pernah ditampilkan ke anggota atau publik. */
  reason: string;
  /** Pesan aman yang ditampilkan di portal pembatasan (PRD 2.2). */
  memberMessage: string;
  actorAdminId: string | null;
}

export interface UnsuspendInput {
  /** Alasan pencabutan untuk audit dan histori (wajib). */
  reason: string;
  /**
   * Pesan aman untuk anggota pada notifikasi pencabutan (kontrak adminUnsuspendMember `member_message`); null/kosong =
   * teks baku {@link DEFAULT_UNSUSPEND_MESSAGE}.
   */
  memberMessage?: string | null;
  /** true bila pemanggil menutup banding anggota sebagai dikabulkan dalam transaksi yang sama (satu notifikasi). */
  appealGranted?: boolean;
  actorAdminId: string | null;
  /**
   * Awal catatan internal (`resolution_note`) banding aktif yang ditutup otomatis sebagai dikabulkan; `reason` selalu
   * ditambahkan. Bawaan merujuk pencabutan dari menu anggota (kontrak adminUnsuspendMember langkah 2).
   */
  appealResolutionNote?: string;
  /**
   * Banding yang sedang diputus pemanggil sendiri dalam transaksi ini (adminResolveReport atas banding): tidak ikut
   * ditutup kernel karena pemanggil menulis keputusannya sendiri.
   */
  excludeAppealId?: string;
}

/** Teks baku notifikasi pencabutan pembatasan bila `member_message` tidak dikirim (kontrak adminUnsuspendMember). */
export const DEFAULT_UNSUSPEND_MESSAGE = "Pembatasan akun Anda telah dicabut pengurus";

/** Batas catatan keputusan laporan (kontrak AdminModerationResolution.note maxLength 1000). */
const RESOLUTION_NOTE_MAX = 1000;

/** Awal catatan internal bawaan banding yang ditutup karena pembatasan dicabut dari menu anggota (kontrak C2). */
export const DEFAULT_APPEAL_GRANTED_NOTE =
  "Banding dikabulkan otomatis karena pembatasan dicabut pengurus melalui menu anggota.";

export interface IdentityChanges {
  cohort?: number;
  classIn?: number;
  classOut?: number;
  gender?: Gender;
}

export interface IdentityCorrection {
  changed: boolean;
  previousMemberNumber: string | null;
  memberNumber: string | null;
  version: number;
}

const conflict = (message: string, current?: unknown) =>
  new AppException(409, "PAYMENT_STATE_CONFLICT", message, current === undefined ? {} : { current });

/**
 * Prasyarat tindakan pengurus tidak terpenuhi dengan keadaan terkini (kontrak admin-members: 400 "dengan versi terkini").
 */
const preconditionFailed = (
  message: string,
  member: { suspendedAt: Date | null; version: number; accountStatus: AccountStatus },
) =>
  new AppException(400, "VALIDATION_ERROR", message, {
    current: {
      suspended_at: member.suspendedAt?.toISOString() ?? null,
      account_status: member.accountStatus,
      version: String(member.version),
    },
  });

/** Angkatan terbaru menurut tahun Jakarta: 30 pada 2026 (PRD 3.5). */
export function latestCohort(now: Date): number {
  return jakartaYear(now) - COHORT_BASE_YEAR;
}

/**
 * Kernel keanggotaan (ARCHITECTURE §3.1, §3.2, §4.2): satu-satunya penulis kolom keanggotaan di `alumni` (nomor,
 * periode, suspend) di luar profil. Semua metode transaksional menerima `tx` commit-aware (this.db.transaction dari DB
 * yang diinjeksi, TxRunner, atau withTx; savepoint ditolak {@link assertCommitAware}) karena efek realtime/notifikasi
 * dijadwalkan setelah commit. Setiap perubahan mengunci baris users lalu alumni (`FOR NO KEY UPDATE` / `FOR UPDATE`,
 * URUTAN KUNCI kontrak C3/C5) lalu menulis audit dan histori pada transaksi yang sama (AC F17-1).
 */
@Injectable()
export class MembershipKernel {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly realtime: RealtimeService,
  ) {}

  // ------------------------------------------------------------------------------------------- effective status

  /**
   * effective_status dari data canonical saat ini (PRD 4.2; AC F07-3 tidak menunggu worker). null bila user tidak ada
   * atau bukan akun alumni.
   */
  async effectiveStatusFor(
    userId: string,
    options: { db?: DbOrTx; now?: Date } = {},
  ): Promise<MemberStatusSnapshot | null> {
    const snapshots = await this.snapshots([userId], options);
    return snapshots.get(userId) ?? null;
  }

  /** Versi batch (validasi ulang socket berkala, daftar). Pengguna yang tidak ada/bukan alumni tidak muncul di Map. */
  async effectiveStatusesFor(
    userIds: readonly string[],
    options: { db?: DbOrTx; now?: Date } = {},
  ): Promise<Map<string, MemberStatusSnapshot>> {
    return this.snapshots(userIds, options);
  }

  /** true bila effective_status memenuhi tingkat @MemberAccess (ARCHITECTURE §3.1). */
  allows(level: MemberAccessLevel, status: EffectiveStatus): boolean {
    return memberAccessAllows(level, status);
  }

  /** Melempar 403 ACCOUNT_SUSPENDED / MEMBERSHIP_REQUIRED bila tingkat tidak terpenuhi (PRD 2.2). */
  assertAccess(level: MemberAccessLevel, status: EffectiveStatus): void {
    assertMemberAccess(level, status);
  }

  private async snapshots(
    userIds: readonly string[],
    options: { db?: DbOrTx; now?: Date },
  ): Promise<Map<string, MemberStatusSnapshot>> {
    const result = new Map<string, MemberStatusSnapshot>();
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return result;
    const now = options.now ?? this.clock.now();
    const found = await (options.db ?? this.db)
      .select({
        userId: users.id,
        kind: users.kind,
        accountStatus: users.status,
        memberNumber: alumni.memberNumber,
        startsAt: alumni.startsAt,
        expiresAt: alumni.expiresAt,
        suspendedAt: alumni.suspendedAt,
      })
      .from(users)
      .innerJoin(alumni, eq(alumni.userId, users.id))
      .where(inArray(users.id, ids));
    for (const row of found) {
      if (row.kind !== "alumni") continue;
      const accountStatus = row.accountStatus as AccountStatus;
      result.set(row.userId, {
        userId: row.userId,
        accountStatus,
        status: effectiveStatus(
          { accountStatus, expiresAt: row.expiresAt, suspendedAt: row.suspendedAt },
          now,
        ),
        memberNumber: row.memberNumber,
        startsAt: row.startsAt,
        expiresAt: row.expiresAt,
        suspendedAt: row.suspendedAt,
      });
    }
    return result;
  }

  // -------------------------------------------------------------------------------------------- nomor anggota

  /**
   * Mengalokasikan nomor AA.SS.JK.N sekali (AC F05-1): baris alumni dikunci, N dari `nextval` di transaksi dan sesi
   * yang sama lalu nomor ditulis dalam satu UPDATE (alumni_member_seq_source_chk). Bila sudah ada, nomor lama
   * dikembalikan tanpa memakai sequence. null bila profil alumni tidak ada. Nilai dari klien tidak pernah dipakai.
   *
   * N tidak pernah dipakai ulang (PRD 3.5, 6.4) termasuk setelah restore backup: penerapan ulang deletion ledger
   * (AC F14-6) menyimpan floor N (`account_deletions.ledger.member_seq_floor`) untuk penghapusan setelah titik backup.
   * Bila `nextval` belum melewati floor itu (sequence pulihan lebih tua), sequence dimajukan dengan `nextval` berulang
   * sampai di atas floor (API memegang USAGE, bukan UPDATE/setval); `currval` sesi tetap N yang ditulis. N yang
   * sudah dipasang Super Admin ke anggota lain (changeMemberSeq, ADR-028) dilewati dengan cara yang sama.
   */
  async allocateMemberNumber(tx: Tx, userId: string): Promise<string | null> {
    const [profile] = await tx.select().from(alumni).where(eq(alumni.userId, userId)).for("update");
    if (!profile) return null;
    if (profile.memberNumber) return profile.memberNumber;
    const [next] = rows<{ seq: string }>(
      await tx.execute(sql`select nextval('app.membership_no_seq')::text as seq`),
    );
    let seq = Number(next!.seq);
    const [retired] = rows<{ floor: string }>(
      await tx.execute(
        sql`select coalesce(max((ledger->>'member_seq_floor')::bigint), 0)::text as floor
            from app.account_deletions where ledger ? 'member_seq_floor'`,
      ),
    );
    const floor = Number(retired?.floor ?? 0);
    if (seq <= floor) {
      // Nilai terakhir yang diambil sesi ini adalah yang terbesar (nextval monoton), sama dengan currval.
      const [jumped] = rows<{ seq: string }>(
        await tx.execute(
          sql`select max(n)::text as seq
              from (select nextval('app.membership_no_seq') as n from generate_series(1, ${floor - seq + 1}::int)) s`,
        ),
      );
      seq = Number(jumped!.seq);
    }
    for (;;) {
      const [taken] = await tx
        .select({ userId: alumni.userId })
        .from(alumni)
        .where(eq(alumni.memberSeq, seq));
      if (!taken) break;
      const [skipped] = rows<{ seq: string }>(
        await tx.execute(sql`select nextval('app.membership_no_seq')::text as seq`),
      );
      seq = Number(skipped!.seq);
    }
    const number = memberNumber({
      cohort: profile.cohort,
      classIn: profile.classIn,
      classOut: profile.classOut,
      gender: profile.gender,
      seq,
    });
    await tx
      .update(alumni)
      .set({ memberSeq: seq, memberNumber: number, updatedAt: this.clock.now() })
      .where(and(eq(alumni.userId, userId), isNull(alumni.memberSeq)));
    return number;
  }

  // --------------------------------------------------------------------------------------------------- periode

  /**
   * Mengunci baris induk payment iuran sesuai URUTAN KUNCI kontrak C3 (kepala payments.yaml; PRD 6.4): baris users
   * pemilik lalu baris alumni-nya, SEBELUM `SELECT payments … FOR UPDATE`. Dipanggil hook `lockRelated` handler
   * registration/renewal (PaymentHandlerRegistry.lockRelated) dan oleh {@link applyPaidPayment} sendiri. Pemilik yang
   * sudah dihapus (user_id null) dilewati. Aman dipanggil ulang di transaksi yang sama (kunci sudah dipegang).
   */
  async lockPaymentOwner(tx: Tx, ownerUserId: string | null): Promise<void> {
    if (ownerUserId) await this.lockMember(tx, ownerUserId);
  }

  /**
   * Menerapkan payment registration/renewal yang sudah `paid` (PRD 3.7, ARCHITECTURE §3.2, §4.6) dalam transaksi
   * persetujuan:
   * - urutan kunci kontrak C3: pemilik dibaca TANPA kunci, lalu users → alumni pemilik → payment (tidak pernah
   *   mengunci users/alumni sesudah payment terkunci, sehingga tidak deadlock dengan penghapusan akun atau suspend);
   *   bila modul payments sudah memanggil `lockRelated`, kunci yang sama dipakai ulang tanpa menunggu;
   * - registration: periode mulai `approvedAt`, +12 bulan kalender Jakarta (AC F05-1);
   * - renewal: mulai `max(expires_at lama, approvedAt)` sehingga sisa masa aktif tidak hilang (AC F07-1, F07-2);
   * - satu membership_event per payment (UNIQUE payment_id): pemanggilan ulang/bersamaan untuk payment yang sama
   *   tidak memperpanjang dua kali (AC F04-5) → `already_applied`;
   * - pemilik sudah dihapus (F-14, D2) → `owner_deleted` tanpa efek keanggotaan (kontrak adminDecidePayment);
   * - suspend tidak dihapus (AC F07-4): periode diperbarui tetapi effective_status tetap suspended;
   * - audit di transaksi yang sama (AC F17-1). TIDAK menulis notifikasi: satu-satunya notifikasi keputusan adalah
   *   kategori `payment` (deep link /payments/{id}) yang ditulis modul payments di transaksi yang sama (AC F13-1:
   *   satu notification_id per keputusan); tanggal habis baru tersedia di `periodExpiresAt` (format formatDateWib).
   *
   * Kolom `alumni.starts_at/expires_at` menyimpan rentang keanggotaan BERJALAN yang bersambung: renewal sebelum habis
   * hanya memperpanjang `expires_at` (starts_at tetap), renewal setelah expired memulai rentang baru dari approvedAt.
   * Batas tiap periode tersimpan di membership_events (after_starts_at/after_expires_at).
   */
  async applyPaidPayment(tx: Tx, payment: Pick<PaymentRow, "id">, approvedAt: Date): Promise<AppliedPeriod> {
    assertCommitAware(tx, "MembershipKernel.applyPaidPayment");
    // Tingkat (0) urutan kunci: pemilik dibaca tanpa kunci, users lalu alumni dikunci, baru kemudian payment.
    const [unlocked] = await tx
      .select({ type: payments.type, userId: payments.userId })
      .from(payments)
      .where(eq(payments.id, payment.id))
      .limit(1);
    if (!unlocked) throw notFound("Pembayaran tidak ditemukan.");
    if (unlocked.type !== "registration" && unlocked.type !== "renewal")
      throw new Error(`applyPaidPayment hanya untuk iuran registration/renewal, bukan ${unlocked.type}`);
    const member = unlocked.userId ? await this.lockMember(tx, unlocked.userId) : undefined;

    const [current] = await tx.select().from(payments).where(eq(payments.id, payment.id)).for("update");
    if (!current) throw notFound("Pembayaran tidak ditemukan.");
    if (current.status !== "paid")
      throw conflict("Pembayaran belum berstatus paid.", {
        status: current.status,
        version: String(current.version),
      });
    const kind = current.type === "registration" ? "activation" : "renewal";

    const [existing] = await tx
      .select()
      .from(membershipEvents)
      .where(eq(membershipEvents.paymentId, current.id))
      .limit(1);
    if (existing)
      return {
        outcome: "already_applied",
        applied: false,
        kind,
        eventId: existing.id,
        periodStartsAt: existing.afterStartsAt!,
        periodExpiresAt: existing.afterExpiresAt!,
      };

    // Pemilik sudah dihapus (user_id menjadi NULL lewat ON DELETE SET NULL, akun `deleted`, atau profil alumni tidak
    // ada lagi): payment tetap paid tanpa membership_event; akun tidak dapat diaktifkan (kontrak adminDecidePayment).
    if (!current.userId || !member || member.userId !== current.userId || member.accountStatus === "deleted")
      return {
        outcome: "owner_deleted",
        applied: false,
        kind,
        eventId: null,
        periodStartsAt: null,
        periodExpiresAt: null,
      };
    if (!member.memberNumber) await this.allocateMemberNumber(tx, member.userId);

    let period: { startsAt: Date; expiresAt: Date };
    let runningStartsAt: Date;
    if (kind === "activation") {
      if (member.expiresAt)
        throw conflict("Keanggotaan sudah pernah diaktifkan; gunakan iuran perpanjangan.", {
          expires_at: member.expiresAt.toISOString(),
        });
      period = registrationPeriod(approvedAt);
      runningStartsAt = period.startsAt;
    } else {
      if (!member.expiresAt || !member.startsAt)
        throw conflict("Iuran pendaftaran belum disetujui; perpanjangan belum dapat diterapkan.");
      period = renewalPeriod(member.expiresAt, approvedAt);
      // Masih aktif saat disetujui → rentang bersambung; sudah expired → rentang baru dari approvedAt.
      runningStartsAt = member.expiresAt > approvedAt ? member.startsAt : period.startsAt;
    }

    const now = this.clock.now();
    await tx
      .update(alumni)
      .set({
        startsAt: runningStartsAt,
        expiresAt: period.expiresAt,
        version: sql`${alumni.version} + 1`,
        updatedAt: now,
      })
      .where(eq(alumni.userId, member.userId));
    const eventId = uuidv7();
    await tx.insert(membershipEvents).values({
      id: eventId,
      userId: member.userId,
      kind,
      paymentId: current.id,
      beforeStartsAt: member.startsAt,
      afterStartsAt: period.startsAt,
      beforeExpiresAt: member.expiresAt,
      afterExpiresAt: period.expiresAt,
      createdAt: now,
    });
    await this.audit.write(tx, {
      action: kind === "activation" ? "membership.activated" : "membership.renewed",
      entityType: "alumni",
      entityId: member.userId,
      before: { starts_at: member.startsAt, expires_at: member.expiresAt },
      after: {
        starts_at: runningStartsAt,
        expires_at: period.expiresAt,
        period_starts_at: period.startsAt,
        payment_id: current.id,
        approved_at: approvedAt,
      },
    });
    this.resyncRoomsAfterCommit(member.userId);
    return {
      outcome: "applied",
      applied: true,
      kind,
      eventId,
      periodStartsAt: period.startsAt,
      periodExpiresAt: period.expiresAt,
    };
  }

  // --------------------------------------------------------------------------------------------------- moderasi

  /**
   * Suspend anggota (AC F12-3, F12-4; kontrak adminSuspendMember dan adminResolveReport action suspend): tanggal
   * periode tidak dibuang (PRD 4.2); seluruh sesi dicabut dan session_version naik sehingga access token lama langsung
   * ditolak; setelah commit socket diputus dengan `session.revoked` (account_suspended). Direktori, chat, dan verifikasi
   * KTA otomatis menolak karena effective_status dihitung dari `suspended_at`. Alasan internal hanya di audit/histori;
   * anggota melihat `memberMessage` (notifikasi kategori account, rute /restricted). Audit `member.suspended`.
   * Prasyarat (400 VALIDATION_ERROR dengan `current` versi terkini): belum suspended dan akun tidak deletion_pending.
   */
  async suspend(
    tx: Tx,
    userId: string,
    input: SuspendInput,
  ): Promise<{ suspendedAt: Date; eventId: string; sessionsRevoked: number }> {
    assertCommitAware(tx, "MembershipKernel.suspend");
    const reason = input.reason.trim();
    const memberMessage = input.memberMessage.trim();
    if (reason.length === 0 || reason.length > 1000)
      throw fieldError("reason", "Alasan wajib diisi (maksimal 1.000 karakter).");
    if (memberMessage.length === 0 || memberMessage.length > 500)
      throw fieldError("member_message", "Pesan untuk anggota wajib diisi (maksimal 500 karakter).");
    const member = await this.lockMember(tx, userId);
    if (!member || member.accountStatus === "deleted") throw notFound("Anggota tidak ditemukan.");
    if (member.accountStatus === "deletion_pending")
      throw preconditionFailed("Akun sedang dalam proses penghapusan dan tidak dapat dibatasi.", member);
    if (member.suspendedAt) throw preconditionFailed("Anggota sudah dalam status dibatasi.", member);

    const now = this.clock.now();
    await tx
      .update(alumni)
      .set({
        suspendedAt: now,
        suspensionReason: reason,
        suspensionMessage: memberMessage,
        suspendedByAdminId: input.actorAdminId,
        version: sql`${alumni.version} + 1`,
        updatedAt: now,
      })
      .where(eq(alumni.userId, userId));
    const eventId = uuidv7();
    await tx.insert(membershipEvents).values({
      id: eventId,
      userId,
      kind: "suspend",
      actorAdminId: input.actorAdminId,
      reason,
      beforeStartsAt: member.startsAt,
      afterStartsAt: member.startsAt,
      beforeExpiresAt: member.expiresAt,
      afterExpiresAt: member.expiresAt,
      createdAt: now,
    });
    const revoked = await this.revokeAllSessions(tx, userId, now);
    await this.audit.write(tx, {
      action: "member.suspended",
      entityType: "alumni",
      entityId: userId,
      reason,
      before: { suspended_at: null },
      after: { suspended_at: now, suspension_message: memberMessage, sessions_revoked: revoked },
    });
    await this.notifications.notify(tx, {
      userId,
      category: "account",
      title: "Akun Anda dibatasi",
      body: memberMessage,
      route: "/restricted",
      dedupKey: `membership.suspended:${eventId}`,
    });
    this.realtime.disconnectUser(userId, "account_suspended");
    return { suspendedAt: now, eventId, sessionsRevoked: revoked };
  }

  /**
   * Mencabut suspend (AC F12-5; kontrak adminUnsuspendMember dan adminResolveReport action unsuspend): status dihitung
   * ulang dari expires_at, sehingga anggota yang masa aktifnya sudah habis menjadi expired dan yang belum pernah paid
   * menjadi unverified, bukan otomatis verified. Audit `member.unsuspended`. Prasyarat: sedang suspended (selain itu
   * 400 VALIDATION_ERROR dengan `current`). Mengembalikan effective_status baru dan banding yang ditutup.
   *
   * Satu fungsi untuk SETIAP jalur unsuspend (kontrak C2 adminUnsuspendMember langkah 2, C6 adminResolveReport
   * "ketergantungan lintas domain"): di bawah kunci users → alumni yang sama, setiap banding aktif anggota (reports
   * berkategori `appeal`, target_user_id = anggota, status open/in_review; dikunci FOR UPDATE setelah alumni) ditutup
   * sebagai DIKABULKAN: status resolved, action unsuspend, resolution_note (`appealResolutionNote` + alasan),
   * member_message = pesan untuk anggota (decision_message pemohon), resolved_by/resolved_at, version naik, audit
   * `moderation.report_resolved` per banding. Kecuali `excludeAppealId` (banding yang sedang diputus pemanggil).
   * SATU notifikasi kategori account memuat `memberMessage` (atau teks baku) dan menyatakan banding dikabulkan bila
   * `appealGranted` atau ada banding yang ditutup; tidak ada notifikasi ganda per banding.
   */
  async unsuspend(
    tx: Tx,
    userId: string,
    input: UnsuspendInput,
  ): Promise<{ effectiveStatus: EffectiveStatus; eventId: string; closedAppealIds: string[] }> {
    assertCommitAware(tx, "MembershipKernel.unsuspend");
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > 1000)
      throw fieldError("reason", "Alasan wajib diisi (maksimal 1.000 karakter).");
    const memberMessage = input.memberMessage?.trim() || DEFAULT_UNSUSPEND_MESSAGE;
    if (memberMessage.length > 500)
      throw fieldError("member_message", "Pesan untuk anggota maksimal 500 karakter.");
    const member = await this.lockMember(tx, userId);
    if (!member || member.accountStatus === "deleted") throw notFound("Anggota tidak ditemukan.");
    if (!member.suspendedAt) throw preconditionFailed("Anggota tidak sedang dibatasi.", member);
    const now = this.clock.now();
    await tx
      .update(alumni)
      .set({
        suspendedAt: null,
        suspensionReason: null,
        suspensionMessage: null,
        suspendedByAdminId: null,
        version: sql`${alumni.version} + 1`,
        updatedAt: now,
      })
      .where(eq(alumni.userId, userId));
    const eventId = uuidv7();
    await tx.insert(membershipEvents).values({
      id: eventId,
      userId,
      kind: "unsuspend",
      actorAdminId: input.actorAdminId,
      reason,
      beforeStartsAt: member.startsAt,
      afterStartsAt: member.startsAt,
      beforeExpiresAt: member.expiresAt,
      afterExpiresAt: member.expiresAt,
      createdAt: now,
    });
    const status = effectiveStatus(
      { accountStatus: member.accountStatus, expiresAt: member.expiresAt, suspendedAt: null },
      now,
    );
    const closedAppealIds = await this.closeActiveAppeals(tx, userId, {
      note: input.appealResolutionNote?.trim() || DEFAULT_APPEAL_GRANTED_NOTE,
      reason,
      memberMessage,
      actorAdminId: input.actorAdminId,
      excludeId: input.excludeAppealId ?? null,
      unsuspendEventId: eventId,
      now,
    });
    const appealGranted = input.appealGranted === true || closedAppealIds.length > 0;
    await this.audit.write(tx, {
      action: "member.unsuspended",
      entityType: "alumni",
      entityId: userId,
      reason,
      before: { suspended_at: member.suspendedAt },
      after: {
        suspended_at: null,
        effective_status: status,
        appeal_granted: appealGranted,
        closed_appeal_ids: closedAppealIds,
      },
    });
    const active = status === "verified" || status === "expiring";
    const guidance = active
      ? "Akses anggota Anda telah dipulihkan."
      : status === "expired"
        ? "Masa keanggotaan Anda telah berakhir. Perpanjang untuk kembali aktif."
        : "Selesaikan iuran pendaftaran untuk mengaktifkan KTA.";
    const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
    await this.notifications.notify(tx, {
      userId,
      category: "account",
      title: appealGranted ? "Banding dikabulkan" : "Pembatasan akun dicabut",
      body: [appealGranted ? "Banding Anda dikabulkan." : null, sentence(memberMessage), guidance]
        .filter(Boolean)
        .join(" "),
      route: active ? "/kta" : status === "expired" ? "/renewal" : "/onboarding/fees",
      dedupKey: `membership.unsuspended:${eventId}`,
    });
    this.resyncRoomsAfterCommit(userId);
    return { effectiveStatus: status, eventId, closedAppealIds };
  }

  /**
   * Menutup banding aktif anggota sebagai dikabulkan di transaksi unsuspend (kontrak C2 adminUnsuspendMember langkah 2,
   * C6 adminResolveReport). Baris laporan dikunci SESUDAH users → alumni (urutan yang sama dengan keputusan moderasi
   * dan POST /appeals) lalu diperbarui bersyarat status, sehingga banding yang sudah diputus pengurus lain tidak
   * ditimpa. Audit per banding tanpa menyalin isi bukti (ARCHITECTURE §2 butir 3).
   */
  private async closeActiveAppeals(
    tx: Tx,
    userId: string,
    input: {
      note: string;
      reason: string;
      memberMessage: string;
      actorAdminId: string | null;
      excludeId: string | null;
      unsuspendEventId: string;
      now: Date;
    },
  ): Promise<string[]> {
    const active = await tx
      .select({ id: reports.id, status: reports.status, version: reports.version })
      .from(reports)
      .where(
        and(
          eq(reports.category, "appeal"),
          eq(reports.targetUserId, userId),
          inArray(reports.status, ["open", "in_review"]),
          input.excludeId ? ne(reports.id, input.excludeId) : undefined,
        ),
      )
      .orderBy(asc(reports.id))
      .for("update");
    const full = `${input.note} Alasan: ${input.reason}`;
    const note =
      full.length > RESOLUTION_NOTE_MAX ? `${full.slice(0, RESOLUTION_NOTE_MAX - 1).trimEnd()}…` : full;
    const closed: string[] = [];
    for (const appeal of active) {
      const [updated] = await tx
        .update(reports)
        .set({
          status: "resolved",
          action: "unsuspend",
          resolutionNote: note,
          memberMessage: input.memberMessage,
          resolvedByAdminId: input.actorAdminId,
          resolvedAt: input.now,
          version: sql`${reports.version} + 1`,
          updatedAt: input.now,
        })
        .where(and(eq(reports.id, appeal.id), inArray(reports.status, ["open", "in_review"])))
        .returning({ id: reports.id, version: reports.version });
      if (!updated) continue;
      closed.push(updated.id);
      await this.audit.write(tx, {
        action: "moderation.report_resolved",
        entityType: "report",
        entityId: updated.id,
        reason: note,
        before: { status: appeal.status, version: appeal.version },
        after: {
          status: "resolved",
          action: "unsuspend",
          outcome: "action_taken",
          version: updated.version,
          closed_by_unsuspend: true,
          membership_event_id: input.unsuspendEventId,
        },
      });
    }
    return closed;
  }

  /**
   * Setelah commit yang dapat memulihkan status aktif (periode baru, unsuspend), socket pengguna dimasukkan ulang ke
   * kanal room joined-nya sesuai status efektif TERBARU (kontrak C6 "Pencabutan langganan room" butir 5).
   */
  private resyncRoomsAfterCommit(userId: string): void {
    afterCommit(async () => {
      const snapshot = await this.effectiveStatusFor(userId);
      this.realtime.syncRoomSubscriptions(userId, snapshot?.status ?? null);
    });
  }

  // ------------------------------------------------------------------------------------------- koreksi identitas

  /**
   * Koreksi angkatan/kelas/jenis kelamin oleh pengurus `members.manage` (PRD 3.5, AC F05-6; kontrak adminUpdateMember):
   * prefix AA.SS.JK dihitung ulang, N tetap, segmen dan nomor ditulis dalam SATU UPDATE (alumni_member_number_chk),
   * histori `number_correction` + audit `member.number_corrected` dengan nomor lama/baru bila nomor berubah (selain itu
   * audit `member.identity_corrected`), notifikasi kategori membership (rute /kta). QR lama menjadi "perlu diperbarui"
   * karena verifikasi publik mensyaratkan nomor TERKINI (qrBindingMatches). Nomor dari klien tidak pernah diterima.
   * Akun deletion_pending tidak dapat diubah (400). `expectedVersion` (If-Match) opsional → 409 VERSION_CONFLICT
   * dengan keadaan terbaru.
   */
  async correctIdentity(
    tx: Tx,
    userId: string,
    changes: IdentityChanges,
    actor: { adminId: string | null },
    reason: string,
    options: { expectedVersion?: number } = {},
  ): Promise<IdentityCorrection> {
    assertCommitAware(tx, "MembershipKernel.correctIdentity");
    const trimmed = reason.trim();
    if (trimmed.length === 0 || trimmed.length > 1000)
      throw fieldError("reason", "Alasan koreksi wajib diisi (maksimal 1.000 karakter).");
    const member = await this.lockMember(tx, userId);
    if (!member || member.accountStatus === "deleted") throw notFound("Anggota tidak ditemukan.");
    const snapshot = (m: Pick<AlumniRow, "cohort" | "classIn" | "classOut" | "gender" | "memberNumber">) => ({
      cohort: m.cohort,
      class_in: m.classIn,
      class_out: m.classOut,
      gender: m.gender,
      member_number: m.memberNumber,
    });
    if (options.expectedVersion !== undefined && options.expectedVersion !== member.version)
      throw versionConflict({ ...snapshot(member), version: String(member.version) });
    if (member.accountStatus === "deletion_pending")
      throw preconditionFailed("Akun sedang dalam proses penghapusan dan tidak dapat diubah.", member);

    const next = {
      cohort: changes.cohort ?? member.cohort,
      classIn: changes.classIn ?? member.classIn,
      classOut: changes.classOut ?? member.classOut,
      gender: changes.gender ?? member.gender,
    };
    const now = this.clock.now();
    if (!Number.isInteger(next.cohort) || next.cohort < 1 || next.cohort > latestCohort(now))
      throw fieldError("cohort", `Angkatan harus 1 sampai ${latestCohort(now)}.`);
    try {
      assertClasses(next.classIn, next.classOut);
    } catch (error) {
      if (error instanceof InvalidAcademicDataError) throw fieldError("class_out", error.message);
      throw error;
    }
    if (
      next.cohort === member.cohort &&
      next.classIn === member.classIn &&
      next.classOut === member.classOut &&
      next.gender === member.gender
    )
      return {
        changed: false,
        previousMemberNumber: member.memberNumber,
        memberNumber: member.memberNumber,
        version: member.version,
      };

    const number = member.memberSeq ? memberNumber({ ...next, seq: member.memberSeq }) : null;
    const numberChanged = !!member.memberNumber && !!number && number !== member.memberNumber;
    const [updated] = await tx
      .update(alumni)
      .set({
        cohort: next.cohort,
        classIn: next.classIn,
        classOut: next.classOut,
        gender: next.gender,
        memberNumber: number,
        version: sql`${alumni.version} + 1`,
        updatedAt: now,
      })
      .where(eq(alumni.userId, userId))
      .returning({ version: alumni.version });
    if (numberChanged)
      await tx.insert(membershipEvents).values({
        id: uuidv7(),
        userId,
        kind: "number_correction",
        actorAdminId: actor.adminId,
        reason: trimmed,
        beforeMemberNumber: member.memberNumber,
        afterMemberNumber: number,
        createdAt: now,
      });
    const auditId = await this.audit.write(tx, {
      action: numberChanged ? "member.number_corrected" : "member.identity_corrected",
      entityType: "alumni",
      entityId: userId,
      reason: trimmed,
      before: snapshot(member),
      after: snapshot({ ...next, memberNumber: number }),
    });
    await this.notifications.notify(tx, {
      userId,
      category: "membership",
      title: "Data keanggotaan diperbarui",
      body: numberChanged
        ? `Pengurus mengoreksi data angkatan/kelas Anda. Nomor anggota Anda kini ${number}.`
        : "Pengurus mengoreksi data angkatan/kelas Anda.",
      route: "/kta",
      dedupKey: `membership.identity_corrected:${auditId}`,
    });
    return {
      changed: true,
      previousMemberNumber: member.memberNumber,
      memberNumber: number,
      version: updated!.version,
    };
  }

  /**
   * Super Admin mengubah nomor urut N anggota yang sudah bernomor (ADR-028; kontrak adminChangeMemberSeq). N bekas
   * akun terhapus boleh dipakai lagi; N yang sedang dipakai anggota lain ditolak (400 pada `member_seq`, indeks
   * alumni_member_seq_key menjaga balapan). Segmen AA.SS.JK tetap; seq dan nomor ditulis dalam SATU UPDATE setelah
   * flag transaksi `kapdh.member_seq` = admin (trigger alumni_guard_member_seq, migrasi 0011). Histori
   * `number_correction`, audit `member.number_corrected`, notifikasi /kta; QR lama menjadi "perlu diperbarui".
   */
  async changeMemberSeq(
    tx: Tx,
    userId: string,
    seq: number,
    actor: { adminId: string | null },
    reason: string,
    options: { expectedVersion?: number } = {},
  ): Promise<IdentityCorrection> {
    assertCommitAware(tx, "MembershipKernel.changeMemberSeq");
    const trimmed = reason.trim();
    if (trimmed.length === 0 || trimmed.length > 1000)
      throw fieldError("reason", "Alasan perubahan wajib diisi (maksimal 1.000 karakter).");
    if (!Number.isSafeInteger(seq) || seq < 1)
      throw fieldError("member_seq", "Nomor urut harus bilangan bulat positif.");
    const member = await this.lockMember(tx, userId);
    if (!member || member.accountStatus === "deleted") throw notFound("Anggota tidak ditemukan.");
    const snapshot = (m: Pick<AlumniRow, "memberSeq" | "memberNumber">) => ({
      member_seq: m.memberSeq,
      member_number: m.memberNumber,
    });
    if (options.expectedVersion !== undefined && options.expectedVersion !== member.version)
      throw versionConflict({ ...snapshot(member), version: String(member.version) });
    if (member.accountStatus === "deletion_pending")
      throw preconditionFailed("Akun sedang dalam proses penghapusan dan tidak dapat diubah.", member);
    if (member.memberSeq === null || member.memberNumber === null)
      throw preconditionFailed(
        "Anggota belum bernomor. Nomor urut diterbitkan otomatis saat akun diaktifkan.",
        member,
      );
    if (member.memberSeq === seq)
      throw fieldError("member_seq", "Nomor urut baru sama dengan nomor urut saat ini.");
    const [holder] = await tx
      .select({ memberNumber: alumni.memberNumber })
      .from(alumni)
      .where(eq(alumni.memberSeq, seq));
    if (holder)
      throw fieldError(
        "member_seq",
        `Nomor urut ${seq} sedang dipakai anggota lain (${holder.memberNumber}).`,
      );

    const number = memberNumber({ ...member, seq });
    const now = this.clock.now();
    await tx.execute(sql`select set_config('kapdh.member_seq', 'admin', true)`);
    const [updated] = await tx
      .update(alumni)
      .set({ memberSeq: seq, memberNumber: number, version: sql`${alumni.version} + 1`, updatedAt: now })
      .where(eq(alumni.userId, userId))
      .returning({ version: alumni.version });
    await tx.execute(sql`select set_config('kapdh.member_seq', '', true)`);
    await tx.insert(membershipEvents).values({
      id: uuidv7(),
      userId,
      kind: "number_correction",
      actorAdminId: actor.adminId,
      reason: trimmed,
      beforeMemberNumber: member.memberNumber,
      afterMemberNumber: number,
      createdAt: now,
    });
    const auditId = await this.audit.write(tx, {
      action: "member.number_corrected",
      entityType: "alumni",
      entityId: userId,
      reason: trimmed,
      before: snapshot(member),
      after: snapshot({ memberSeq: seq, memberNumber: number }),
    });
    await this.notifications.notify(tx, {
      userId,
      category: "membership",
      title: "Nomor anggota diperbarui",
      body: `Pengurus mengubah nomor anggota Anda menjadi ${number}. Buka KTA untuk memuat QR terbaru.`,
      route: "/kta",
      dedupKey: `membership.number_changed:${auditId}`,
    });
    return {
      changed: true,
      previousMemberNumber: member.memberNumber,
      memberNumber: number,
      version: updated!.version,
    };
  }

  // ---------------------------------------------------------------------------------------------------- internal

  /**
   * Mengunci baris users (FOR NO KEY UPDATE) lalu alumni (FOR UPDATE): tingkat (0) URUTAN KUNCI kontrak C3/C5 dan
   * urutan yang sama dengan verifikasi OTP, suspend dan penghapusan akun (users → alumni → events → tickets →
   * payments), sehingga tidak ada deadlock 40P01. Hanya akun berjenis alumni; selain itu undefined (baris users tetap
   * terkunci sampai akhir transaksi).
   */
  private async lockMember(tx: Tx, userId: string) {
    const [user] = await tx
      .select({ status: users.status, kind: users.kind })
      .from(users)
      .where(eq(users.id, userId))
      .for("no key update");
    if (!user || user.kind !== "alumni") return undefined;
    const [member] = await tx
      .select({
        userId: alumni.userId,
        cohort: alumni.cohort,
        classIn: alumni.classIn,
        classOut: alumni.classOut,
        gender: alumni.gender,
        memberSeq: alumni.memberSeq,
        memberNumber: alumni.memberNumber,
        startsAt: alumni.startsAt,
        expiresAt: alumni.expiresAt,
        suspendedAt: alumni.suspendedAt,
        version: alumni.version,
      })
      .from(alumni)
      .where(eq(alumni.userId, userId))
      .for("update");
    return member ? { ...member, accountStatus: user.status as AccountStatus } : undefined;
  }

  /** Mencabut semua sesi aktif dan menaikkan session_version (pola logout semua perangkat, AC F02-6). */
  private async revokeAllSessions(tx: Tx, userId: string, now: Date): Promise<number> {
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
}
