/**
 * Fixture uji modul payments (ARCHITECTURE §9.1): aplikasi uji dengan handler tiket penguji (bila modul events belum
 * mendaftarkan handler `ticket`), sesi anggota/pengurus, unggah bukti, event + tiket + payment tiket lewat
 * PaymentsKernel, dan token reautentikasi pengurus.
 */
import type { Permission } from "@kapdh/contracts";
import { events, sessions, tickets } from "@kapdh/database";
import { Injectable, Module, type OnModuleInit } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { decodeJwt } from "jose";
import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { expect } from "vitest";
import { type Actor, runInContext, SYSTEM_ACTOR } from "../../src/core/context/request-context.js";
import type { Tx } from "../../src/core/db/types.js";
import { AppException } from "../../src/core/errors/app-exception.js";
import { TokenService } from "../../src/core/identity/token.service.js";
import {
  type PaymentApprovalOutcome,
  PaymentHandlerRegistry,
  type PaymentRow,
} from "../../src/core/payments-kernel/payment-handler.registry.js";
import { fullRefundForCancelledTicket, refundDueAt } from "../../src/modules/payments/payment-rules.js";
import { PaymentsJobsModule } from "../../src/modules/payments/payments-jobs.module.js";
import { PaymentsKernel } from "../../src/modules/payments/payments.kernel.js";
import {
  type AlumniFixtureStatus,
  createAdmin,
  createAlumni,
  createPaymentMethod,
  signInAdmin,
  signInAlumni,
} from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp, type TestAppOptions } from "../support/test-app.js";

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Handler `ticket` penguji yang mengikuti kontrak C3/C5 (aturan tag Events) selama modul events belum tersedia di
 * aplikasi: lockRelated mengunci event lalu tiket; bukti sebelum hold → awaiting_review; hold lewat → tiket expired,
 * kursi dilepas, payment dibatalkan sistem lalu RESERVATION_EXPIRED; approve → paid + QR (tiket batal → tanpa QR dan
 * refund D6); reject/cancel → tiket batal dan hold dilepas.
 */
@Injectable()
export class TestTicketHandler implements OnModuleInit {
  constructor(
    private readonly registry: PaymentHandlerRegistry,
    private readonly kernel: PaymentsKernel,
  ) {}

  onModuleInit(): void {
    if (this.registry.has("ticket")) return;
    this.registry.register({
      type: "ticket",
      lockRelated: async (tx, payment) => {
        if (!payment.ticketId) return;
        const [ticket] = await tx
          .select({ eventId: tickets.eventId })
          .from(tickets)
          .where(eq(tickets.id, payment.ticketId));
        if (!ticket) return;
        await tx.select({ id: events.id }).from(events).where(eq(events.id, ticket.eventId)).for("update");
        await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, payment.ticketId)).for("update");
      },
      onProofSubmitted: async (tx, payment) => {
        const ticket = await this.ticket(tx, payment);
        if (ticket.status === "awaiting_review") return;
        if (ticket.status !== "awaiting_payment") throw new Error("tiket tidak aktif");
        if (ticket.holdExpiresAt && ticket.holdExpiresAt.getTime() <= TestTicketHandler.clockNow()) {
          await tx
            .update(tickets)
            .set({ status: "expired", updatedAt: new Date(TestTicketHandler.clockNow()) })
            .where(and(eq(tickets.id, ticket.id), eq(tickets.status, "awaiting_payment")));
          await tx
            .update(events)
            .set({ heldQuantity: sql`${events.heldQuantity} - 1` })
            .where(eq(events.id, ticket.eventId));
          await this.kernel.cancelForTicket(tx, ticket.id, "Batas reservasi habis", { system: true });
          throw new AppException(409, "RESERVATION_EXPIRED", "Batas reservasi habis.");
        }
        await tx
          .update(tickets)
          .set({ status: "awaiting_review", holdExpiresAt: null })
          .where(eq(tickets.id, ticket.id));
      },
      onApproved: async (tx, payment): Promise<void | PaymentApprovalOutcome> => {
        const ticket = await this.ticket(tx, payment);
        if (ticket.status === "paid") return;
        if (ticket.status === "awaiting_review" || ticket.status === "awaiting_payment") {
          await tx
            .update(tickets)
            .set({ status: "paid", qrCode: randomBytes(16).toString("hex"), holdExpiresAt: null })
            .where(eq(tickets.id, ticket.id));
          await tx
            .update(events)
            .set({
              heldQuantity: sql`${events.heldQuantity} - 1`,
              paidQuantity: sql`${events.paidQuantity} + 1`,
            })
            .where(eq(events.id, ticket.eventId));
          return;
        }
        const [event] = await tx.select().from(events).where(eq(events.id, ticket.eventId));
        if (
          ticket.cancelledAt &&
          fullRefundForCancelledTicket({ ownerPresent: payment.userId !== null, ticket, event: event!, selfCancelDays: 3 })
        )
          return {
            refund: {
              amount: payment.amount,
              dueAt: refundDueAt(ticket.cancelledAt),
              reason: "Event dibatalkan pengurus",
            },
          };
      },
      onRejected: (tx, payment) => this.release(tx, payment, "admin"),
      onCancelled: (tx, payment) => this.release(tx, payment, "admin"),
    });
  }

  /** Diisi createPaymentsApp agar handler memakai TestClock aplikasi. */
  static clockNow: () => number = () => Date.now();

  private async ticket(tx: Tx, payment: PaymentRow) {
    const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, payment.ticketId!));
    if (!ticket) throw new Error("tiket tidak ditemukan");
    return ticket;
  }

  private async release(tx: Tx, payment: PaymentRow, by: "admin" | "system"): Promise<void> {
    const ticket = await this.ticket(tx, payment);
    if (ticket.status !== "awaiting_payment" && ticket.status !== "awaiting_review") return;
    const at = new Date(TestTicketHandler.clockNow());
    await tx
      .update(tickets)
      .set({ status: "cancelled", cancelledAt: at, cancelledBy: by, cancelReason: "Pembayaran tidak diterima" })
      .where(eq(tickets.id, ticket.id));
    await tx
      .update(events)
      .set({ heldQuantity: sql`${events.heldQuantity} - 1` })
      .where(eq(events.id, ticket.eventId));
  }
}

