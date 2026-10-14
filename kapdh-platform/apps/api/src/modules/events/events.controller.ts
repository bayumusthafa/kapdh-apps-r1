import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { parseIfMatch } from "../../core/concurrency/if-match.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, MemberAccess } from "../../core/guards/decorators.js";
import { Idempotent } from "../../core/idempotency/idempotent.js";
import { UuidParamOrValidationError } from "../../core/validation/uuid-param.pipe.js";
import { validate } from "../../core/validation/validate.js";
import { MemberEventsService } from "./member-events.service.js";
import { cancelTicketSchema, ReservationsService, reservationSchema } from "./reservations.service.js";

type Schemas = components["schemas"];

/**
 * Rekening tujuan pada TicketDetail.payment.method adalah rekening ORGANISASI yang memang ditampilkan ke anggota
 * (D13), bukan rekening refund; aman disimpan untuk replay Idempotency-Key.
 */
const TICKET_IDEMPOTENCY = { publicResponsePaths: ["payment.method.account_number"] } as const;

/** Kategori dan daftar/detail event untuk anggota (kontrak events.yaml; F-09, PRD 2.2, guideline p8). */
@Controller()
export class EventsController {
  constructor(
    private readonly events: MemberEventsService,
    private readonly reservations: ReservationsService,
  ) {}

  @Get("event-categories")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("active")
  categories(): Promise<Schemas["EventCategoryList"]> {
    return this.events.categories();
  }

  @Get("events")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("active")
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<Schemas["EventPage"]> {
    return this.events.list(auth, query);
  }

  @Get("events/:eventId")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("nonsuspended")
  detail(
    @CurrentAuth() auth: AuthContext,
    @Param("eventId", UuidParamOrValidationError) eventId: string,
  ): Promise<Schemas["EventDetail"]> {
    return this.events.detail(auth, eventId);
  }

  @Get("events/:eventId/participants")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("active")
  participants(
    @CurrentAuth() auth: AuthContext,
    @Param("eventId", UuidParamOrValidationError) eventId: string,
    @Query() query: unknown,
  ): Promise<Schemas["EventParticipantPage"]> {
    return this.events.participants(auth, eventId, query);
  }

  /** AC F09-1, F09-3: 201 tiket awaiting_payment (berbayar) atau paid (gratis). */
  @Post("events/:eventId/reservations")
  @HttpCode(201)
  @Audience("mobile")
  @MemberAccess("active")
  @Idempotent(TICKET_IDEMPOTENCY)
  reserve(
    @CurrentAuth() auth: AuthContext,
    @Param("eventId", UuidParamOrValidationError) eventId: string,
    @Body() body: unknown,
  ): Promise<Schemas["TicketDetail"]> {
    return this.reservations.reserve(auth, eventId, validate(reservationSchema, body));
  }
}

/** Tiket milik anggota (kontrak events.yaml; PRD 2.2: anggota expired tetap melihat dan memakai tiket paid). */
@Controller("me/tickets")
export class MyTicketsController {
  constructor(
    private readonly events: MemberEventsService,
    private readonly reservations: ReservationsService,
  ) {}

  @Get()
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("nonsuspended")
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<Schemas["TicketPage"]> {
    return this.events.myTickets(auth, query);
  }

  @Get(":ticketId")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("nonsuspended")
  detail(
    @CurrentAuth() auth: AuthContext,
    @Param("ticketId", UuidParamOrValidationError) ticketId: string,
  ): Promise<Schemas["TicketDetail"]> {
    return this.events.myTicket(auth, ticketId);
  }

  /** D6: pembatalan mandiri dengan If-Match dan konfirmasi kelayakan refund. */
  @Post(":ticketId/cancel")
  @HttpCode(200)
  @Audience("mobile")
  @MemberAccess("nonsuspended")
  @Idempotent(TICKET_IDEMPOTENCY)
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param("ticketId", UuidParamOrValidationError) ticketId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ): Promise<Schemas["TicketDetail"]> {
    const expected = parseIfMatch(ifMatch);
    return this.reservations.cancel(auth, ticketId, expected, validate(cancelTicketSchema, body));
  }
}
