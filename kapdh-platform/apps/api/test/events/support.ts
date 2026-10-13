/**
 * Fixture uji modul events (ARCHITECTURE §9.1): sesi anggota/pengurus, event dan kategori langsung di database (untuk
 * jendela waktu yang sulit dicapai lewat API), reservasi, bukti dan keputusan pembayaran tiket lewat API.
 */
import type { Permission } from "@kapdh/contracts";
import { categories, events, tickets } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { expect } from "vitest";
import {
  type AlumniFixtureStatus,
  createAdmin,
  type CreateAlumniOptions,
  createAlumni,
  createPaymentMethod,
  signInAdmin,
  signInAlumni,
} from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { httpClient } from "../support/http.js";
import type { TestApp } from "../support/test-app.js";

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

/** Body JSON hasil parse (sudah divalidasi kontrak lewat expectOperation sebelum diperiksa). */
export type JsonBody = ReturnType<typeof JSON.parse>;

export interface MemberFixture {
  userId: string;
  email: string;
  password: string;
  token: string;
  memberNumber: string | null;
}

export async function memberSession(
  t: TestApp,
  status: AlumniFixtureStatus = "verified",
  options: Omit<CreateAlumniOptions, "status"> = {},
): Promise<MemberFixture> {
  const member = await createAlumni(t, { status, ...options });
  const session = await signInAlumni(t, member);
  return {
    userId: member.userId,
    email: member.email,
    password: member.password,
    token: session.accessToken,
    memberNumber: member.memberNumber,
  };
}

/** Access token 15 menit: setelah jam uji dimajukan, sesi baru untuk akun yang sama. */
export async function relogin(t: TestApp, member: MemberFixture): Promise<MemberFixture> {
  const res = await httpClient(t.app).post("/auth/login", { email: member.email, password: member.password });
  expect(res.statusCode, res.body).toBe(200);
  member.token = res.json().session.access_token as string;
  return member;
}

export interface AdminSession {
  adminId: string;
  userId: string;
  token: string;
  permissions: Permission[];
}

export async function adminSession(
  t: TestApp,
  permissions: Permission[] = ["events.manage"],
  options: { linkedAlumniUserId?: string | null; displayName?: string; role?: "admin" | "super_admin" } = {},
): Promise<AdminSession> {
  const admin = await createAdmin(t, {
    permissions,
    role: options.role ?? "admin",
    linkedAlumniUserId: options.linkedAlumniUserId ?? null,
    displayName: options.displayName ?? "Pengurus Event Uji",
  });
  const session = await signInAdmin(t, admin);
  return { adminId: admin.adminId, userId: admin.userId, token: session.accessToken, permissions };
}

export interface EventFixtureOptions {
  title?: string;
  status?: "draft" | "open" | "closed" | "done" | "cancelled";
  price?: string;
  seatsTotal?: number;
  startsInMs?: number;
  durationMs?: number;
  registrationOpensInMs?: number;
  /** Tutup daftar relatif terhadap starts_at (bawaan 1 jam sebelum mulai). */
  registrationClosesBeforeStartMs?: number;
  categoryId?: string | null;
  checkinOpensAt?: Date | null;
  checkinClosesAt?: Date | null;
  locationName?: string | null;
  timezone?: string;
}

