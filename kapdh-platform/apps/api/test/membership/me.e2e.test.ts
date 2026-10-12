import {
  alumni,
  alumniProfessions,
  alumniSkills,
  masterProfessions,
  masterSkills,
  payments,
} from "@kapdh/database";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectOperation } from "../support/contract.js";
import {
  type AlumniFixtureStatus,
  createAlumni,
  createMembershipPayment,
  signInAlumni,
} from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

/**
 * GET /me (kontrak final C2, PRD 2.2, AC F02-1, F03-3, F04-2, F07-5, F10-4): status akun/keanggotaan, penunjuk iuran
 * terbuka untuk perutean layar onboarding/perpanjangan, profil lengkap dengan label master historis dan foto URL
 * bertanda tangan (PRD 5.4).
 */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

async function me(status: AlumniFixtureStatus) {
  const member = await createAlumni(t, { status });
  const session = await signInAlumni(t, member);
  const get = async () => {
    const res = await httpClient(t.app).get("/me", { token: session.accessToken });
    expect(res.statusCode).toBe(200);
    return expectOperation("get", "/me", res) as Record<string, unknown> & {
      profile: Record<string, unknown>;
    };
  };
  return { member, session, get };
}

describe("GET /me: kontrak final (C2 Membership)", () => {
  it("AC F03-3, F04-2: penunjuk iuran registration mengikuti tahap awaiting_proof → awaiting_review → rejected", async () => {
    const { member, get } = await me("unverified");
    expect(await get()).toMatchObject({
      account_status: "active",
      effective_status: "unverified",
      starts_at: null,
      expires_at: null,
      renewal_eligible: false,
      renewal_opens_at: null,
      registration_payment: null,
      renewal_payment: null,
    });

    const payment = await createMembershipPayment(t, {
      userId: member.userId,
      type: "registration",
      status: "pending",
    });
    await t.db
      .update(payments)
      .set({ proofVersion: 0, submittedAt: null })
      .where(eq(payments.id, payment.id));
    expect((await get()).registration_payment).toMatchObject({
      id: payment.id,
      stage: "awaiting_proof",
      proof_version: 0,
      rejection_reason: null,
    });

    await t.db
      .update(payments)
      .set({ proofVersion: 1, submittedAt: t.clock.now() })
      .where(eq(payments.id, payment.id));
    expect((await get()).registration_payment).toMatchObject({ stage: "awaiting_review", proof_version: 1 });

    await t.db
      .update(payments)
      .set({ status: "rejected", decidedAt: t.clock.now(), rejectionReason: "Nominal transfer kurang" })
      .where(eq(payments.id, payment.id));
    expect((await get()).registration_payment).toMatchObject({
      stage: "rejected",
      rejection_reason: "Nominal transfer kurang",
    });
  });

  it("AC F07-5: renewal_eligible terbuka 30 hari sebelum habis dan setelah expired; suspend menutupnya", async () => {
    const verified = await (await me("verified")).get();
    expect(verified.renewal_eligible).toBe(false);
    expect(verified.renewal_opens_at).toEqual(expect.any(String));
    expect(verified.cohort_code).toMatch(/^KAPDH \d+$/);
    expect((await (await me("expiring")).get()).renewal_eligible).toBe(true);
    expect((await (await me("expired")).get()).renewal_eligible).toBe(true);
    const suspended = await (await me("suspended")).get();
    expect(suspended).toMatchObject({ effective_status: "suspended", renewal_eligible: false });
    expect(suspended.suspension_message).toEqual(expect.any(String));
  });

  it("AC F10-4: profesi dan keahlian tampil sebagai label historis walau master dinonaktifkan; privasi lengkap", async () => {
    const { member, get } = await me("verified");
    const now = t.clock.now();
    const professionId = uuidv7();
    const skillId = uuidv7();
    await t.db.insert(masterProfessions).values({
      id: professionId,
      label: `Profesi Uji ${professionId.slice(-6)}`,
      active: false,
      createdAt: now,
      updatedAt: now,
    });
    await t.db.insert(masterSkills).values({
      id: skillId,
      label: `Keahlian Uji ${skillId.slice(-6)}`,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await t.db
      .insert(alumniProfessions)
      .values({ alumniUserId: member.userId, professionId, createdAt: now });
    await t.db.insert(alumniSkills).values({ alumniUserId: member.userId, skillId, createdAt: now });
    await t.db
      .update(alumni)
      .set({ phone: "+62 812 0000 0000", bio: "Tentang saya (uji)", socialInstagram: "alumni.uji" })
      .where(eq(alumni.userId, member.userId));

    const body = await get();
    expect(body.profile).toMatchObject({
      profession: { id: professionId, active: false },
      skills: [{ id: skillId, active: true }],
      phone: "+62 812 0000 0000",
      bio: "Tentang saya (uji)",
      social_instagram: "alumni.uji",
      avatar_file_id: null,
      avatar_url: null,
      privacy: { show_in_directory: expect.any(Boolean), show_email: expect.any(Boolean) },
    });
  });

  it("PRD 5.4: avatar_url adalah URL bertanda tangan terikat sesi pemilik yang dapat dibuka", async () => {
    const { member, session, get } = await me("verified");
    const avatar = await uploadTestFile(t, session.accessToken, "avatar");
    await t.db.update(alumni).set({ avatarFileId: avatar.id }).where(eq(alumni.userId, member.userId));
    const body = await get();
    expect(body.profile.avatar_file_id).toBe(avatar.id);
    const url = String(body.profile.avatar_url);
    expect(url.startsWith(`${t.env.API_PUBLIC_URL}/api/v1/files/content/`)).toBe(true);
    const content = await t.app.inject({ method: "GET", url: url.slice(t.env.API_PUBLIC_URL.length) });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("image/jpeg");
  });
});
