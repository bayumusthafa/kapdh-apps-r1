import { Inject, Injectable } from "@nestjs/common";
import { alumni, membershipEvents, payments, sessions, users } from "@kapdh/database";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../adapters/clock.js";
import { AuditService } from "../audit/audit.service.js";
import { rows } from "../db/rows.js";
import { assertCommitAware } from "../db/tx.js";
import type { Db, DbOrTx, Tx } from "../db/types.js";
import { AppException, fieldError, notFound, versionConflict } from "../errors/app-exception.js";
import { NotificationService } from "../notifications-kernel/notification.service.js";
import { RealtimeService } from "../realtime/realtime.service.js";
import { CLOCK, DB } from "../tokens.js";
import { assertMemberAccess, type MemberAccessLevel, memberAccessAllows } from "./access.js";
import { type AccountStatus, effectiveStatus, type EffectiveStatus } from "./effective-status.js";
import { formatDateWib } from "./format.js";
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

export interface AppliedPeriod {
  /** false = payment ini sudah pernah diterapkan (idempoten; tidak ada perubahan). */
  applied: boolean;
  kind: "activation" | "renewal";
  eventId: string;
  /** Awal dan akhir periode milik payment ini (membership_events.after_*). */
  periodStartsAt: Date;
  periodExpiresAt: Date;
}

export interface SuspendInput {
  /** Alasan internal pengurus (audit, membership_events); tidak pernah ditampilkan ke anggota atau publik. */
  reason: string;
  /** Pesan aman yang ditampilkan di portal pembatasan (PRD 2.2). */
  memberMessage: string;
  actorAdminId: string | null;
}

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

/** Angkatan terbaru menurut tahun Jakarta: 30 pada 2026 (PRD 3.5). */
export function latestCohort(now: Date): number {
  return jakartaYear(now) - COHORT_BASE_YEAR;
}

