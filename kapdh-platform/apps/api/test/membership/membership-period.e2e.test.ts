import { alumni, membershipEvents } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addCalendarMonthsJakarta } from "../../src/core/membership/period.js";
import { expectOperation } from "../support/contract.js";
import { type AlumniFixture, createAlumni, signInAlumni } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { adminWith, approveMembershipPayment, getCard } from "./helpers.js";

/**
 * Periode keanggotaan (F-07, PRD 2.1, 3.7, 4.2): GET /me/membership dan status yang dihitung dari timestamp pada
 * request (AC F07-1..F07-5). Persetujuan payment disimulasikan seperti modul payments (payment paid +
 * MembershipKernel.applyPaidPayment); aturan keputusan payment sendiri diuji di slice payments.
 */

let t: TestApp;
const DAY_MS = 24 * 3600_000;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

type MembershipBody = {
  effective_status: string;
  member_number: string | null;
  card_issued_at: string | null;
  starts_at: string | null;
  expires_at: string | null;
  renewal_eligible: boolean;
  renewal_opens_at: string | null;
  renewal_payment: unknown;
  periods: { kind: string; starts_at: string; expires_at: string; approved_at: string; payment_id: string | null }[];
};

async function membershipOf(fixture: AlumniFixture): Promise<MembershipBody> {
  // Login setiap kali: jam uji dimajukan melewati umur access token 15 menit.
  const session = await signInAlumni(t, fixture);
  const res = await httpClient(t.app).get("/me/membership", { token: session.accessToken });
  expect(res.statusCode, res.body).toBe(200);
  return expectOperation("get", "/me/membership", res) as MembershipBody;
}

async function meOf(fixture: AlumniFixture) {
  const session = await signInAlumni(t, fixture);
  const res = await httpClient(t.app).get("/me", { token: session.accessToken });
  expect(res.statusCode).toBe(200);
  return { session, me: expectOperation("get", "/me", res) as Record<string, unknown> };
}

