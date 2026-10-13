import {
  accountDeletions,
  auditLogs,
  deviceTokens,
  events,
  outboxEvents,
  paymentAdjustments,
  payments,
  roomMembers,
  rooms,
  sessions,
  tickets,
  users,
} from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AccountDeletionController,
  WebDeletionController,
} from "../../src/modules/account/account.controller.js";
import { DeletionRequestService } from "../../src/modules/account/deletion-request.service.js";
import { accessMismatches, expectOperation } from "../support/contract.js";
import {
  type AlumniFixtureStatus,
  createAdmin,
  createAlumni,
  signInAdmin,
  signInAlumni,
} from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { routeAccessList } from "../support/routes.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { insertEvent, reauthHeader } from "./support.js";

/**
 * Penghapusan akun dari aplikasi (F-14, AC F14-1; kontrak account.yaml getAccountDeletionDisclosure,
 * requestAccountDeletion): pengungkapan + peringatan pribadi, reautentikasi <= 10 menit, konfirmasi eksplisit,
 * satu permintaan terbuka, sesi/socket dicabut, nomor permintaan tampil.
 */

let t: TestApp;
const DAY = 24 * 3600_000;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

async function signedIn(status: AlumniFixtureStatus = "verified") {
  const member = await createAlumni(t, { status });
  const session = await signInAlumni(t, member);
  return { member, session };
}

async function disclosureOf(token: string) {
  const res = await httpClient(t.app).get("/me/deletion/disclosure", { token });
  expect(res.statusCode, res.body).toBe(200);
  return expectOperation("get", "/me/deletion/disclosure", res) as {
    version: string;
    active_tickets: Record<string, unknown>[];
    pending_refunds: Record<string, unknown>[];
    open_payments: Record<string, unknown>[];
    sole_admin_group_count: number;
    linked_admin_identity: boolean;
    deleted_data: { category: string }[];
    retained_data: { category: string }[];
  };
}

describe("Dekorator akses vs kontrak (x-kapdh-access)", () => {
  it("setiap operasi domain account memakai dekorator yang sama persis dengan kontrak", () => {
    const routes = routeAccessList(t.app).filter((route) =>
      [AccountDeletionController.name, WebDeletionController.name].some((name) =>
        route.name.startsWith(`${name}.`),
      ),
    );
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      "get /me/deletion/disclosure",
      "post /me/deletion",
      "post /public/deletion/challenge",
      "post /public/deletion/confirm",
      "post /public/deletion/verify",
    ]);
    expect(accessMismatches(routes)).toEqual([]);
  });
});

