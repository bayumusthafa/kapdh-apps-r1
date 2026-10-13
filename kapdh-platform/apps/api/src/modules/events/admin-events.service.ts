import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { alumni, categories, events, paymentAdjustments, payments, tickets } from "@kapdh/database";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { AuditService } from "../../core/audit/audit.service.js";
import { rows as resultRows } from "../../core/db/rows.js";
import type { Db, DbOrTx, Tx } from "../../core/db/types.js";
import {
  AppException,
  fieldError,
  forbidden,
  notFound,
  versionConflict,
} from "../../core/errors/app-exception.js";
import { FilesService } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { OutboxService } from "../../core/outbox/outbox.service.js";
import { decodeCursor, encodeCursor, parsePageQuery } from "../../core/pagination/cursor.js";
import { DB } from "../../core/tokens.js";
import { queryBool, validateQuery } from "../../core/validation/validate.js";
import { fromCents, money, toCents } from "../payments/money.js";
import { PaymentLedger } from "../payments/payment-ledger.js";
import { refundDueAt } from "../payments/payment-rules.js";
import { PaymentsKernel } from "../payments/payments.kernel.js";
import {
  ACTIVE_TICKET_STATUSES,
  adminCanCancel,
  type EventRow,
  eventEditable,
  holdLapsed,
  isValidTimezone,
  statusTransitionError,
  type TicketRow,
} from "./event-rules.js";
import {
  type AdminEventDetailDto,
  type AdminEventTicketDto,
  type AdminViewer,
  EventViews,
} from "./event-views.js";
import { escapeLike } from "./member-events.service.js";
import { TicketLedger } from "./ticket-ledger.js";

type Schemas = components["schemas"];

const MONEY = /^[0-9]{1,12}\.[0-9]{2}$/;
const datetime = (label: string) =>
  z.iso.datetime({ offset: true, message: `${label} wajib tanggal-waktu ISO 8601 dengan zona` });
const nullableDatetime = (label: string) => z.union([datetime(label), z.null()]).optional();

/** Teks opsional: dipangkas; string kosong disimpan sebagai null. */
const optionalText = (max: number, label: string) =>
  z
    .union([z.string().max(max, `${label} maksimal ${max} karakter`), z.null()])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === null ? null : value.trim() || null));