/** Event langsung di database (data sintetis), bawaan open berbayar 75.000 dengan 10 kursi, mulai 10 hari lagi. */
export async function createEventRow(t: TestApp, options: EventFixtureOptions = {}) {
  const now = t.clock.now();
  const startsAt = new Date(now.getTime() + (options.startsInMs ?? 10 * DAY));
  const endsAt = new Date(startsAt.getTime() + (options.durationMs ?? 4 * HOUR));
  const status = options.status ?? "open";
  const closesAt = new Date(startsAt.getTime() - (options.registrationClosesBeforeStartMs ?? HOUR));
  // Bawaan: pendaftaran sudah dibuka sehari (atau sehari sebelum tutup untuk event lampau; events_registration_chk).
  const opensAt =
    options.registrationOpensInMs !== undefined
      ? new Date(now.getTime() + options.registrationOpensInMs)
      : new Date(Math.min(now.getTime() - DAY, closesAt.getTime() - DAY));
  const [row] = await t.db
    .insert(events)
    .values({
      id: uuidv7(),
      title: options.title ?? "Reuni Akbar Uji",
      description: "Acara uji.\nBaris kedua.",
      categoryId: options.categoryId ?? null,
      locationName: options.locationName === undefined ? "Aula Pesantren Uji" : options.locationName,
      timezone: options.timezone ?? "Asia/Jakarta",
      startsAt,
      endsAt,
      registrationOpensAt: opensAt,
      registrationClosesAt: closesAt,
      checkinOpensAt: options.checkinOpensAt ?? null,
      checkinClosesAt: options.checkinClosesAt ?? null,
      price: options.price ?? "75000.00",
      seatsTotal: options.seatsTotal ?? 10,
      status,
      cancelledAt: status === "cancelled" ? now : null,
      cancelReason: status === "cancelled" ? "Dibatalkan (uji)" : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row!;
}

export async function createCategory(
  t: TestApp,
  options: { label?: string; active?: boolean; sortOrder?: number; kind?: "event" | "post" } = {},
) {
  const now = t.clock.now();
  const id = uuidv7();
  const [row] = await t.db
    .insert(categories)
    .values({
      id,
      kind: options.kind ?? "event",
      label: options.label ?? "Reuni",
      slug: `kat-${id.slice(-12)}`,
      active: options.active ?? true,
      sortOrder: options.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row!;
}

export async function eventRow(t: TestApp, eventId: string) {
  const [row] = await t.db.select().from(events).where(eq(events.id, eventId));
  return row!;
}

export async function ticketRow(t: TestApp, ticketId: string) {
  const [row] = await t.db.select().from(tickets).where(eq(tickets.id, ticketId));
  return row!;
}

/**
 * Tiket langsung di database untuk keadaan yang tidak dapat dicapai anggota lewat API (mis. tiket paid milik anggota
 * yang kemudian expired/suspended). Penghitung kursi event ikut disesuaikan agar CHECK dan proyeksi tetap konsisten.
 */
export async function insertTicket(
  t: TestApp,
  input: {
    eventId: string;
    userId: string | null;
    status?: "awaiting_payment" | "awaiting_review" | "paid" | "expired" | "cancelled";
    total?: string;
    holdExpiresAt?: Date | null;
    createdAt?: Date;
  },
) {
  const now = t.clock.now();
  const status = input.status ?? "paid";
  const [row] = await t.db
    .insert(tickets)
    .values({
      id: uuidv7(),
      eventId: input.eventId,
      userId: input.userId,
      status,
      totalSnapshot: input.total ?? "0.00",
      holdExpiresAt:
        status === "awaiting_payment" ? (input.holdExpiresAt ?? new Date(now.getTime() + DAY)) : null,
      qrCode: status === "paid" ? uuidv7().replace(/-/g, "") : null,
      cancelledAt: status === "cancelled" ? now : null,
      cancelledBy: status === "cancelled" ? "self" : null,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    })
    .returning();
  const held = status === "awaiting_payment" || status === "awaiting_review" ? 1 : 0;
  const paid = status === "paid" ? 1 : 0;
  if (held || paid) {
    const event = await eventRow(t, input.eventId);
    await t.db
      .update(events)
      .set({ heldQuantity: event.heldQuantity + held, paidQuantity: event.paidQuantity + paid })
      .where(eq(events.id, input.eventId));
  }
  return row!;
}

/** Metode bayar aktif yang dipakai reservasi berbayar. */
export async function methodId(t: TestApp): Promise<string> {
  return (await createPaymentMethod(t, { provider: "Bank Event Uji" })).id;
}

/** POST reservasi lewat API (respons mentah). */
export function reserveRaw(
  t: TestApp,
  member: Pick<MemberFixture, "token">,
  eventId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return httpClient(t.app).post(`/events/${eventId}/reservations`, body, { token: member.token, headers });
}

/** Reservasi yang wajib berhasil; mengembalikan TicketDetail. */
export async function reserve(
  t: TestApp,
  member: Pick<MemberFixture, "token">,
  event: { id: string; price: string },
  method?: string,
): Promise<JsonBody> {
  const free = Number(event.price) === 0;
  const res = await reserveRaw(t, member, event.id, {
    expected_price: event.price,
    ...(free ? {} : { payment_method_id: method ?? (await methodId(t)) }),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

/** Bukti transfer lewat API pembayaran (PUT /me/payments/{id}/proof); mengembalikan PaymentDetail. */
export async function submitProof(
  t: TestApp,
  member: MemberFixture,
  paymentId: string,
  expectedProofVersion = 0,
) {
  const proof = await uploadTestFile(t, member.token, "payment_proof");
  const res = await httpClient(t.app).put(
    `/me/payments/${paymentId}/proof`,
    { file_id: proof.id, expected_proof_version: expectedProofVersion },
    { token: member.token },
  );
  return res;
}

/** Keputusan pengurus payments.decide atas payment tiket berbukti versi 1. */
export async function decidePayment(
  t: TestApp,
  admin: AdminSession,
  paymentId: string,
  decision: "approve" | "reject",
) {
  const detail = await httpClient(t.app).get(`/admin/payments/${paymentId}`, { token: admin.token });
  expect(detail.statusCode, detail.body).toBe(200);
  const body = detail.json();
  return httpClient(t.app).post(
    `/admin/payments/${paymentId}/decision`,
    {
      decision,
      expected_proof_version: body.proof_version,
      expected_version: body.version,
      ...(decision === "approve"
        ? { funds_verified: true }
        : { reason: "Transfer tidak ditemukan di rekening" }),
    },
    { token: admin.token },
  );
}

/** Tiket paid lewat alur penuh: reservasi → bukti → approve (AC F04-1). */
export async function paidTicket(
  t: TestApp,
  member: MemberFixture,
  event: { id: string; price: string },
  treasurer: AdminSession,
): Promise<JsonBody> {
  const reserved = await reserve(t, member, event);
  if (reserved.status === "paid") return reserved;
  const proof = await submitProof(t, member, reserved.payment.id);
  expect(proof.statusCode, proof.body).toBe(200);
  const approved = await decidePayment(t, treasurer, reserved.payment.id, "approve");
  expect(approved.statusCode, approved.body).toBe(200);
  const detail = await httpClient(t.app).get(`/me/tickets/${reserved.id}`, { token: member.token });
  expect(detail.statusCode, detail.body).toBe(200);
  return detail.json();
}