describe("GET /me/deletion/disclosure (N-15, D2, PRD 3.9, 4.4)", () => {
  it("AC F14-1, N-15: kategori data dihapus/anonim, backup 30 hari, batas 7 hari, tanpa peringatan untuk akun bersih", async () => {
    const { session } = await signedIn();
    const disclosure = await disclosureOf(session.accessToken);
    expect(disclosure).toMatchObject({
      estimated_completion_days: 7,
      backup_retention_days: 30,
      privacy_policy_slug: "kebijakan-privasi",
      active_tickets: [],
      pending_refunds: [],
      open_payments: [],
      sole_admin_group_count: 0,
      linked_admin_identity: false,
    });
    expect(disclosure.deleted_data.map((d) => d.category)).toEqual(
      expect.arrayContaining([
        "credentials",
        "profile",
        "contacts",
        "avatar",
        "payment_proofs",
        "chat_content",
      ]),
    );
    expect(disclosure.retained_data.map((d) => d.category).sort()).toEqual(
      ["audit_logs", "membership_history", "moderation_reports", "payments", "tickets"].sort(),
    );
  });

  it("PRD 3.9 D6, PRD 4.4, AC F14-5, PRD 3.14: peringatan tiket aktif + kebijakan refund, refund belum ditransfer, payment pending, grup admin tunggal, identitas pengurus", async () => {
    const { member, session } = await signedIn();
    await createAdmin(t, { linkedAlumniUserId: member.userId });
    const now = t.clock.now();
    const early = await insertEvent(t, { startsInDays: 10, paid: 1 });
    const late = await insertEvent(t, { startsInDays: 2, paid: 1 });
    const held = await insertEvent(t, { startsInDays: 20, held: 1 });
    const insertTicket = async (eventId: string, status: "paid" | "awaiting_payment") => {
      const id = uuidv7();
      await t.db.insert(tickets).values({
        id,
        eventId,
        userId: member.userId,
        status,
        totalSnapshot: "50000.00",
        holdExpiresAt: status === "awaiting_payment" ? new Date(now.getTime() + DAY) : null,
        qrCode: status === "paid" ? `qr-${id}` : null,
        createdAt: now,
        updatedAt: now,
      });
      return id;
    };
    const earlyTicket = await insertTicket(early, "paid");
    const lateTicket = await insertTicket(late, "paid");
    const heldTicket = await insertTicket(held, "awaiting_payment");
    const paymentId = uuidv7();
    await t.db.insert(payments).values({
      id: paymentId,
      userId: member.userId,
      type: "ticket",
      status: "pending",
      amount: "50000.00",
      linesSnapshot: [],
      methodSnapshot: {},
      ticketId: heldTicket,
      proofVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const paidPayment = uuidv7();
    await t.db.insert(payments).values({
      id: paidPayment,
      userId: member.userId,
      type: "ticket",
      status: "paid",
      amount: "50000.00",
      linesSnapshot: [],
      methodSnapshot: {},
      ticketId: earlyTicket,
      proofVersion: 1,
      decidedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const refundId = uuidv7();
    await t.db.insert(paymentAdjustments).values({
      id: refundId,
      paymentId: paidPayment,
      kind: "refund",
      amount: "50000.00",
      reason: "Refund uji",
      status: "pending",
      refundDestination: { account_number: "123" },
      dueAt: new Date(now.getTime() + 7 * DAY),
      createdAt: now,
      updatedAt: now,
    });
    const roomId = uuidv7();
    await t.db
      .insert(rooms)
      .values({ id: roomId, kind: "group", name: "Grup Budi", createdAt: now, updatedAt: now });
    await t.db.insert(roomMembers).values({
      roomId,
      userId: member.userId,
      role: "admin",
      status: "joined",
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const disclosure = await disclosureOf(session.accessToken);
    expect(disclosure.linked_admin_identity).toBe(true);
    expect(disclosure.sole_admin_group_count).toBe(1);
    const byTicket = Object.fromEntries(disclosure.active_tickets.map((x) => [x.ticket_id, x]));
    expect(byTicket[earlyTicket]).toMatchObject({
      status: "paid",
      refund_policy: "full_refund",
      event_cancelled: false,
    });
    expect(byTicket[lateTicket]).toMatchObject({ status: "paid", refund_policy: "no_refund" });
    expect(byTicket[heldTicket]).toMatchObject({
      status: "awaiting_payment",
      refund_policy: "payment_pending",
    });
    expect(disclosure.pending_refunds).toEqual([
      expect.objectContaining({
        adjustment_id: refundId,
        payment_id: paidPayment,
        destination_provided: true,
      }),
    ]);
    expect(JSON.stringify(disclosure.pending_refunds)).not.toContain("123");
    expect(disclosure.open_payments).toEqual([
      expect.objectContaining({ payment_id: paymentId, type: "ticket", proof_submitted: false }),
    ]);

    // Tiket event yang dibatalkan pengurus: refund penuh (D6); anggota suspended: case_by_case.
    await t.db.update(events).set({ status: "cancelled", cancelledAt: now }).where(eq(events.id, late));
    const cancelled = await disclosureOf(session.accessToken);
    expect(cancelled.active_tickets.find((x) => x.ticket_id === lateTicket)).toMatchObject({
      refund_policy: "full_refund",
      event_cancelled: true,
    });
    expect(cancelled.version).not.toBe(disclosure.version);
  });

  it("negatif: tanpa token 401, token sesi admin 403 FORBIDDEN (audience mobile)", async () => {
    const api = httpClient(t.app);
    const anon = await api.get("/me/deletion/disclosure");
    expect(anon.statusCode).toBe(401);
    expectOperation("get", "/me/deletion/disclosure", anon);
    const admin = await createAdmin(t, { role: "super_admin" });
    const adminSession = await signInAdmin(t, admin);
    const forbidden = await api.get("/me/deletion/disclosure", { token: adminSession.accessToken });
    expect(forbidden.statusCode).toBe(403);
    expect(expectOperation("get", "/me/deletion/disclosure", forbidden)).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("POST /me/deletion (AC F14-1)", () => {
  it("AC F14-1: reautentikasi + konfirmasi → satu permintaan, deletion_pending, sesi/token push dicabut, nomor tampil, audit + outbox dalam satu transaksi", async () => {
    const { member, session } = await signedIn();
    const second = await signInAlumni(t, member);
    const now = t.clock.now();
    await t.db.insert(deviceTokens).values({
      id: uuidv7(),
      userId: member.userId,
      platform: "android",
      token: `fcm-${uuidv7()}`,
      createdAt: now,
      updatedAt: now,
    });
    const { version } = await disclosureOf(session.accessToken);
    const api = httpClient(t.app);
    const res = await api.post(
      "/me/deletion",
      { confirm: true, acknowledged_disclosure_version: version },
      { token: session.accessToken, headers: await reauthHeader(t, session.accessToken) },
    );
    expect(res.statusCode, res.body).toBe(202);
    const body = expectOperation("post", "/me/deletion", res) as Record<string, string>;
    expect(body).toMatchObject({ status: "pending", source: "app", completed_at: null });
    expect(body.request_number).toMatch(/^DEL-2026-[0-9A-Z]{8}$/);
    expect(new Date(body.estimated_completion_at!).getTime() - new Date(body.requested_at!).getTime()).toBe(
      7 * DAY,
    );

    const [user] = await t.db.select().from(users).where(eq(users.id, member.userId));
    expect(user!.status).toBe("deletion_pending");
    const open = await t.db.select().from(accountDeletions).where(eq(accountDeletions.userId, member.userId));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ requestNumber: body.request_number, status: "pending", source: "app" });
    const active = await t.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, member.userId)));
    expect(active.every((s) => s.revokedAt !== null)).toBe(true);
    const tokens = await t.db.select().from(deviceTokens).where(eq(deviceTokens.userId, member.userId));
    expect(tokens.every((d) => d.revokedAt !== null)).toBe(true);
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, member.userId), eq(auditLogs.action, "account.deletion_requested")));
    expect(audit).toMatchObject({ actorUserId: member.userId, effectiveRole: "alumni" });
    expect(audit!.after).toMatchObject({ request_number: body.request_number, source: "app" });
    const [event] = await t.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.dedupKey, `account.deletion.requested:${open[0]!.id}`));
    expect(event!.payload).toEqual({ deletion_id: open[0]!.id, user_id: member.userId });

    // Semua sesi (termasuk perangkat kedua) ditolak; status terlihat lewat login (challenge sandi terbatas).
    for (const token of [session.accessToken, second.accessToken])
      expect((await api.get("/me/deletion/disclosure", { token })).statusCode).toBe(401);
    const login = await api.post("/auth/login", { email: member.email, password: member.password });
    expect(login.json()).toMatchObject({
      next: "deletion_pending",
      deletion: { request_number: body.request_number, status: "pending" },
    });
  });

  it("F-14: tanpa X-Reauth-Token atau token keluarga sesi lain → 403 REAUTH_REQUIRED; konfirmasi bukan true → 400; tidak ada permintaan dibuat", async () => {
    const { member, session } = await signedIn();
    const other = await signInAlumni(t, member);
    const { version } = await disclosureOf(session.accessToken);
    const api = httpClient(t.app);
    const noReauth = await api.post(
      "/me/deletion",
      { confirm: true, acknowledged_disclosure_version: version },
      { token: session.accessToken },
    );
    expect(noReauth.statusCode).toBe(403);
    expect(expectOperation("post", "/me/deletion", noReauth)).toMatchObject({ code: "REAUTH_REQUIRED" });
    const foreign = await api.post(
      "/me/deletion",
      { confirm: true, acknowledged_disclosure_version: version },
      { token: session.accessToken, headers: await reauthHeader(t, other.accessToken) },
    );
    expect(foreign.statusCode).toBe(403);
    // Reautentikasi lebih dari 10 menit lalu tidak berlaku.
    const stale = await reauthHeader(t, session.accessToken);
    t.clock.advance(11 * 60_000);
    const expired = await api.post(
      "/me/deletion",
      { confirm: true, acknowledged_disclosure_version: version },
      { token: (await signInAlumni(t, member)).accessToken, headers: stale },
    );
    expect(expired.statusCode).toBe(403);
    const fresh = await signInAlumni(t, member);
    const notConfirmed = await api.post(
      "/me/deletion",
      { confirm: false, acknowledged_disclosure_version: version },
      { token: fresh.accessToken, headers: await reauthHeader(t, fresh.accessToken) },
    );
    expect(notConfirmed.statusCode).toBe(400);
    expect(expectOperation("post", "/me/deletion", notConfirmed)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { confirm: [expect.any(String)] },
    });
    const rows = await t.db.select().from(accountDeletions).where(eq(accountDeletions.userId, member.userId));
    expect(rows).toHaveLength(0);
    const [user] = await t.db.select().from(users).where(eq(users.id, member.userId));
    expect(user!.status).toBe("active");
  });

  it("F-14: versi pengungkapan usang → 409 VERSION_CONFLICT dengan current terkini; konfirmasi ulang dengan versi baru berhasil", async () => {
    const { member, session } = await signedIn();
    const { version } = await disclosureOf(session.accessToken);
    const now = t.clock.now();
    await t.db.insert(payments).values({
      id: uuidv7(),
      userId: member.userId,
      type: "renewal",
      status: "pending",
      amount: "10000.00",
      linesSnapshot: [],
      methodSnapshot: {},
      settingsVersion: 1,
      proofVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const api = httpClient(t.app);
    const headers = await reauthHeader(t, session.accessToken);
    const stale = await api.post(
      "/me/deletion",
      { confirm: true, acknowledged_disclosure_version: version },
      { token: session.accessToken, headers },
    );
    expect(stale.statusCode).toBe(409);
    const conflict = expectOperation("post", "/me/deletion", stale) as {
      code: string;
      current: { version: string; open_payments: unknown[] };
    };
    expect(conflict.code).toBe("VERSION_CONFLICT");
    expect(conflict.current.open_payments).toHaveLength(1);
    expect(conflict.current.version).not.toBe(version);
    const ok = await api.post(
      "/me/deletion",
      { confirm: true, acknowledged_disclosure_version: conflict.current.version },
      { token: session.accessToken, headers },
    );
    expect(ok.statusCode, ok.body).toBe(202);
  });

  it("F-14: anggota suspended (deletion-only) dan expired tetap dapat menghapus akun", async () => {
    for (const status of ["suspended", "expired", "unverified"] as const) {
      const { member, session } = await signedIn(status);
      const { version } = await disclosureOf(session.accessToken);
      const res = await httpClient(t.app).post(
        "/me/deletion",
        { confirm: true, acknowledged_disclosure_version: version },
        { token: session.accessToken, headers: await reauthHeader(t, session.accessToken) },
      );
      expect(res.statusCode, `${status}: ${res.body}`).toBe(202);
      const [user] = await t.db.select().from(users).where(eq(users.id, member.userId));
      expect(user!.status).toBe("deletion_pending");
    }
  });

  it("AC F14-1: permintaan bersamaan dari dua perangkat → satu permintaan terbuka, keduanya menerima nomor yang sama", async () => {
    const { member, session } = await signedIn();
    const other = await signInAlumni(t, member);
    const { version } = await disclosureOf(session.accessToken);
    const api = httpClient(t.app);
    const body = { confirm: true, acknowledged_disclosure_version: version };
    const [a, b] = await Promise.all([
      api.post("/me/deletion", body, {
        token: session.accessToken,
        headers: await reauthHeader(t, session.accessToken),
      }),
      api.post("/me/deletion", body, {
        token: other.accessToken,
        headers: await reauthHeader(t, other.accessToken),
      }),
    ]);
    const accepted = [a, b].filter((r) => r.statusCode === 202);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    for (const res of [a, b]) expect([202, 401]).toContain(res.statusCode);
    const numbers = new Set(accepted.map((r) => r.json().request_number));
    expect(numbers.size).toBe(1);
    const rows = await t.db.select().from(accountDeletions).where(eq(accountDeletions.userId, member.userId));
    expect(rows).toHaveLength(1);
  });

  it("AC F14-1: respons hilang lalu diulang dengan Idempotency-Key sama → sesi sudah dicabut (401); status tetap terlihat lewat login dengan nomor yang sama", async () => {
    const { member, session } = await signedIn();
    const { version } = await disclosureOf(session.accessToken);
    const api = httpClient(t.app);
    const headers = { ...(await reauthHeader(t, session.accessToken)), "idempotency-key": uuidv7() };
    const body = { confirm: true, acknowledged_disclosure_version: version };
    const first = await api.post("/me/deletion", body, { token: session.accessToken, headers });
    expect(first.statusCode).toBe(202);
    const replay = await api.post("/me/deletion", body, { token: session.accessToken, headers });
    expect(replay.statusCode).toBe(401);
    expectOperation("post", "/me/deletion", replay);
    const login = await api.post("/auth/login", { email: member.email, password: member.password });
    expect(login.json().deletion.request_number).toBe(first.json().request_number);
    const rows = await t.db.select().from(accountDeletions).where(eq(accountDeletions.userId, member.userId));
    expect(rows).toHaveLength(1);
  });

  it("negatif: token admin 403 FORBIDDEN; tanpa token 401", async () => {
    const api = httpClient(t.app);
    const admin = await createAdmin(t, { role: "super_admin" });
    const adminSession = await signInAdmin(t, admin);
    const forbidden = await api.post(
      "/me/deletion",
      { confirm: true, acknowledged_disclosure_version: "x" },
      { token: adminSession.accessToken },
    );
    expect(forbidden.statusCode).toBe(403);
    expect(expectOperation("post", "/me/deletion", forbidden)).toMatchObject({ code: "FORBIDDEN" });
    const anon = await api.post("/me/deletion", { confirm: true, acknowledged_disclosure_version: "x" });
    expect(anon.statusCode).toBe(401);
  });
});

describe("PRD 3.14, AC F16-2: Super Admin terakhir", () => {
  it("PRD 3.14: transisi penghapusan pada identitas Super Admin terakhir ditolak trigger dan dipetakan ke 409 yang jelas; akun alumni tertautnya tetap dapat meminta penghapusan", async () => {
    // Database tersendiri agar Super Admin ini benar-benar satu-satunya yang aktif.
    const own = await createTestApp();
    try {
      const alumniAccount = await createAlumni(own, { status: "verified" });
      const last = await createAdmin(own, { role: "super_admin", linkedAlumniUserId: alumniAccount.userId });
      const requests = own.app.get(DeletionRequestService);
      const attempt = own.db.transaction(async (tx) => {
        const user = await requests.lockUser(tx, last.userId);
        return requests.create(tx, user!, {
          source: "app",
          expectedStatus: "active",
          actor: { kind: "system", userId: null, adminId: null, adminRole: null },
        });
      });
      await expect(attempt).rejects.toMatchObject({
        status: 409,
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("Super Admin terakhir"),
      });
      const [still] = await own.db.select().from(users).where(eq(users.id, last.userId));
      expect(still!.status).toBe("active");
      expect(
        await own.db.select().from(accountDeletions).where(eq(accountDeletions.userId, last.userId)),
      ).toEqual([]);

      const session = await signInAlumni(own, alumniAccount);
      const disclosure = await httpClient(own.app).get("/me/deletion/disclosure", {
        token: session.accessToken,
      });
      expect(disclosure.json().linked_admin_identity).toBe(true);
      const res = await httpClient(own.app).post(
        "/me/deletion",
        { confirm: true, acknowledged_disclosure_version: disclosure.json().version },
        { token: session.accessToken, headers: await reauthHeader(own, session.accessToken) },
      );
      expect(res.statusCode, res.body).toBe(202);
    } finally {
      await own.app.close();
    }
  });
});