@Module({ imports: [PaymentsJobsModule], providers: [TestTicketHandler] })
export class TestTicketHandlerModule {}

/** Aplikasi uji payments: handler tiket penguji memakai TestClock aplikasi. */
export async function createPaymentsApp(options: TestAppOptions = {}): Promise<TestApp> {
  const t = await createTestApp({ ...options, extraModules: [TestTicketHandlerModule, ...(options.extraModules ?? [])] });
  TestTicketHandler.clockNow = () => t.clock.now().getTime();
  return t;
}

export interface MemberFixture {
  userId: string;
  token: string;
  memberNumber: string | null;
  expiresAt: Date | null;
}

export async function memberSession(
  t: TestApp,
  status: AlumniFixtureStatus = "unverified",
  options: { fullName?: string } = {},
): Promise<MemberFixture> {
  const member = await createAlumni(t, { status, fullName: options.fullName });
  const session = await signInAlumni(t, member);
  return {
    userId: member.userId,
    token: session.accessToken,
    memberNumber: member.memberNumber,
    expiresAt: member.expiresAt,
  };
}

export interface AdminSession {
  adminId: string;
  userId: string;
  token: string;
}

export async function adminSession(
  t: TestApp,
  permissions: Permission[] = ["payments.read", "payments.decide"],
  options: { linkedAlumniUserId?: string | null; role?: "admin" | "super_admin"; displayName?: string } = {},
): Promise<AdminSession> {
  const admin = await createAdmin(t, {
    permissions,
    role: options.role ?? "admin",
    linkedAlumniUserId: options.linkedAlumniUserId ?? null,
    displayName: options.displayName ?? "Bendahara Uji",
  });
  const session = await signInAdmin(t, admin);
  return { adminId: admin.adminId, userId: admin.userId, token: session.accessToken };
}

/** Token X-Reauth-Token seperti POST /auth/reauth (level 2 untuk sesi admin). */
export async function reauthToken(t: TestApp, accessToken: string): Promise<string> {
  const claims = decodeJwt(accessToken);
  const [row] = await t.db
    .select({ familyId: sessions.familyId })
    .from(sessions)
    .where(eq(sessions.id, String(claims.sid)));
  return (
    await t.app
      .get(TokenService)
      .signReauth({ userId: String(claims.sub), familyId: row!.familyId, level: 2 })
  ).token;
}

export async function uploadProof(t: TestApp, token: string): Promise<string> {
  return (await uploadTestFile(t, token, "payment_proof")).id;
}

/** Header aplikasi mobile (X-App-Platform + X-App-Version >= minimum) untuk menguji rencana cadangan D13. */
export function mobileHeaders(platform: "android" | "ios"): Record<string, string> {
  return { "x-app-platform": platform, "x-app-version": "9.9.9" };
}

export interface InstructionFixture {
  paymentId: string;
  version: string;
  methodId: string;
}

/** Instruksi iuran lewat API (POST /me/payments). */
export async function createInstruction(
  t: TestApp,
  member: MemberFixture,
  type: "registration" | "renewal" = "registration",
  methodId?: string,
): Promise<InstructionFixture> {
  const method = methodId ?? (await createPaymentMethod(t)).id;
  const res = await httpClient(t.app).post(
    "/me/payments",
    { type, payment_method_id: method },
    { token: member.token },
  );
  expect(res.statusCode, res.body).toBeOneOf([200, 201]);
  const body = res.json() as { id: string; version: string };
  return { paymentId: body.id, version: body.version, methodId: method };
}

