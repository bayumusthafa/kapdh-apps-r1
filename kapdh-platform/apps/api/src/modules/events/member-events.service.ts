import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { alumni, blocks, events, tickets, users } from "@kapdh/database";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lte,
  ne,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../core/db/types.js";
import { AppException, notFound } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { assertMemberAccess } from "../../core/membership/access.js";
import { cohortCode } from "../../core/membership/member-number.js";
import { decodeCursor, keysetAfter, pageOf, parsePageQuery } from "../../core/pagination/cursor.js";
import { DB } from "../../core/tokens.js";
import { validateQuery } from "../../core/validation/validate.js";
import { canReserveStatus, PUBLISHED_EVENT_STATUSES } from "./event-rules.js";
import { type EventDetailDto, EventViews, type MemberViewer, type TicketDetailDto } from "./event-views.js";

type Schemas = components["schemas"];

/** Escape wildcard LIKE (`\`, `%`, `_`) agar kata kunci dicocokkan sebagai teks biasa. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function cursorMismatch(): AppException {
  return new AppException(400, "VALIDATION_ERROR", "Parameter pencarian tidak valid.", {
    fieldErrors: { cursor: ["Cursor tidak cocok dengan filter. Muat ulang daftar dari awal."] },
  });
}

const listEventsQuery = z.object({
  category_id: z.uuid("Kategori tidak valid").optional(),
  period: z.enum(["upcoming", "past"], { message: "Periode tidak valid" }).optional(),
  q: z
    .string()
    .trim()
    .min(1, "Kata kunci minimal 1 karakter")
    .max(100, "Kata kunci maksimal 100 karakter")
    .optional(),
});

const eventCursor = z.object({ p: z.enum(["upcoming", "past"]), s: z.coerce.date(), id: z.uuid() });

const participantCursor = z.object({ n: z.string(), id: z.uuid() });

const ticketListQuery = z.object({
  view: z.enum(["active", "history"], { message: "Tampilan tidak valid" }).optional(),
});

const ticketCursor = z.object({ v: z.enum(["active", "history"]), t: z.coerce.date(), id: z.uuid() });

/** Ekspresi kunci urut nama peserta (tanpa membedakan huruf besar/kecil). */
const participantName = sql<string>`lower(${alumni.fullName})`;

/**
 * Event dan tiket untuk anggota (kontrak events.yaml; F-09, PRD 2.2, 3.9, 4.4). Semua respons baca memakai proyeksi
 * kursi/hold aturan tag Events dan tidak pernah menulis.
 */