/**
 * Kernel keanggotaan (ARCHITECTURE §3.1, §3.2, §4.2): satu-satunya penulis kolom keanggotaan di `alumni` (nomor,
 * periode, suspend) di luar profil. Semua metode transaksional menerima `tx` dari withTx/TxRunner (diperiksa
 * {@link assertCommitAware}) karena efek realtime/notifikasi dijadwalkan setelah commit. Setiap perubahan mengunci
 * baris alumni (`SELECT … FOR UPDATE`) lalu menulis audit dan histori pada transaksi yang sama (AC F17-1).
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
   */
  async allocateMemberNumber(tx: Tx, userId: string): Promise<string | null> {
    const [profile] = await tx.select().from(alumni).where(eq(alumni.userId, userId)).for("update");
    if (!profile) return null;
    if (profile.memberNumber) return profile.memberNumber;
    const [next] = rows<{ seq: string }>(
      await tx.execute(sql`select nextval('app.membership_no_seq')::text as seq`),
    );
    const seq = Number(next!.seq);
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
   * Menerapkan payment registration/renewal yang sudah `paid` (PRD 3.7, ARCHITECTURE §3.2, §4.6) dalam transaksi
   * persetujuan:
   * - registration: periode mulai `approvedAt`, +12 bulan kalender Jakarta (AC F05-1);
   * - renewal: mulai `max(expires_at lama, approvedAt)` sehingga sisa masa aktif tidak hilang (AC F07-1, F07-2);
   * - satu membership_event per payment (UNIQUE payment_id): pemanggilan ulang/bersamaan untuk payment yang sama
   *   tidak memperpanjang dua kali (AC F04-5); baris payment lalu alumni dikunci berurutan;
   * - suspend tidak dihapus (AC F07-4): periode diperbarui tetapi effective_status tetap suspended;
   * - audit + notifikasi kategori `membership` (inbox + outbox) dalam transaksi yang sama (AC F04-1).
   *
   * Kolom `alumni.starts_at/expires_at` menyimpan rentang keanggotaan BERJALAN yang bersambung: renewal sebelum habis
   * hanya memperpanjang `expires_at` (starts_at tetap), renewal setelah expired memulai rentang baru dari approvedAt.
   * Batas tiap periode tersimpan di membership_events (after_starts_at/after_expires_at).
   */
  async applyPaidPayment(tx: Tx, payment: Pick<PaymentRow, "id">, approvedAt: Date): Promise<AppliedPeriod> {
    assertCommitAware(tx, "MembershipKernel.applyPaidPayment");
    const [current] = await tx.select().from(payments).where(eq(payments.id, payment.id)).for("update");
    if (!current) throw notFound("Pembayaran tidak ditemukan.");
    if (current.type !== "registration" && current.type !== "renewal")
      throw new Error(`applyPaidPayment hanya untuk iuran registration/renewal, bukan ${current.type}`);
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
        applied: false,
        kind,
        eventId: existing.id,
        periodStartsAt: existing.afterStartsAt!,
        periodExpiresAt: existing.afterExpiresAt!,
      };
    if (!current.userId) throw conflict("Pemilik pembayaran sudah tidak ada.");

    const member = await this.lockMember(tx, current.userId);
    if (!member) throw conflict("Profil anggota pemilik pembayaran tidak ditemukan.");
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
    const until = formatDateWib(period.expiresAt);
    await this.notifications.notify(tx, {
      userId: member.userId,
      category: "membership",
      title: kind === "activation" ? "KTA Anda aktif" : "Keanggotaan diperpanjang",
      body:
        kind === "activation"
          ? `Iuran pendaftaran telah diverifikasi. KTA berlaku sampai ${until}.`
          : `Iuran perpanjangan telah diverifikasi. KTA kini berlaku sampai ${until}.`,
      route: "/kta",
      dedupKey: `membership.period:${current.id}`,
    });
    return {
      applied: true,
      kind,
      eventId,
      periodStartsAt: period.startsAt,
      periodExpiresAt: period.expiresAt,
    };
  }

  // --------------------------------------------------------------------------------------------------- moderasi

  /**
   * Suspend anggota (AC F12-3, F12-4): tanggal periode tidak dibuang (PRD 4.2); seluruh sesi dicabut dan
   * session_version naik sehingga access token lama langsung ditolak; setelah commit socket diputus dengan
   * `session.revoked` (account_suspended). Direktori, chat, dan verifikasi KTA otomatis menolak karena effective_status
   * dihitung dari `suspended_at`. Alasan internal hanya di audit/histori; anggota melihat `memberMessage`.
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
    if (!member) throw notFound("Anggota tidak ditemukan.");
    if (member.suspendedAt)
      throw new AppException(409, "VERSION_CONFLICT", "Anggota sudah dalam status dibatasi.", {
        current: { suspended_at: member.suspendedAt.toISOString(), version: String(member.version) },
      });

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
      action: "membership.suspended",
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
   * Mencabut suspend (AC F12-5): status dihitung ulang dari expires_at, sehingga anggota yang masa aktifnya sudah habis
   * menjadi expired, bukan otomatis verified. Mengembalikan effective_status baru.
   */
  async unsuspend(
    tx: Tx,
    userId: string,
    input: { reason: string; actorAdminId: string | null },
  ): Promise<{ effectiveStatus: EffectiveStatus; eventId: string }> {
    assertCommitAware(tx, "MembershipKernel.unsuspend");
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > 1000)
      throw fieldError("reason", "Alasan wajib diisi (maksimal 1.000 karakter).");
    const member = await this.lockMember(tx, userId);
    if (!member) throw notFound("Anggota tidak ditemukan.");
    if (!member.suspendedAt)
      throw new AppException(409, "VERSION_CONFLICT", "Anggota tidak sedang dibatasi.", {
        current: { suspended_at: null, version: String(member.version) },
      });
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
    await this.audit.write(tx, {
      action: "membership.unsuspended",
      entityType: "alumni",
      entityId: userId,
      reason,
      before: { suspended_at: member.suspendedAt },
      after: { suspended_at: null, effective_status: status },
    });
    const active = status === "verified" || status === "expiring";
    await this.notifications.notify(tx, {
      userId,
      category: "account",
      title: "Pembatasan akun dicabut",
      body: active
        ? "Akses anggota Anda telah dipulihkan."
        : status === "expired"
          ? "Pembatasan dicabut, tetapi masa keanggotaan Anda telah berakhir. Perpanjang untuk kembali aktif."
          : "Pembatasan dicabut. Selesaikan iuran pendaftaran untuk mengaktifkan KTA.",
      route: active ? "/kta" : status === "expired" ? "/renewal" : "/onboarding/fees",
      dedupKey: `membership.unsuspended:${eventId}`,
    });
    return { effectiveStatus: status, eventId };
  }

  // ------------------------------------------------------------------------------------------- koreksi identitas

  /**
   * Koreksi angkatan/kelas/jenis kelamin oleh pengurus `members.manage` (PRD 3.5, AC F05-6): prefix AA.SS.JK dihitung
   * ulang, N tetap, segmen dan nomor ditulis dalam SATU UPDATE (alumni_member_number_chk), histori
   * `number_correction` + audit nomor lama/baru. Token QR terikat user_id + N (bukan prefix), sehingga kartu berikutnya
   * memuat nomor baru dan verifikasi tidak salah sasaran. Nomor dari klien tidak pernah diterima.
   * `expectedVersion` (If-Match) opsional → 409 VERSION_CONFLICT dengan keadaan terbaru.
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
    if (!member) throw notFound("Anggota tidak ditemukan.");
    const snapshot = (m: Pick<AlumniRow, "cohort" | "classIn" | "classOut" | "gender" | "memberNumber">) => ({
      cohort: m.cohort,
      class_in: m.classIn,
      class_out: m.classOut,
      gender: m.gender,
      member_number: m.memberNumber,
    });
    if (options.expectedVersion !== undefined && options.expectedVersion !== member.version)
      throw versionConflict({ ...snapshot(member), version: String(member.version) });

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
    if (member.memberNumber && number && number !== member.memberNumber)
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
      action: "membership.identity_corrected",
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
      body:
        number && number !== member.memberNumber
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

  // ---------------------------------------------------------------------------------------------------- internal

  /**
   * Mengunci baris users lalu alumni (urutan yang sama dengan AuthService: users → alumni, sehingga tidak ada
   * deadlock dengan verifikasi OTP). Hanya akun berjenis alumni.
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