const httpsUrl = z
  .union([
    z
      .string()
      .trim()
      .max(500, "Tautan maksimal 500 karakter")
      .regex(/^https:\/\//, "Tautan peta wajib diawali https://")
      .pipe(z.url({ message: "Tautan peta tidak valid" })),
    z.null(),
  ])
  .optional()
  .transform((value) => (value === "" ? null : value));

const eventFields = {
  title: z.string().trim().min(1, "Judul wajib diisi").max(200, "Judul maksimal 200 karakter"),
  description: optionalText(5000, "Deskripsi"),
  category_id: z.union([z.uuid("Kategori tidak valid"), z.null()]).optional(),
  location_name: optionalText(200, "Nama lokasi"),
  location_address: optionalText(500, "Alamat lokasi"),
  location_url: httpsUrl,
  cover_file_id: z.union([z.uuid("Gambar tidak valid"), z.null()]).optional(),
  timezone: z.string().trim().max(64, "Zona waktu maksimal 64 karakter"),
  starts_at: datetime("Waktu mulai"),
  ends_at: datetime("Waktu selesai"),
  registration_opens_at: datetime("Buka daftar"),
  registration_closes_at: datetime("Tutup daftar"),
  checkin_opens_at: nullableDatetime("Buka check-in"),
  checkin_closes_at: nullableDatetime("Tutup check-in"),
  price: z.string({ message: "Harga wajib diisi" }).regex(MONEY, "Format harga tidak valid, contoh 75000.00"),
  seats_total: z
    .number({ message: "Kuota wajib angka" })
    .int("Kuota wajib bilangan bulat")
    .min(1, "Kuota minimal 1")
    .max(100000, "Kuota maksimal 100000"),
};

export const createEventSchema = z.object({
  ...eventFields,
  timezone: eventFields.timezone.optional(),
});

export const updateEventSchema = z
  .object({
    title: eventFields.title.optional(),
    description: eventFields.description,
    category_id: eventFields.category_id,
    location_name: eventFields.location_name,
    location_address: eventFields.location_address,
    location_url: eventFields.location_url,
    cover_file_id: eventFields.cover_file_id,
    timezone: eventFields.timezone.optional(),
    starts_at: eventFields.starts_at.optional(),
    ends_at: eventFields.ends_at.optional(),
    registration_opens_at: eventFields.registration_opens_at.optional(),
    registration_closes_at: eventFields.registration_closes_at.optional(),
    checkin_opens_at: eventFields.checkin_opens_at,
    checkin_closes_at: eventFields.checkin_closes_at,
    price: eventFields.price.optional(),
    seats_total: eventFields.seats_total.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Kirim minimal satu field yang diubah",
    path: ["_"],
  });

export const eventStatusSchema = z.object({
  status: z.enum(["open", "closed"], { message: "Status hanya open atau closed" }),
});

const reasonText = z
  .string({ message: "Alasan wajib diisi" })
  .trim()
  .min(3, "Alasan minimal 3 karakter")
  .max(500, "Alasan maksimal 500 karakter");

export const cancelEventSchema = z.object({ reason: reasonText });

export const adminCancelTicketSchema = z.object({
  reason: reasonText,
  refund: z.boolean({ message: "Keputusan refund wajib dikirim" }),
});

const listEventsQuery = z.object({
  q: z.string().trim().min(1).max(100, "Kata kunci maksimal 100 karakter").optional(),
  status: z
    .enum(["draft", "open", "closed", "done", "cancelled"], { message: "Status tidak valid" })
    .optional(),
  category_id: z.uuid("Kategori tidak valid").optional(),
  starts_from: datetime("starts_from").optional(),
  starts_to: datetime("starts_to").optional(),
  sort: z
    .enum(["starts_at_desc", "starts_at_asc", "created_at_desc", "title_asc", "registration_closes_at_asc"], {
      message: "Urutan tidak valid",
    })
    .optional(),
});

const listTicketsQuery = z.object({
  status: z
    .enum(["awaiting_payment", "awaiting_review", "paid", "expired", "cancelled"], {
      message: "Status tidak valid",
    })
    .optional(),
  checked_in: queryBool().optional(),
  q: z.string().trim().min(1).max(100, "Kata kunci maksimal 100 karakter").optional(),
  sort: z
    .enum(["created_at_desc", "created_at_asc", "holder_name_asc", "checked_in_at_desc"], {
      message: "Urutan tidak valid",
    })
    .optional(),
});

const sortCursor = z.object({ s: z.string(), k: z.union([z.string(), z.number()]), id: z.uuid() });

type EventSort = NonNullable<z.infer<typeof listEventsQuery>["sort"]>;
type TicketSort = NonNullable<z.infer<typeof listTicketsQuery>["sort"]>;

/** Kolom acara yang perubahan nilainya diberitahukan ke pemegang tiket (kontrak adminUpdateEvent, AC F13-6). */
const SCHEDULE_FIELDS = [
  "startsAt",
  "endsAt",
  "timezone",
  "locationName",
  "locationAddress",
  "locationUrl",
] as const;

function invalidCursor(): AppException {
  return new AppException(400, "VALIDATION_ERROR", "Parameter pencarian tidak valid.", {
    fieldErrors: { cursor: ["Cursor tidak cocok dengan urutan. Muat ulang tabel dari awal."] },
  });
}

/** Ekspresi SQL keyset (expr arah, id arah) untuk ekspresi non-kolom. */
function keysetSql(
  expr: SQL,
  value: unknown,
  idValue: string,
  direction: "asc" | "desc",
  idColumn: SQL,
): SQL {
  const op = direction === "asc" ? sql`>` : sql`<`;
  return sql`(${expr} ${op} ${value} or (${expr} = ${value} and ${idColumn} ${op} ${idValue}))`;
}

interface EventValues {
  title: string;
  description: string | null;
  categoryId: string | null;
  locationName: string | null;
  locationAddress: string | null;
  locationUrl: string | null;
  coverFileId: string | null;
  timezone: string;
  startsAt: Date;
  endsAt: Date;
  registrationOpensAt: Date;
  registrationClosesAt: Date;
  checkinOpensAt: Date | null;
  checkinClosesAt: Date | null;
  price: string;
  seatsTotal: number;
}

/** Validasi lintas field jadwal (kontrak adminCreateEvent; CHECK events_*_chk sebagai penjaga terakhir). */
function scheduleErrors(values: EventValues): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  const add = (field: string, message: string) => (errors[field] ??= []).push(message);
  if (!isValidTimezone(values.timezone)) add("timezone", "Zona waktu tidak dikenal (contoh Asia/Jakarta).");
  if (values.endsAt.getTime() <= values.startsAt.getTime())
    add("ends_at", "Waktu selesai harus sesudah waktu mulai.");
  if (values.registrationClosesAt.getTime() <= values.registrationOpensAt.getTime())
    add("registration_closes_at", "Tutup daftar harus sesudah buka daftar.");
  if (values.registrationClosesAt.getTime() > values.endsAt.getTime())
    add("registration_closes_at", "Tutup daftar paling lambat saat acara selesai.");
  if ((values.checkinOpensAt === null) !== (values.checkinClosesAt === null))
    add("checkin_closes_at", "Isi buka dan tutup check-in bersama, atau kosongkan keduanya (bawaan D5).");
  else if (
    values.checkinOpensAt &&
    values.checkinClosesAt &&
    values.checkinClosesAt.getTime() <= values.checkinOpensAt.getTime()
  )
    add("checkin_closes_at", "Tutup check-in harus sesudah buka check-in.");
  else if (values.checkinClosesAt && values.checkinClosesAt.getTime() > values.endsAt.getTime())
    // D5: jendela lain boleh dibuka lebih awal atau ditutup lebih cepat, tetapi tidak melewati akhir acara karena
    // job events.lifecycle menandai event `done` saat acara selesai dan check-in event done selalu too_late.
    add("checkin_closes_at", "Tutup check-in paling lambat saat acara selesai.");
  return errors;
}

function throwFieldErrors(errors: Record<string, string[]>): void {
  if (Object.keys(errors).length > 0)
    throw new AppException(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
      fieldErrors: errors,
    });
}

/** Snapshot event untuk audit (tanpa data pribadi). */
function auditSnapshot(row: Partial<EventRow>): Record<string, unknown> {
  return {
    title: row.title,
    status: row.status,
    category_id: row.categoryId,
    location_name: row.locationName,
    location_address: row.locationAddress,
    location_url: row.locationUrl,
    cover_file_id: row.coverFileId,
    timezone: row.timezone,
    starts_at: row.startsAt,
    ends_at: row.endsAt,
    registration_opens_at: row.registrationOpensAt,
    registration_closes_at: row.registrationClosesAt,
    checkin_opens_at: row.checkinOpensAt,
    checkin_closes_at: row.checkinClosesAt,
    price: row.price,
    seats_total: row.seatsTotal,
    version: row.version,
  };
}

type AdminOutcome<T> =
  { kind: "ok"; value: T } | { kind: "error"; error: AppException; current?: "event" | "ticket" };

/**
 * Pengelolaan event oleh pengurus (kontrak admin-events.yaml; F-09, F-15, AC F09-7, F15-2, F15-4, PRD 4.4, D6). Izin
 * dievaluasi AuthGuard dari DB; setiap mutasi menulis audit di transaksi yang sama (F-17) dan mengikuti urutan kunci
 * global event → tiket → payment.
 */