/** Kirim bukti lewat API; mengembalikan PaymentDetail. */
export async function submitProof(
  t: TestApp,
  member: MemberFixture,
  paymentId: string,
  expectedProofVersion = 0,
  fileId?: string,
) {
  const proof = fileId ?? (await uploadProof(t, member.token));
  const res = await httpClient(t.app).put(
    `/me/payments/${paymentId}/proof`,
    { file_id: proof, expected_proof_version: expectedProofVersion, transfer_note: "BSI a.n. Alumni Uji" },
    { token: member.token },
  );
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { id: string; version: string; proof_version: number; proof_file_id: string };
}

/** Payment iuran berbukti (awaiting_review) lewat API. */
export async function reviewablePayment(
  t: TestApp,
  member: MemberFixture,
  type: "registration" | "renewal" = "registration",
) {
  const instruction = await createInstruction(t, member, type);
  const detail = await submitProof(t, member, instruction.paymentId);
  return { paymentId: instruction.paymentId, version: detail.version, proofVersion: detail.proof_version };
}

/** Keputusan pengurus lewat API. */
export function decide(
  t: TestApp,
  admin: AdminSession,
  paymentId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return httpClient(t.app).post(`/admin/payments/${paymentId}/decision`, body, { token: admin.token, headers });
}

/** Menjalankan fn di konteks request penguji (aktor anggota/pengurus/sistem) untuk memanggil kernel langsung. */
export function inContext<T>(actor: Actor, fn: () => Promise<T>): Promise<T> {
  return runInContext(
    {
      requestId: uuidv7(),
      jobId: null,
      clientRequestId: null,
      actor,
      ip: null,
      appVersion: null,
      appPlatform: null,
      source: "test",
    },
    fn,
  );
}

export const memberActor = (userId: string): Actor => ({
  kind: "alumni",
  userId,
  adminId: null,
  adminRole: null,
  sessionId: null,
});

export const systemActor = (): Actor => ({ ...SYSTEM_ACTOR });

export interface TicketFixture {
  eventId: string;
  ticketId: string;
  paymentId: string;
  methodId: string;
}

/**
 * Event berbayar + tiket awaiting_payment (hold 24 jam bawaan) + payment tiket lewat PaymentsKernel.createPayment,
 * seperti reservasi modul events (F-09, D5).
 */
export async function ticketFixture(
  t: TestApp,
  member: MemberFixture,
  options: { price?: string; holdMs?: number; startsInMs?: number; checkinOpensAt?: Date | null } = {},
): Promise<TicketFixture> {
  const now = t.clock.now();
  const price = options.price ?? "75000.00";
  const startsAt = new Date(now.getTime() + (options.startsInMs ?? 10 * DAY_MS));
  const eventId = uuidv7();
  const ticketId = uuidv7();
  const method = await createPaymentMethod(t, { provider: "Bank Event Uji" });
  await t.db.insert(events).values({
    id: eventId,
    title: "Reuni Akbar Uji",
    timezone: "Asia/Jakarta",
    startsAt,
    endsAt: new Date(startsAt.getTime() + 4 * HOUR_MS),
    registrationOpensAt: new Date(now.getTime() - DAY_MS),
    registrationClosesAt: new Date(startsAt.getTime() - HOUR_MS),
    checkinOpensAt: options.checkinOpensAt ?? null,
    checkinClosesAt: options.checkinOpensAt ? new Date(startsAt.getTime() + 4 * HOUR_MS) : null,
    price,
    seatsTotal: 10,
    heldQuantity: 1,
    status: "open",
    createdAt: now,
    updatedAt: now,
  });
  await t.db.insert(tickets).values({
    id: ticketId,
    eventId,
    userId: member.userId,
    status: "awaiting_payment",
    totalSnapshot: price,
    holdExpiresAt: new Date(now.getTime() + (options.holdMs ?? DAY_MS)),
    createdAt: now,
    updatedAt: now,
  });
  const kernel = t.app.get(PaymentsKernel);
  const payment = await inContext(memberActor(member.userId), () =>
    t.db.transaction((tx) =>
      kernel.createPayment(tx, {
        userId: member.userId,
        type: "ticket",
        ticketId,
        amount: price,
        lines: [{ code: "ticket", amount: price }],
        paymentMethodId: method.id,
      }),
    ),
  );
  return { eventId, ticketId, paymentId: payment.id, methodId: method.id };
}

export const DAY = DAY_MS;
export const HOUR = HOUR_MS;