describe("GET /me/membership (F-07)", () => {
  it("AC F07-1: renewal sebelum expired dimulai dari expires_at lama; histori activation lalu renewal terbaru lebih dulu", async () => {
    const fixture = await createAlumni(t, { status: "unverified" });
    const initial = await membershipOf(fixture);
    expect(initial).toMatchObject({
      effective_status: "unverified",
      member_number: fixture.memberNumber,
      starts_at: null,
      expires_at: null,
      renewal_eligible: false,
      renewal_opens_at: null,
      periods: [],
    });
    expect(initial.card_issued_at).toEqual(expect.any(String));

    const activatedAt = t.clock.now();
    const registration = await approveMembershipPayment(t, fixture.userId, "registration", activatedAt);
    const firstExpiry = addCalendarMonthsJakarta(activatedAt, 12);

    // 20 hari sebelum habis: jendela renewal terbuka, renewal disetujui → masa baru dari expires_at lama.
    t.clock.set(new Date(firstExpiry.getTime() - 20 * DAY_MS));
    const before = await membershipOf(fixture);
    expect(before).toMatchObject({ effective_status: "expiring", renewal_eligible: true });
    const renewalApprovedAt = t.clock.now();
    const renewal = await approveMembershipPayment(t, fixture.userId, "renewal", renewalApprovedAt);
    const after = await membershipOf(fixture);
    expect(after).toMatchObject({
      effective_status: "verified",
      starts_at: activatedAt.toISOString(),
      expires_at: addCalendarMonthsJakarta(firstExpiry, 12).toISOString(),
      renewal_eligible: false,
    });
    expect(after.periods).toEqual([
      {
        kind: "renewal",
        starts_at: firstExpiry.toISOString(),
        expires_at: addCalendarMonthsJakarta(firstExpiry, 12).toISOString(),
        approved_at: renewalApprovedAt.toISOString(),
        payment_id: renewal.payment.id,
      },
      {
        kind: "activation",
        starts_at: activatedAt.toISOString(),
        expires_at: firstExpiry.toISOString(),
        approved_at: activatedAt.toISOString(),
        payment_id: registration.payment.id,
      },
    ]);
  });

  it("AC F07-2: renewal setelah expired dihitung dari approved_at dan akses aktif kembali", async () => {
    const fixture = await createAlumni(t, { status: "expired" });
    expect((await meOf(fixture)).me.effective_status).toBe("expired");
    const approvedAt = t.clock.now();
    await approveMembershipPayment(t, fixture.userId, "renewal", approvedAt);
    const membership = await membershipOf(fixture);
    expect(membership).toMatchObject({
      effective_status: "verified",
      starts_at: approvedAt.toISOString(),
      expires_at: addCalendarMonthsJakarta(approvedAt, 12).toISOString(),
    });
    expect(membership.periods[0]).toMatchObject({ kind: "renewal", starts_at: approvedAt.toISOString() });
    // Akses aktif kembali: endpoint tingkat active (direktori, chat) memakai status yang sama; kartu kembali Aktif.
    const session = await signInAlumni(t, fixture);
    expect((await getCard(t, session.accessToken)).status_label).toBe("active");
  });

  it("AC F07-3: batas waktu lewat saat worker terlambat → status dihitung benar dari timestamp pada request", async () => {
    const fixture = await createAlumni(t, { status: "verified" });
    const expiresAt = fixture.expiresAt!;
    t.clock.set(new Date(expiresAt.getTime() - 30 * DAY_MS - 1));
    expect((await meOf(fixture)).me.effective_status).toBe("verified");
    t.clock.set(new Date(expiresAt.getTime() - 30 * DAY_MS));
    expect((await meOf(fixture)).me.effective_status).toBe("expiring");
    t.clock.set(new Date(expiresAt.getTime() - 1));
    expect((await meOf(fixture)).me.effective_status).toBe("expiring");
    // now >= expires_at → expired tanpa job apa pun (tidak ada kolom status yang diperbarui worker).
    t.clock.set(expiresAt);
    const { me, session } = await meOf(fixture);
    expect(me.effective_status).toBe("expired");
    expect((await getCard(t, session.accessToken)).status_label).toBe("expired");
    const [row] = await t.db.select().from(alumni).where(eq(alumni.userId, fixture.userId));
    expect(row!.expiresAt).toEqual(expiresAt);
  });

  it("AC F07-4: anggota suspended, pembayaran lama disetujui → periode diperbarui tetapi effective_status tetap suspended", async () => {
    const fixture = await createAlumni(t, { status: "suspended" });
    const oldExpiry = fixture.expiresAt!;
    const { applied } = await approveMembershipPayment(t, fixture.userId, "renewal");
    expect(applied.outcome).toBe("applied");
    const membership = await membershipOf(fixture);
    expect(membership).toMatchObject({
      effective_status: "suspended",
      expires_at: addCalendarMonthsJakarta(oldExpiry, 12).toISOString(),
      // Suspend menutup kelayakan pembayaran baru (PRD 2.2).
      renewal_eligible: false,
    });
    const { me } = await meOf(fixture);
    expect(me).toMatchObject({ effective_status: "suspended", renewal_eligible: false });
    const [row] = await t.db.select().from(alumni).where(eq(alumni.userId, fixture.userId));
    expect(row!.suspendedAt).not.toBeNull();
  });

  it("AC F07-5: jendela renewal dibuka 30 hari sebelum habis dan tetap terbuka setelah expired (tanpa masa tenggang)", async () => {
    const fixture = await createAlumni(t, { status: "verified" });
    const expiresAt = fixture.expiresAt!;
    const opensAt = new Date(expiresAt.getTime() - 30 * DAY_MS);

    t.clock.set(new Date(opensAt.getTime() - 1));
    let state = await membershipOf(fixture);
    expect(state).toMatchObject({ renewal_eligible: false, renewal_opens_at: opensAt.toISOString() });
    const early = await signInAlumni(t, fixture);
    expect((await getCard(t, early.accessToken)).action).toBeNull();

    t.clock.set(opensAt);
    state = await membershipOf(fixture);
    expect(state.renewal_eligible).toBe(true);
    const open = await signInAlumni(t, fixture);
    expect((await getCard(t, open.accessToken)).action).toBe("renew");

    t.clock.set(new Date(expiresAt.getTime() + 90 * DAY_MS));
    state = await membershipOf(fixture);
    expect(state).toMatchObject({ effective_status: "expired", renewal_eligible: true });
  });

  it("PRD 2.1: periode 12 bulan kalender Jakarta dengan klem akhir bulan (29 Februari)", async () => {
    const fixture = await createAlumni(t, { status: "unverified" });
    // 29 Februari 2032 10:00 WIB (jam uji hanya bergerak maju).
    const approvedAt = new Date("2032-02-29T03:00:00Z");
    t.clock.set(approvedAt);
    await approveMembershipPayment(t, fixture.userId, "registration", approvedAt);
    const membership = await membershipOf(fixture);
    expect(membership.expires_at).toBe("2033-02-28T03:00:00.000Z");
    const [event] = await t.db
      .select()
      .from(membershipEvents)
      .where(eq(membershipEvents.userId, fixture.userId));
    expect(event!.kind).toBe("activation");
  });

  it("Akses: semua status bersesi dapat membaca (termasuk suspended); token admin 403; tanpa sesi 401", async () => {
    const suspended = await createAlumni(t, { status: "suspended" });
    expect((await membershipOf(suspended)).effective_status).toBe("suspended");
    const api = httpClient(t.app);
    expect((await api.get("/me/membership")).statusCode).toBe(401);
    const { token } = await adminWith(t, ["members.read"]);
    expect((await api.get("/me/membership", { token })).statusCode).toBe(403);
  });
});
