import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { admins, alumni, events, tickets, users } from "@kapdh/database";
import { and, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { AuditService } from "../../core/audit/audit.service.js";
import type { Db } from "../../core/db/types.js";
import { AppException, notFound } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { cohortCode } from "../../core/membership/member-number.js";
import { DB } from "../../core/tokens.js";
import {
  type CheckinRejectionReason,
  checkinRejection,
  checkinRejectionCode,
  checkinRejectionMessage,
  checkinWindow,
  type EventRow,
  formatEventDateTime,
  type HolderState,
  projectedTicketStatus,
  type TicketRow,
} from "./event-rules.js";
import { EventViews } from "./event-views.js";

type Schemas = components["schemas"];

export const checkinSchema = z.object({
  event_id: z.uuid("Pilih event yang sedang dipindai"),
  qr_code: z
    .string({ message: "Isi QR wajib dikirim" })
    .trim()
    .min(1, "Isi QR wajib dikirim")
    .max(256, "Isi QR terlalu panjang"),
});

/** Maksimal event pada daftar pemindaian (kontrak adminListCheckinEvents). */
const CHECKIN_EVENTS_LIMIT = 50;
const CHECKIN_LOOKAHEAD_MS = 24 * 3600_000;

interface ScanState {
  ticket: TicketRow;
  ticketEvent: EventRow;
  holder: HolderState & {
    fullName: string | null;
    memberNumber: string | null;
    cohort: number | null;
    avatarFileId: string | null;
  };
}

/**
 * Check-in tiket oleh petugas events.checkin (kontrak adminListCheckinEvents dan adminCheckInTicket; AC F09-5, F09-6,
 * D5, PRD 2.2, 4.5). Tiket dan event dibaca tanpa kunci, pemeriksaan berurutan dijalankan, lalu satu UPDATE bersyarat
 * `status='paid' AND checked_in_at IS NULL` mencatat waktu dan petugas bersama audit `ticket.checked_in`. Bila UPDATE
 * tidak mengenai baris (scan paralel, pembatalan tiket/event), keadaan terbaru dibaca ulang dan alasan yang sesuai
 * dikembalikan, mis. "Sudah check-in" beserta waktu dan petugas sebelumnya, tanpa menambah hitungan.
 */
@Injectable()
export class CheckinService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly views: EventViews,
    private readonly audit: AuditService,
  ) {}

  /** Event open/closed yang jendela check-in efektifnya belum berakhir dan dibuka <= 24 jam lagi (D5). */
  async events(): Promise<Schemas["AdminCheckinEventList"]> {
    const now = this.views.now();
    const setting = await this.views.eventsSetting();
    const nowSql = sql`${now.toISOString()}::timestamptz`;
    const horizonSql = sql`${new Date(now.getTime() + CHECKIN_LOOKAHEAD_MS).toISOString()}::timestamptz`;
    const opensSql = sql`coalesce(${events.checkinOpensAt}, ${events.startsAt} - make_interval(hours => ${setting.checkin_before_hours}::int))`;
    // Sama dengan checkinWindow: override tidak pernah melewati ends_at (D5).
    const closesSql = sql`least(coalesce(${events.checkinClosesAt}, ${events.endsAt}), ${events.endsAt})`;
    const rows = await this.db
      .select()
      .from(events)
      .where(
        and(
          inArray(events.status, ["open", "closed"]),
          sql`${closesSql} > ${nowSql}`,
          sql`${opensSql} <= ${horizonSql}`,
        ),
      )
      .orderBy(sql`${opensSql} asc`, events.id)
      .limit(CHECKIN_EVENTS_LIMIT);
    const checkedIn = await this.views.checkedInCounts(
      this.db,
      rows.map((row) => row.id),
    );
    return {
      items: rows.map((event) => {
        const window = checkinWindow(event, setting.checkin_before_hours);
        return {
          id: event.id,
          title: event.title,
          starts_at: event.startsAt.toISOString(),
          ends_at: event.endsAt.toISOString(),
          timezone: event.timezone,
          location_name: event.locationName,
          status: event.status,
          checkin_opens_at: window.opensAt.toISOString(),
          checkin_closes_at: window.closesAt.toISOString(),
          checkin_open:
            now.getTime() >= window.opensAt.getTime() && now.getTime() <= window.closesAt.getTime(),
          paid_count: event.paidQuantity,
          checked_in_count: checkedIn.get(event.id) ?? 0,
        };
      }),
    };
  }

  async checkIn(
    auth: AuthContext,
    input: z.infer<typeof checkinSchema>,
  ): Promise<Schemas["AdminCheckinResult"]> {
    const [requested] = await this.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, input.event_id))
      .limit(1);
    if (!requested) throw notFound("Event yang dipilih tidak ditemukan.");
    const setting = await this.views.eventsSetting();
    // Dua putaran: putaran kedua hanya terjadi bila UPDATE bersyarat kalah dari perubahan bersamaan yang ternyata
    // masih mengizinkan check-in (mis. persetujuan pembayaran baru saja commit).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = await this.load(input.qr_code);
      if (!state) throw notFound("QR bukan tiket KAPDH.");
      const now = this.views.now();
      const window = checkinWindow(state.ticketEvent, setting.checkin_before_hours);
      const rejection = checkinRejection({
        requestedEventId: input.event_id,
        ticket: state.ticket,
        event: state.ticketEvent,
        holder: state.holder,
        window,
        now,
      });
      if (rejection) throw await this.rejected(rejection, state, window, auth);
      const updated = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(tickets)
          .set({
            checkedInAt: now,
            checkedInByAdminId: auth.adminId,
            version: sql`${tickets.version} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(tickets.id, state.ticket.id),
              eq(tickets.status, "paid"),
              isNull(tickets.checkedInAt),
              eq(tickets.eventId, input.event_id),
              sql`exists (select 1 from ${events} where ${events.id} = ${tickets.eventId} and ${events.status} in ('open', 'closed'))`,
            ),
          )
          .returning();
        if (!row) return null;
        await this.audit.write(tx, {
          action: "ticket.checked_in",
          entityType: "ticket",
          entityId: row.id,
          after: { event_id: row.eventId, checked_in_at: now, version: row.version },
        });
        return row;
      });
      if (!updated) continue;
      const [checked] = await this.db
        .select({ n: count() })
        .from(tickets)
        .where(and(eq(tickets.eventId, input.event_id), isNotNull(tickets.checkedInAt)));
      const [fresh] = await this.db
        .select({ paid: events.paidQuantity })
        .from(events)
        .where(eq(events.id, input.event_id));
      const actor = { admin_id: auth.adminId, display_name: await this.adminName(auth.adminId) };
      return {
        ticket: await this.ticketDto({ ...state, ticket: updated }, auth, actor),
        checked_in_at: now.toISOString(),
        checked_in_by: actor,
        event_checked_in_count: Number(checked?.n ?? 0),
        event_paid_count: fresh?.paid ?? 0,
      };
    }
    // Keadaan berubah terus di antara baca dan tulis: kembalikan alasan dari keadaan terakhir.
    const state = await this.load(input.qr_code);
    if (!state) throw notFound("QR bukan tiket KAPDH.");
    const window = checkinWindow(state.ticketEvent, setting.checkin_before_hours);
    const reason =
      checkinRejection({
        requestedEventId: input.event_id,
        ticket: state.ticket,
        event: state.ticketEvent,
        holder: state.holder,
        window,
        now: this.views.now(),
      }) ?? "already_checked_in";
    throw await this.rejected(reason, state, window, auth);
  }

  /** Tiket berdasarkan isi QR (persis), event tiket dan keadaan pemegang; null bila QR tidak dikenal. */
  private async load(qrCode: string): Promise<ScanState | null> {
    const [row] = await this.db
      .select({
        ticket: tickets,
        event: events,
        accountStatus: users.status,
        fullName: alumni.fullName,
        memberNumber: alumni.memberNumber,
        cohort: alumni.cohort,
        avatarFileId: alumni.avatarFileId,
        suspendedAt: alumni.suspendedAt,
      })
      .from(tickets)
      .innerJoin(events, eq(events.id, tickets.eventId))
      .leftJoin(users, eq(users.id, tickets.userId))
      .leftJoin(alumni, eq(alumni.userId, tickets.userId))
      .where(eq(tickets.qrCode, qrCode.trim()))
      .limit(1);
    if (!row) return null;
    const deleted = !row.accountStatus || row.accountStatus === "deleted";
    return {
      ticket: row.ticket,
      ticketEvent: row.event,
      holder: {
        accountStatus: row.accountStatus ?? null,
        suspended: row.suspendedAt !== null,
        fullName: deleted ? null : row.fullName,
        memberNumber: deleted ? null : row.memberNumber,
        cohort: deleted ? null : row.cohort,
        avatarFileId: deleted ? null : row.avatarFileId,
      },
    };
  }

  private async adminName(adminId: string | null): Promise<string> {
    if (!adminId) return "Pengurus (akun dihapus)";
    const [row] = await this.db
      .select({ name: admins.displayName })
      .from(admins)
      .where(eq(admins.id, adminId))
      .limit(1);
    return row?.name ?? "Pengurus (akun dihapus)";
  }

  private async ticketDto(
    state: ScanState,
    auth: AuthContext,
    checkedInBy?: Schemas["AdminEventActor"],
  ): Promise<Schemas["AdminCheckinTicket"]> {
    const avatars = await this.views.avatarUrls(this.db, [state.holder.avatarFileId], auth);
    const by =
      checkedInBy ??
      (state.ticket.checkedInAt
        ? {
            admin_id: state.ticket.checkedInByAdminId,
            display_name: await this.adminName(state.ticket.checkedInByAdminId),
          }
        : null);
    return {
      ticket_id: state.ticket.id,
      status: projectedTicketStatus(state.ticket, this.views.now()),
      event: {
        id: state.ticketEvent.id,
        title: state.ticketEvent.title,
        starts_at: state.ticketEvent.startsAt.toISOString(),
        timezone: state.ticketEvent.timezone,
      },
      holder: {
        full_name: state.holder.fullName,
        member_number: state.holder.memberNumber,
        cohort_code: state.holder.cohort !== null ? cohortCode(state.holder.cohort) : null,
        avatar_url: state.holder.avatarFileId ? (avatars.get(state.holder.avatarFileId) ?? null) : null,
      },
      checked_in_at: state.ticket.checkedInAt?.toISOString() ?? null,
      checked_in_by: by,
    };
  }

  /** 409 dengan Error baku dan `current` = AdminCheckinRejectionDetail (AC F09-6). */
  private async rejected(
    reason: CheckinRejectionReason,
    state: ScanState,
    window: { opensAt: Date; closesAt: Date },
    auth: AuthContext,
  ): Promise<AppException> {
    const ticket = await this.ticketDto(state, auth);
    const current: Schemas["AdminCheckinRejectionDetail"] = {
      rejection_reason: reason,
      ticket,
      checkin_opens_at: window.opensAt.toISOString(),
      checkin_closes_at: window.closesAt.toISOString(),
    };
    // PRD 4.5 "QR telah digunakan": tampilkan waktu dan petugas check-in sebelumnya.
    const message =
      reason === "already_checked_in" && state.ticket.checkedInAt
        ? `Sudah check-in pada ${formatEventDateTime(state.ticket.checkedInAt, state.ticketEvent.timezone)} oleh ${ticket.checked_in_by?.display_name ?? "petugas"}.`
        : checkinRejectionMessage(reason, { ticketEventTitle: state.ticketEvent.title });
    return new AppException(409, checkinRejectionCode(reason), message, { current });
  }
}