@Injectable()
export class AdminEventsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly views: EventViews,
    private readonly ledger: TicketLedger,
    private readonly paymentsKernel: PaymentsKernel,
    private readonly paymentLedger: PaymentLedger,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly files: FilesService,
  ) {}

  // -------------------------------------------------------------------------------------------- kategori

  async categories(): Promise<Schemas["AdminEventCategoryList"]> {
    const rows = await this.views.eventCategories(this.db, { activeOnly: false });
    return {
      items: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        label: row.label,
        active: row.active,
        sort_order: row.sortOrder,
      })),
    };
  }

  // ------------------------------------------------------------------------------------------------ daftar

  async list(query: unknown): Promise<Schemas["AdminEventPage"]> {
    const page = parsePageQuery(query);
    const params = validateQuery(listEventsQuery, query);
    const sort: EventSort = params.sort ?? "starts_at_desc";
    const after = page.cursor ? decodeCursor(page.cursor, sortCursor) : null;
    if (after && after.s !== sort) throw invalidCursor();
    const filters: (SQL | undefined)[] = [
      params.status ? eq(events.status, params.status) : undefined,
      params.category_id ? eq(events.categoryId, params.category_id) : undefined,
      params.starts_from ? gte(events.startsAt, new Date(params.starts_from)) : undefined,
      params.starts_to ? lt(events.startsAt, new Date(params.starts_to)) : undefined,
      params.q
        ? or(
            ilike(events.title, `%${escapeLike(params.q)}%`),
            ilike(events.locationName, `%${escapeLike(params.q)}%`),
          )
        : undefined,
    ];
    const order = this.eventOrder(sort);
    const keyset = after ? this.eventKeyset(sort, after.k, after.id) : undefined;
    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select()
        .from(events)
        .where(and(...filters, keyset))
        .orderBy(...order)
        .limit(page.limit + 1),
      this.db
        .select({ n: count() })
        .from(events)
        .where(and(...filters)),
    ]);
    const visible = rows.slice(0, page.limit);
    const now = this.views.now();
    const [extras, withTickets] = await Promise.all([
      this.views.extrasFor(this.db, visible, now),
      this.views.eventsWithTickets(
        this.db,
        visible.map((row) => row.id),
      ),
    ]);
    const last = visible[visible.length - 1];
    return {
      items: visible.map((row) =>
        this.views.adminEventSummary(row, extras.get(row.id)!, withTickets.has(row.id)),
      ),
      total: Number(totalRow?.n ?? 0),
      next_cursor:
        rows.length > page.limit && last
          ? encodeCursor({ s: sort, k: this.eventSortKey(sort, last), id: last.id })
          : null,
    };
  }

  private eventOrder(sort: EventSort): SQL[] {
    switch (sort) {
      case "starts_at_desc":
        return [desc(events.startsAt), desc(events.id)];
      case "starts_at_asc":
        return [asc(events.startsAt), asc(events.id)];
      case "created_at_desc":
        return [desc(events.createdAt), desc(events.id)];
      case "title_asc":
        return [asc(sql`lower(${events.title})`), asc(events.id)];
      case "registration_closes_at_asc":
        return [asc(events.registrationClosesAt), asc(events.id)];
    }
  }

  private eventSortKey(sort: EventSort, row: EventRow): string {
    switch (sort) {
      case "starts_at_desc":
      case "starts_at_asc":
        return row.startsAt.toISOString();
      case "created_at_desc":
        return row.createdAt.toISOString();
      case "title_asc":
        return row.title.toLowerCase();
      case "registration_closes_at_asc":
        return row.registrationClosesAt.toISOString();
    }
  }

  private eventKeyset(sort: EventSort, key: string | number, id: string): SQL {
    const value = String(key);
    const ts = (column: SQL) => ({ expr: column, value: sql`${value}::timestamptz` });
    const spec =
      sort === "starts_at_desc"
        ? { ...ts(sql`${events.startsAt}`), dir: "desc" as const }
        : sort === "starts_at_asc"
          ? { ...ts(sql`${events.startsAt}`), dir: "asc" as const }
          : sort === "created_at_desc"
            ? { ...ts(sql`${events.createdAt}`), dir: "desc" as const }
            : sort === "registration_closes_at_asc"
              ? { ...ts(sql`${events.registrationClosesAt}`), dir: "asc" as const }
              : { expr: sql`lower(${events.title})`, value: sql`${value}`, dir: "asc" as const };
    return keysetSql(spec.expr, spec.value, id, spec.dir, sql`${events.id}`);
  }

  // ------------------------------------------------------------------------------------------- detail/CRUD

  async detail(eventId: string): Promise<AdminEventDetailDto> {
    const detail = await this.views.adminEventDetailById(this.db, eventId);
    if (!detail) throw notFound("Event tidak ditemukan.");
    return detail;
  }

  /** Kategori event aktif (400 bila tidak ada/nonaktif/bukan kind event). */
  private async assertCategory(db: DbOrTx, categoryId: string): Promise<void> {
    const [row] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, categoryId), eq(categories.kind, "event"), eq(categories.active, true)))
      .limit(1);
    if (!row) throw fieldError("category_id", "Pilih kategori event yang aktif.");
  }

  /** POST /admin/events: event selalu draft (PRD 4.4). Audit `event.created`. */
  async create(auth: AuthContext, input: z.infer<typeof createEventSchema>): Promise<AdminEventDetailDto> {
    const values: EventValues = {
      title: input.title,
      description: input.description ?? null,
      categoryId: input.category_id ?? null,
      locationName: input.location_name ?? null,
      locationAddress: input.location_address ?? null,
      locationUrl: input.location_url ?? null,
      coverFileId: input.cover_file_id ?? null,
      timezone: input.timezone ?? "Asia/Jakarta",
      startsAt: new Date(input.starts_at),
      endsAt: new Date(input.ends_at),
      registrationOpensAt: new Date(input.registration_opens_at),
      registrationClosesAt: new Date(input.registration_closes_at),
      checkinOpensAt: input.checkin_opens_at ? new Date(input.checkin_opens_at) : null,
      checkinClosesAt: input.checkin_closes_at ? new Date(input.checkin_closes_at) : null,
      price: money(input.price),
      seatsTotal: input.seats_total,
    };
    throwFieldErrors(scheduleErrors(values));
    const eventId = uuidv7();
    await this.db.transaction(async (tx) => {
      if (values.categoryId) await this.assertCategory(tx, values.categoryId);
      if (values.coverFileId)
        await this.files.attach(tx, values.coverFileId, auth.userId, "event_cover", {
          field: "cover_file_id",
        });
      const now = this.views.now();
      const [row] = await tx
        .insert(events)
        .values({
          id: eventId,
          ...values,
          status: "draft",
          createdByAdminId: auth.adminId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await this.audit.write(tx, {
        action: "event.created",
        entityType: "event",
        entityId: eventId,
        after: auditSnapshot(row!),
      });
    });
    return this.detail(eventId);
  }

  /**
   * PATCH /admin/events/{eventId} (AC F15-2, F15-4): If-Match; done/cancelled tidak dapat diubah; kuota tidak boleh
   * di bawah held+paid (hold kedaluwarsa dilepas lebih dahulu); harga baru hanya untuk reservasi baru (PRD 4.4);
   * perubahan jadwal/lokasi memberi notifikasi pemegang tiket aktif dan menjadwalkan ulang pengingat (AC F13-6).
   */
  async update(
    auth: AuthContext,
    eventId: string,
    expectedVersion: number,
    input: z.infer<typeof updateEventSchema>,
  ): Promise<AdminEventDetailDto> {
    const outcome = await this.db.transaction(async (tx): Promise<AdminOutcome<null>> => {
      const event = await this.ledger.lockEvent(tx, eventId);
      if (!event) throw notFound("Event tidak ditemukan.");
      if (event.version !== expectedVersion)
        return { kind: "error", error: versionConflict(null), current: "event" };
      if (!eventEditable(event.status))
        throw fieldError("status", "Event yang sudah selesai atau dibatalkan tidak dapat diubah.");
      const date = (value: string | undefined, fallback: Date) =>
        value === undefined ? fallback : new Date(value);
      const nullableDate = (value: string | null | undefined, fallback: Date | null) =>
        value === undefined ? fallback : value === null ? null : new Date(value);
      const pick = <T>(value: T | undefined, fallback: T): T => (value === undefined ? fallback : value);
      const next: EventValues = {
        title: pick(input.title, event.title),
        description: pick(input.description, event.description),
        categoryId: pick(input.category_id, event.categoryId),
        locationName: pick(input.location_name, event.locationName),
        locationAddress: pick(input.location_address, event.locationAddress),
        locationUrl: pick(input.location_url, event.locationUrl),
        coverFileId: pick(input.cover_file_id, event.coverFileId),
        timezone: pick(input.timezone, event.timezone),
        startsAt: date(input.starts_at, event.startsAt),
        endsAt: date(input.ends_at, event.endsAt),
        registrationOpensAt: date(input.registration_opens_at, event.registrationOpensAt),
        registrationClosesAt: date(input.registration_closes_at, event.registrationClosesAt),
        checkinOpensAt: nullableDate(input.checkin_opens_at, event.checkinOpensAt),
        checkinClosesAt: nullableDate(input.checkin_closes_at, event.checkinClosesAt),
        price: input.price === undefined ? money(event.price) : money(input.price),
        seatsTotal: pick(input.seats_total, event.seatsTotal),
      };
      throwFieldErrors(scheduleErrors(next));
      const now = this.views.now();
      if (next.seatsTotal < event.heldQuantity + event.paidQuantity) {
        // Hold kedaluwarsa dilepas lebih dahulu sehingga batas sama dengan min_seats_total yang ditampilkan.
        const released = await this.ledger.expireLapsedHolds(tx, eventId, now);
        if (next.seatsTotal < event.heldQuantity - released.length + event.paidQuantity)
          return {
            kind: "error",
            error: new AppException(
              409,
              "VALIDATION_ERROR",
              "Kuota tidak boleh di bawah kursi yang ditahan dan terjual.",
              {
                fieldErrors: {
                  seats_total: [
                    `Kuota minimal ${Math.max(1, event.heldQuantity - released.length + event.paidQuantity)} karena kursi sudah ditahan atau terjual.`,
                  ],
                },
              },
            ),
            current: "event",
          };
      }
      if (next.categoryId && next.categoryId !== event.categoryId)
        await this.assertCategory(tx, next.categoryId);
      if (next.coverFileId !== event.coverFileId) {
        if (next.coverFileId)
          await this.files.attach(tx, next.coverFileId, auth.userId, "event_cover", {
            field: "cover_file_id",
          });
        if (event.coverFileId) await this.files.discard(tx, event.coverFileId);
      }
      const [updated] = await tx
        .update(events)
        .set({ ...next, version: sql`${events.version} + 1`, updatedAt: now })
        .where(and(eq(events.id, eventId), eq(events.version, expectedVersion)))
        .returning();
      if (!updated) throw new Error("Event terkunci berubah di tengah transaksi");
      const before = auditSnapshot(event);
      const after = auditSnapshot(updated);
      const changed = Object.keys(after).filter(
        (key) => key !== "version" && JSON.stringify(before[key]) !== JSON.stringify(after[key]),
      );
      await this.audit.write(tx, {
        action: "event.updated",
        entityType: "event",
        entityId: eventId,
        before: { ...Object.fromEntries(changed.map((key) => [key, before[key]])), version: event.version },
        after: { ...Object.fromEntries(changed.map((key) => [key, after[key]])), version: updated.version },
      });
      const scheduleChanged = SCHEDULE_FIELDS.some(
        (field) => JSON.stringify(event[field]) !== JSON.stringify(updated[field]),
      );
      if (scheduleChanged && updated.status !== "draft") await this.notifyScheduleChange(tx, updated, now);
      return { kind: "ok", value: null };
    });
    if (outcome.kind === "error") throw await this.withEventCurrent(outcome.error, eventId);
    return this.detail(eventId);
  }

  /** Notifikasi perubahan jadwal/lokasi ke pemegang tiket aktif (kontrak adminUpdateEvent; AC F13-6). */
  private async notifyScheduleChange(tx: Tx, event: EventRow, now: Date): Promise<void> {
    const holders = await tx
      .select()
      .from(tickets)
      .where(and(eq(tickets.eventId, event.id), inArray(tickets.status, [...ACTIVE_TICKET_STATUSES])))
      .orderBy(asc(tickets.id));
    for (const ticket of holders) {
      if (holdLapsed(ticket, now)) continue;
      await this.ledger.notifyHolder(tx, ticket, {
        dedupKey: `event.updated:${event.id}:v${event.version}`,
        title: `Jadwal atau lokasi diperbarui: ${event.title}`,
        body: "Pengurus mengubah jadwal atau lokasi event yang Anda ikuti. Buka tiket untuk melihat detail terbaru.",
      });
    }
  }

  /** DELETE /admin/events/{eventId}: hanya event tanpa riwayat tiket (AC F15-2). Audit `event.deleted`. */
  async remove(eventId: string, expectedVersion: number): Promise<void> {
    const outcome = await this.db.transaction(async (tx): Promise<AdminOutcome<null>> => {
      const event = await this.ledger.lockEvent(tx, eventId);
      if (!event) throw notFound("Event tidak ditemukan.");
      if (event.version !== expectedVersion)
        return { kind: "error", error: versionConflict(null), current: "event" };
      const [ticket] = await tx
        .select({ id: tickets.id })
        .from(tickets)
        .where(eq(tickets.eventId, eventId))
        .limit(1);
      if (ticket)
        return {
          kind: "error",
          error: new AppException(
            409,
            "VALIDATION_ERROR",
            "Event yang sudah memiliki tiket tidak dapat dihapus. Batalkan event bila acara tidak jadi.",
            { fieldErrors: { event: ["Event sudah memiliki riwayat tiket; gunakan pembatalan event."] } },
          ),
          current: "event",
        };
      await tx.delete(events).where(eq(events.id, eventId));
      if (event.coverFileId) await this.files.discard(tx, event.coverFileId);
      await this.audit.write(tx, {
        action: "event.deleted",
        entityType: "event",
        entityId: eventId,
        before: auditSnapshot(event),
      });
      return { kind: "ok", value: null };
    });
    if (outcome.kind === "error") throw await this.withEventCurrent(outcome.error, eventId);
  }

  /**
   * POST /admin/events/{eventId}/status (PRD 4.4): status sama → 200 tanpa perubahan SEBELUM If-Match; lalu If-Match;
   * lalu aturan transisi (400). Audit `event.status_changed`.
   */
  async setStatus(
    eventId: string,
    expectedVersion: number,
    input: z.infer<typeof eventStatusSchema>,
  ): Promise<AdminEventDetailDto> {
    const outcome = await this.db.transaction(async (tx): Promise<AdminOutcome<null>> => {
      const event = await this.ledger.lockEvent(tx, eventId);
      if (!event) throw notFound("Event tidak ditemukan.");
      if (event.status === input.status) return { kind: "ok", value: null };
      if (event.version !== expectedVersion)
        return { kind: "error", error: versionConflict(null), current: "event" };
      const now = this.views.now();
      const problem = statusTransitionError(event, input.status, now);
      if (problem) throw fieldError("status", problem);
      const [updated] = await tx
        .update(events)
        .set({ status: input.status, version: sql`${events.version} + 1`, updatedAt: now })
        .where(and(eq(events.id, eventId), eq(events.version, expectedVersion)))
        .returning();
      if (!updated) throw new Error("Event terkunci berubah di tengah transaksi");
      await this.audit.write(tx, {
        action: "event.status_changed",
        entityType: "event",
        entityId: eventId,
        before: { status: event.status, version: event.version },
        after: { status: updated.status, version: updated.version },
      });
      return { kind: "ok", value: null };
    });
    if (outcome.kind === "error") throw await this.withEventCurrent(outcome.error, eventId);
    return this.detail(eventId);
  }

  /**
   * POST /admin/events/{eventId}/cancel (AC F09-7, D6): satu transaksi mengunci event, SEMUA tiket aktif (satu
   * SELECT urut id, termasuk hold kedaluwarsa), lalu payment-nya urut id payment (PRD 6.4; tidak pernah mengunci
   * tiket sesudah payment). Hold kedaluwarsa → expired; awaiting_payment → cancelled (admin) + payment dibatalkan;
   * awaiting_review → cancelled (system) dan payment tetap di antrean; paid → cancelled (system), QR tidak berlaku,
   * refund penuh sistem untuk total > 0. Penghitung kursi menjadi 0; outbox `event.cancelled` untuk fanout notifikasi.
   */
  async cancelEvent(
    eventId: string,
    expectedVersion: number,
    input: z.infer<typeof cancelEventSchema>,
  ): Promise<Schemas["AdminEventCancelResult"]> {
    const result = await this.db.transaction(
      async (tx): Promise<AdminOutcome<Omit<Schemas["AdminEventCancelResult"], "event">>> => {
        const event = await this.ledger.lockEvent(tx, eventId);
        if (!event) throw notFound("Event tidak ditemukan.");
        if (event.version !== expectedVersion)
          return { kind: "error", error: versionConflict(null), current: "event" };
        if (event.status !== "open" && event.status !== "closed")
          throw fieldError(
            "status",
            event.status === "draft"
              ? "Event draft dihapus, bukan dibatalkan."
              : "Event yang sudah selesai atau dibatalkan tidak dapat dibatalkan.",
          );
        const now = this.views.now();
        const reason = input.reason;
        // Urutan kunci global (aturan tag Events): SEMUA tiket aktif event (termasuk hold kedaluwarsa) dikunci dalam
        // satu SELECT urut id SEBELUM payment mana pun disentuh; payment lalu disentuh urut id payment.
        const locked = await this.ledger.lockEventTickets(tx, eventId, ACTIVE_TICKET_STATUSES);
        const paymentsByTicket = await this.views.paymentsForTickets(
          tx,
          locked.map((ticket) => ticket.id),
        );
        // Tiket tanpa payment (gratis) lebih dahulu; sisanya urut id payment (uuid heksadesimal kecil = urutan byte).
        const orderKey = (ticket: TicketRow) => paymentsByTicket.get(ticket.id)?.id ?? "";
        const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
        const ordered = [...locked].sort(
          (a, b) => compare(orderKey(a), orderKey(b)) || compare(a.id, b.id),
        );
        let ticketsCancelled = 0;
        let paymentsCancelled = 0;
        let paymentsInReview = 0;
        let refundsCreated = 0;
        let refundCents = 0n;
        for (const ticket of ordered) {
          // Hold kedaluwarsa dilepas sebagai expired (AC F09-2), bukan dibatalkan.
          if (holdLapsed(ticket, now) && (await this.ledger.expireTicket(tx, ticket, now))) continue;
          const by = ticket.status === "awaiting_payment" ? "admin" : "system";
          const cancelled = await this.ledger.cancelTicket(tx, ticket, { by, reason, at: now });
          if (!cancelled) continue;
          ticketsCancelled += 1;
          if (ticket.status === "paid") {
            if (toCents(ticket.totalSnapshot) === 0n) continue;
            // Status payment stabil: setiap perubahannya memerlukan kunci event yang dipegang transaksi ini.
            const payment = paymentsByTicket.get(ticket.id);
            if (!payment || payment.status !== "paid") continue;
            const refund = await this.paymentsKernel.recordSystemRefund(tx, {
              paymentId: payment.id,
              amount: money(ticket.totalSnapshot),
              dueAt: refundDueAt(now),
              reason: "Event dibatalkan pengurus (D6)",
            });
            if (refund) {
              refundsCreated += 1;
              refundCents += toCents(refund.amount);
            }
            continue;
          }
          const payment = await this.paymentsKernel.cancelForTicket(
            tx,
            ticket.id,
            `Event dibatalkan: ${reason}`,
          );
          if (payment.outcome === "cancelled") paymentsCancelled += 1;
          if (payment.outcome === "kept_with_proof") paymentsInReview += 1;
        }
        const [updated] = await tx
          .update(events)
          .set({
            status: "cancelled",
            cancelledAt: now,
            cancelReason: reason,
            version: sql`${events.version} + 1`,
            updatedAt: now,
          })
          .where(and(eq(events.id, eventId), eq(events.version, expectedVersion)))
          .returning();
        if (!updated) throw new Error("Event terkunci berubah di tengah transaksi");
        const summary = {
          tickets_cancelled: ticketsCancelled,
          payments_cancelled: paymentsCancelled,
          payments_in_review: paymentsInReview,
          refunds_created: refundsCreated,
          refund_total: fromCents(refundCents),
        };
        await this.audit.write(tx, {
          action: "event.cancelled",
          entityType: "event",
          entityId: eventId,
          reason,
          before: { status: event.status, version: event.version },
          after: { status: updated.status, version: updated.version, cancelled_at: now, ...summary },
        });
        await this.outbox.publish(tx, {
          topic: "event.cancelled",
          dedupKey: `event.cancelled:${eventId}`,
          payload: { event_id: eventId },
        });
        return { kind: "ok", value: summary };
      },
    );
    if (result.kind === "error") throw await this.withEventCurrent(result.error, eventId);
    return { event: await this.detail(eventId), ...result.value };
  }

  // ---------------------------------------------------------------------------------------------- statistik

  /** GET /admin/events/{eventId}/stats (PRD 1.6): kursi, check-in, pendapatan kotor/bersih dan refund. */
  async stats(eventId: string): Promise<Schemas["AdminEventStats"]> {
    const [event] = await this.db.select().from(events).where(eq(events.id, eventId)).limit(1);
    if (!event) throw notFound("Event tidak ditemukan.");
    const now = this.views.now();
    const nowSql = sql`${now.toISOString()}::timestamptz`;
    const [counts] = resultRows<{
      awaiting_payment: number;
      awaiting_review: number;
      paid: number;
      checked_in: number;
      expired: number;
      cancelled: number;
    }>(
      await this.db.execute(sql`
        select
          count(*) filter (where status = 'awaiting_payment' and hold_expires_at > ${nowSql})::int as awaiting_payment,
          count(*) filter (where status = 'awaiting_review')::int as awaiting_review,
          count(*) filter (where status = 'paid')::int as paid,
          count(*) filter (where checked_in_at is not null)::int as checked_in,
          count(*) filter (where status = 'expired'
            or (status = 'awaiting_payment' and hold_expires_at <= ${nowSql}))::int as expired,
          count(*) filter (where status = 'cancelled')::int as cancelled
        from ${tickets} where event_id = ${eventId}`),
    );
    const [gross] = await this.db
      .select({ total: sql<string>`coalesce(sum(${payments.amount}), 0)::text` })
      .from(payments)
      .innerJoin(tickets, eq(tickets.id, payments.ticketId))
      .where(and(eq(tickets.eventId, eventId), eq(payments.status, "paid")));
    const refunds = await this.db
      .select({
        status: paymentAdjustments.status,
        total: sql<string>`coalesce(sum(${paymentAdjustments.amount}), 0)::text`,
      })
      .from(paymentAdjustments)
      .innerJoin(payments, eq(payments.id, paymentAdjustments.paymentId))
      .innerJoin(tickets, eq(tickets.id, payments.ticketId))
      .where(
        and(
          eq(tickets.eventId, eventId),
          eq(paymentAdjustments.kind, "refund"),
          inArray(paymentAdjustments.status, ["pending", "completed"]),
        ),
      )
      .groupBy(paymentAdjustments.status);
    const grossCents = toCents(gross?.total ?? "0");
    const pendingCents = toCents(refunds.find((row) => row.status === "pending")?.total ?? "0");
    const completedCents = toCents(refunds.find((row) => row.status === "completed")?.total ?? "0");
    const extras = await this.views.extrasFor(this.db, [event], now);
    const seats = this.views.adminEventSummary(event, extras.get(event.id)!, true);
    return {
      event_id: event.id,
      status: event.status,
      seats_total: event.seatsTotal,
      seats_available: seats.seats_available,
      awaiting_payment_count: counts?.awaiting_payment ?? 0,
      awaiting_review_count: counts?.awaiting_review ?? 0,
      paid_count: counts?.paid ?? 0,
      checked_in_count: counts?.checked_in ?? 0,
      expired_count: counts?.expired ?? 0,
      cancelled_count: counts?.cancelled ?? 0,
      gross_revenue: fromCents(grossCents),
      refunds_pending_amount: fromCents(pendingCents),
      refunds_completed_amount: fromCents(completedCents),
      net_revenue: fromCents(grossCents > completedCents ? grossCents - completedCents : 0n),
      generated_at: now.toISOString(),
    };
  }

  // ------------------------------------------------------------------------------------------------ tiket

  /** GET /admin/events/{eventId}/tickets: semua tiket event dengan filter, urutan dan total (F-09, F-15). */
  async tickets(
    auth: AuthContext,
    eventId: string,
    query: unknown,
  ): Promise<Schemas["AdminEventTicketPage"]> {
    const page = parsePageQuery(query);
    const params = validateQuery(listTicketsQuery, query);
    const sort: TicketSort = params.sort ?? "created_at_desc";
    const after = page.cursor ? decodeCursor(page.cursor, sortCursor) : null;
    if (after && after.s !== sort) throw invalidCursor();
    const [event] = await this.db.select().from(events).where(eq(events.id, eventId)).limit(1);
    if (!event) throw notFound("Event tidak ditemukan.");
    const now = this.views.now();
    const nowSql = sql`${now.toISOString()}::timestamptz`;
    const statusFilter = (): SQL | undefined => {
      switch (params.status) {
        case undefined:
          return undefined;
        case "awaiting_payment":
          return sql`(${tickets.status} = 'awaiting_payment' and ${tickets.holdExpiresAt} > ${nowSql})`;
        case "expired":
          return sql`(${tickets.status} = 'expired' or (${tickets.status} = 'awaiting_payment' and ${tickets.holdExpiresAt} <= ${nowSql}))`;
        default:
          return eq(tickets.status, params.status);
      }
    };
    const holderName = sql<string>`coalesce(lower(${alumni.fullName}), '')`;
    const filters: (SQL | undefined)[] = [
      eq(tickets.eventId, eventId),
      statusFilter(),
      params.checked_in === undefined
        ? undefined
        : params.checked_in
          ? isNotNull(tickets.checkedInAt)
          : isNull(tickets.checkedInAt),
      params.q
        ? sql`(${alumni.fullName} ilike ${`%${escapeLike(params.q)}%`} or ${alumni.memberNumber} ilike ${`%${escapeLike(params.q)}%`})`
        : undefined,
    ];
    const checkedSort = sql`coalesce(${tickets.checkedInAt}, '-infinity'::timestamptz)`;
    const spec =
      sort === "created_at_desc"
        ? { expr: sql`${tickets.createdAt}`, dir: "desc" as const, ts: true }
        : sort === "created_at_asc"
          ? { expr: sql`${tickets.createdAt}`, dir: "asc" as const, ts: true }
          : sort === "holder_name_asc"
            ? { expr: holderName, dir: "asc" as const, ts: false }
            : { expr: checkedSort, dir: "desc" as const, ts: true };
    const keyset = after
      ? keysetSql(
          spec.expr,
          spec.ts ? sql`${String(after.k)}::timestamptz` : sql`${String(after.k)}`,
          after.id,
          spec.dir,
          sql`${tickets.id}`,
        )
      : undefined;
    const base = () =>
      this.db
        .select({ ticket: tickets, sortKey: sql<string | Date>`${spec.expr}` })
        .from(tickets)
        .leftJoin(alumni, eq(alumni.userId, tickets.userId));
    const [rows, [totalRow]] = await Promise.all([
      base()
        .where(and(...filters, keyset))
        .orderBy(
          spec.dir === "asc" ? asc(spec.expr) : desc(spec.expr),
          spec.dir === "asc" ? asc(tickets.id) : desc(tickets.id),
        )
        .limit(page.limit + 1),
      this.db
        .select({ n: count() })
        .from(tickets)
        .leftJoin(alumni, eq(alumni.userId, tickets.userId))
        .where(and(...filters)),
    ]);
    const visible = rows.slice(0, page.limit);
    const items = await this.views.adminTickets(
      this.db,
      event,
      visible.map((row) => row.ticket),
      auth,
    );
    const last = visible[visible.length - 1];
    const keyOf = (row: (typeof rows)[number]): string => {
      if (sort === "holder_name_asc") return String(row.sortKey);
      if (sort === "checked_in_at_desc")
        return row.ticket.checkedInAt ? row.ticket.checkedInAt.toISOString() : "-infinity";
      return row.ticket.createdAt.toISOString();
    };
    return {
      items,
      total: Number(totalRow?.n ?? 0),
      next_cursor:
        rows.length > page.limit && last
          ? encodeCursor({ s: sort, k: keyOf(last), id: last.ticket.id })
          : null,
    };
  }

  /**
   * POST /admin/events/{eventId}/tickets/{ticketId}/cancel (D6, PRD 2.2, 2.3): `refund=true` memerlukan
   * payments.decide dan bukan tiket akun alumni tertaut pemanggil, diperiksa SEBELUM perubahan apa pun.
   */
  async cancelTicket(
    auth: AuthContext,
    eventId: string,
    ticketId: string,
    expectedVersion: number,
    input: z.infer<typeof adminCancelTicketSchema>,
  ): Promise<AdminEventTicketDto> {
    const viewer: AdminViewer = auth;
    const [unlocked] = await this.db
      .select({ eventId: tickets.eventId, userId: tickets.userId })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);
    if (!unlocked || unlocked.eventId !== eventId) throw notFound("Tiket tidak ditemukan.");
    if (input.refund) {
      if (!auth.permissions.has("payments.decide"))
        throw forbidden("Refund tiket memerlukan izin memutus pembayaran (payments.decide).");
      if (unlocked.userId !== null && unlocked.userId === auth.linkedAlumniUserId)
        throw forbidden("Refund untuk tiket akun alumni Anda sendiri harus diputus pengurus lain (PRD 2.3).");
    }
    const outcome = await this.db.transaction(async (tx): Promise<AdminOutcome<null>> => {
      const event = await this.ledger.lockEvent(tx, eventId);
      const ticket = await this.ledger.lockTicket(tx, ticketId);
      if (!event || !ticket || ticket.eventId !== eventId) throw notFound("Tiket tidak ditemukan.");
      if (input.refund && ticket.userId !== null && ticket.userId === auth.linkedAlumniUserId)
        throw forbidden("Refund untuk tiket akun alumni Anda sendiri harus diputus pengurus lain (PRD 2.3).");
      const now = this.views.now();
      if (holdLapsed(ticket, now)) {
        await this.ledger.expireTicket(tx, ticket, now);
        return {
          kind: "error",
          error: versionConflict(
            null,
            "Reservasi tiket ini sudah kedaluwarsa sehingga tidak perlu dibatalkan.",
          ),
          current: "ticket",
        };
      }
      if (ticket.status === "awaiting_review" && event.status !== "cancelled")
        return {
          kind: "error",
          error: new AppException(
            409,
            "PAYMENT_STATE_CONFLICT",
            "Bukti pembayaran tiket sedang ditinjau. Putuskan pembayarannya lebih dahulu di antrean pembayaran.",
          ),
          current: "ticket",
        };
      if (!adminCanCancel(ticket, event, now))
        return {
          kind: "error",
          error: versionConflict(
            null,
            "Tiket ini tidak dapat dibatalkan lagi. Muat ulang untuk melihat status terbaru.",
          ),
          current: "ticket",
        };
      if (ticket.version !== expectedVersion)
        return { kind: "error", error: versionConflict(null), current: "ticket" };
      if (input.refund && (ticket.status !== "paid" || toCents(ticket.totalSnapshot) === 0n))
        throw fieldError("refund", "Refund hanya untuk tiket berbayar yang sudah lunas.");
      const cancelled = await this.ledger.cancelTicket(tx, ticket, {
        by: "admin",
        reason: input.reason,
        at: now,
      });
      if (!cancelled) throw new Error("Tiket terkunci berubah di tengah transaksi");
      let refundId: string | null = null;
      if (ticket.status === "awaiting_payment")
        await this.paymentsKernel.cancelForTicket(
          tx,
          ticket.id,
          `Tiket dibatalkan pengurus: ${input.reason}`,
        );
      else if (input.refund) refundId = await this.adminRefund(tx, auth, ticket, input.reason, now);
      await this.audit.write(tx, {
        action: "ticket.cancelled",
        entityType: "ticket",
        entityId: ticket.id,
        reason: input.reason,
        before: { status: ticket.status, version: ticket.version },
        after: {
          status: cancelled.status,
          version: cancelled.version,
          cancelled_by: "admin",
          refund: input.refund,
          refund_adjustment_id: refundId,
        },
      });
      const refundText = refundId
        ? " Refund penuh diproses bendahara paling lambat 7 hari kerja; kirim rekening tujuan dari detail pembayaran."
        : "";
      await this.ledger.notifyHolder(tx, cancelled, {
        dedupKey: `ticket.cancelled:${ticket.id}`,
        title: `Tiket dibatalkan pengurus: ${event.title}`,
        body: `Alasan: ${input.reason}.${refundText}`,
      });
      return { kind: "ok", value: null };
    });
    const current = await this.views.adminTicketById(this.db, ticketId, viewer);
    if (outcome.kind === "error") {
      outcome.error.extra.current = current;
      throw outcome.error;
    }
    return current!;
  }

  /**
   * Refund diskresioner pengurus atas tiket paid (PRD 2.2 "refund diputuskan pengurus per kasus"): payment_adjustment
   * refund pending sebesar sisa yang belum direfund (maks. total tiket), tenggat 7 hari kerja (D6), dicatat atas nama
   * pengurus pemutus lewat primitif buku besar modul payments (cap nominal, audit, notifikasi rekening tujuan).
   *
   * Pengecualian batas modul yang disadari (ARCHITECTURE §3.3/§4.6): PaymentsKernel belum memiliki refund beratribusi
   * pengurus (`recordSystemRefund` selalu created_by null, sedangkan PRD 2.3 mewajibkan keputusan uang tercatat atas
   * nama pengurus pemutusnya). Sampai pemilik payments menambah `PaymentsKernel.recordAdminRefund` (permintaan
   * terbuka slice api-events), jalur ini memakai PaymentLedger secara langsung dengan kunci payment sebagai tingkat
   * terakhir urutan kunci global; tidak ada tabel payments yang ditulis tanpa primitif modul payments.
   */
  private async adminRefund(
    tx: Tx,
    auth: AuthContext,
    ticket: TicketRow,
    reason: string,
    now: Date,
  ): Promise<string | null> {
    const payment = (await this.views.paymentsForTickets(tx, [ticket.id])).get(ticket.id);
    if (!payment) return null;
    const locked = await this.paymentLedger.lockPayment(tx, payment.id);
    if (locked.status !== "paid") return null;
    const remaining = toCents(locked.amount) - (await this.paymentLedger.refundedCents(tx, locked.id));
    const wanted = toCents(ticket.totalSnapshot);
    const amount = remaining < wanted ? remaining : wanted;
    if (amount <= 0n) return null;
    const refund = await this.paymentLedger.recordRefund(tx, locked, {
      amount: fromCents(amount),
      dueAt: refundDueAt(now),
      reason: `Tiket dibatalkan pengurus: ${reason}`,
      createdByAdminId: auth.adminId,
      at: now,
    });
    return refund?.id ?? null;
  }

  // ---------------------------------------------------------------------------------------------- bantuan

  /** Mengisi `current` galat dengan AdminEventDetail terbaru (PRD 4.5 "muat ulang data terbaru"). */
  private async withEventCurrent(error: AppException, eventId: string): Promise<AppException> {
    const current = await this.views.adminEventDetailById(this.db, eventId);
    error.extra.current = current;
    return error;
  }
}