@Injectable()
export class MemberEventsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly views: EventViews,
  ) {}

  private viewer(auth: AuthContext): MemberViewer {
    return { userId: auth.userId, status: auth.effectiveStatus };
  }

  /** GET /event-categories: kategori event aktif (urut sort_order, label). */
  async categories(): Promise<Schemas["EventCategoryList"]> {
    const rows = await this.views.eventCategories(this.db, { activeOnly: true });
    return { items: rows.map((row) => ({ id: row.id, slug: row.slug, label: row.label })) };
  }

  /** GET /events: daftar mendatang/lampau per kategori dan kata kunci (guideline p8). */
  async list(auth: AuthContext, query: unknown): Promise<Schemas["EventPage"]> {
    const page = parsePageQuery(query);
    const params = validateQuery(listEventsQuery, query);
    const period = params.period ?? "upcoming";
    const after = page.cursor ? decodeCursor(page.cursor, eventCursor) : null;
    if (after && after.p !== period) throw cursorMismatch();
    const now = this.views.now();
    const direction = period === "upcoming" ? "asc" : "desc";
    const conditions: (SQL | undefined)[] = [
      inArray(events.status, [...PUBLISHED_EVENT_STATUSES]),
      period === "upcoming"
        ? and(gt(events.endsAt, now), ne(events.status, "done"))
        : or(lte(events.endsAt, now), eq(events.status, "done")),
      params.category_id ? eq(events.categoryId, params.category_id) : undefined,
      params.q
        ? or(
            ilike(events.title, `%${escapeLike(params.q)}%`),
            ilike(events.locationName, `%${escapeLike(params.q)}%`),
          )
        : undefined,
      after
        ? keysetAfter([
            { column: events.startsAt, value: after.s, direction },
            { column: events.id, value: after.id, direction },
          ])
        : undefined,
    ];
    const rows = await this.db
      .select()
      .from(events)
      .where(and(...conditions))
      .orderBy(
        direction === "asc" ? asc(events.startsAt) : desc(events.startsAt),
        direction === "asc" ? asc(events.id) : desc(events.id),
      )
      .limit(page.limit + 1);
    const visible = rows.slice(0, page.limit);
    const [extras, latest] = await Promise.all([
      this.views.extrasFor(this.db, visible, now),
      this.views.latestTickets(
        this.db,
        auth.userId,
        visible.map((row) => row.id),
      ),
    ]);
    return pageOf(rows, page.limit, {
      cursorOf: (row) => ({ p: period, s: row.startsAt, id: row.id }),
      toItem: (row) => this.views.eventSummary(row, extras.get(row.id)!, latest.get(row.id) ?? null, now),
    });
  }

  /**
   * GET /events/{eventId} (PRD 2.2, N-09): anggota aktif membuka event terbit mana pun; unverified/expired hanya event
   * yang tiketnya ia pegang (status apa pun), selain itu 403 MEMBERSHIP_REQUIRED tanpa membedakan event ada atau tidak.
   */
  async detail(auth: AuthContext, eventId: string): Promise<EventDetailDto> {
    const viewer = this.viewer(auth);
    if (!canReserveStatus(viewer.status)) {
      const [held] = await this.db
        .select({ id: tickets.id })
        .from(tickets)
        .innerJoin(events, eq(events.id, tickets.eventId))
        .where(and(eq(tickets.eventId, eventId), eq(tickets.userId, auth.userId), ne(events.status, "draft")))
        .limit(1);
      if (!held) assertMemberAccess("active", viewer.status ?? "unverified");
    }
    const detail = await this.views.memberEventDetail(this.db, eventId, viewer);
    if (!detail) throw notFound("Event tidak ditemukan.");
    return detail;
  }

  /**
   * GET /events/{eventId}/participants (PRD 3.10, AC F10-2, F10-3): pemegang tiket paid yang tampil di direktori
   * (akun aktif, tidak suspended, KTA aktif, show_in_directory) dan tidak saling memblokir dengan pemanggil. Hanya
   * nama, angkatan dan avatar; peserta lain dihilangkan dari payload.
   */
  async participants(
    auth: AuthContext,
    eventId: string,
    query: unknown,
  ): Promise<Schemas["EventParticipantPage"]> {
    const page = parsePageQuery(query);
    const after = page.cursor ? decodeCursor(page.cursor, participantCursor) : null;
    const [event] = await this.db
      .select({ id: events.id, status: events.status })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);
    if (!event || event.status === "draft") throw notFound("Event tidak ditemukan.");
    const now = this.views.now();
    const rows = await this.db
      .select({
        userId: tickets.userId,
        fullName: alumni.fullName,
        cohort: alumni.cohort,
        avatarFileId: alumni.avatarFileId,
        sortName: participantName,
      })
      .from(tickets)
      .innerJoin(users, eq(users.id, tickets.userId))
      .innerJoin(alumni, eq(alumni.userId, tickets.userId))
      .where(
        and(
          eq(tickets.eventId, eventId),
          eq(tickets.status, "paid"),
          eq(users.status, "active"),
          isNull(alumni.suspendedAt),
          gt(alumni.expiresAt, now),
          eq(alumni.showInDirectory, true),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(blocks)
              .where(
                or(
                  and(eq(blocks.blockerId, tickets.userId), eq(blocks.blockedId, auth.userId)),
                  and(eq(blocks.blockerId, auth.userId), eq(blocks.blockedId, tickets.userId)),
                ),
              ),
          ),
          after
            ? sql`(${participantName} > ${after.n} or (${participantName} = ${after.n} and ${tickets.userId} > ${after.id}))`
            : undefined,
        ),
      )
      .orderBy(asc(participantName), asc(tickets.userId))
      .limit(page.limit + 1);
    const visible = rows.slice(0, page.limit);
    const avatars = await this.views.avatarUrls(
      this.db,
      visible.map((row) => row.avatarFileId),
      auth,
    );
    return pageOf(rows, page.limit, {
      cursorOf: (row) => ({ n: row.sortName, id: row.userId }),
      toItem: (row) => ({
        user_id: row.userId!,
        full_name: row.fullName,
        cohort: row.cohort,
        cohort_code: cohortCode(row.cohort),
        avatar_url: row.avatarFileId ? (avatars.get(row.avatarFileId) ?? null) : null,
      }),
    });
  }

  /**
   * GET /me/tickets: aktif (awaiting_payment yang belum lewat, awaiting_review, paid; event belum berakhir dan tidak
   * cancelled; urut mulai event) atau riwayat (lainnya; urut dibuat turun). Anggota expired tetap melihat tiket paid.
   */
  async myTickets(auth: AuthContext, query: unknown): Promise<Schemas["TicketPage"]> {
    const page = parsePageQuery(query);
    const params = validateQuery(ticketListQuery, query);
    const view = params.view ?? "active";
    const after = page.cursor ? decodeCursor(page.cursor, ticketCursor) : null;
    if (after && after.v !== view) throw cursorMismatch();
    const now = this.views.now();
    const nowSql = sql`${now.toISOString()}::timestamptz`;
    const activeTicket = sql`(${tickets.status} in ('awaiting_review', 'paid') or (${tickets.status} = 'awaiting_payment' and ${tickets.holdExpiresAt} > ${nowSql}))`;
    const activeView = sql`(${activeTicket} and ${events.endsAt} > ${nowSql} and ${events.status} <> 'cancelled')`;
    const rows = await this.db
      .select({ ticket: tickets, event: events })
      .from(tickets)
      .innerJoin(events, eq(events.id, tickets.eventId))
      .where(
        and(
          eq(tickets.userId, auth.userId),
          view === "active" ? activeView : sql`not ${activeView}`,
          after
            ? view === "active"
              ? keysetAfter([
                  { column: events.startsAt, value: after.t, direction: "asc" },
                  { column: tickets.id, value: after.id, direction: "asc" },
                ])
              : keysetAfter([
                  { column: tickets.createdAt, value: after.t, direction: "desc" },
                  { column: tickets.id, value: after.id, direction: "desc" },
                ])
            : undefined,
        ),
      )
      .orderBy(
        ...(view === "active"
          ? [asc(events.startsAt), asc(tickets.id)]
          : [desc(tickets.createdAt), desc(tickets.id)]),
      )
      .limit(page.limit + 1);
    const visible = rows.slice(0, page.limit);
    const [paymentMap, extras] = await Promise.all([
      this.views.paymentsForTickets(
        this.db,
        visible.map((row) => row.ticket.id),
      ),
      this.views.extrasFor(
        this.db,
        [...new Map(visible.map((row) => [row.event.id, row.event])).values()],
        now,
      ),
    ]);
    return pageOf(rows, page.limit, {
      cursorOf: (row) =>
        view === "active"
          ? { v: view, t: row.event.startsAt, id: row.ticket.id }
          : { v: view, t: row.ticket.createdAt, id: row.ticket.id },
      toItem: (row) =>
        this.views.ticketSummary(
          row.ticket,
          row.event,
          paymentMap.get(row.ticket.id) ?? null,
          now,
          extras.get(row.event.id)?.coverUrl ?? null,
        ),
    });
  }

  /** GET /me/tickets/{ticketId}: tiket milik sendiri; milik pengguna lain → 404 (N-09). */
  async myTicket(auth: AuthContext, ticketId: string): Promise<TicketDetailDto> {
    const detail = await this.views.memberTicketDetail(this.db, ticketId, auth.userId);
    if (!detail) throw notFound("Tiket tidak ditemukan.");
    return detail;
  }
}
