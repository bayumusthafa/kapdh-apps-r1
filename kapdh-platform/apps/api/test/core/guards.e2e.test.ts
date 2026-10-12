import { adminPermissions, admins, alumni, sessions, users } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TokenService } from "../../src/modules/auth/token.service.js";
import {
  type AlumniFixtureStatus,
  createAdmin,
  createAlumni,
  signInAdmin,
  signInAlumni,
} from "../support/factories.js";
import { type HttpClient, httpClient } from "../support/http.js";
import { routeAccessList } from "../support/routes.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { ProbeModule } from "./probe.js";

let t: TestApp;
let api: HttpClient;

beforeAll(async () => {
  t = await createTestApp({ extraModules: [ProbeModule] });
  api = httpClient(t.app);
});
afterAll(async () => {
  await t.app.close();
});

async function memberToken(status: AlumniFixtureStatus) {
  const member = await createAlumni(t, { status });
  return { member, ...(await signInAlumni(t, member)) };
}

describe("ARCHITECTURE §4.3: AuthGuard global menolak secara bawaan", () => {
  it("setiap rute terdaftar menyatakan @Public atau @Audience dengan kombinasi dekorator yang sah", async () => {
    // Aplikasi produksi tanpa modul penguji: semua controller modul domain.
    const prod = await createTestApp();
    try {
      const routes = routeAccessList(prod.app);
      for (const route of routes) expect(route.meta.problems, route.name).toEqual([]);
      // Pengaman pemindai: rute yang pasti ada ikut diperiksa, lengkap dengan metode dan path.
      expect(routes.map((r) => `${r.method.toUpperCase()} ${r.path} ${r.name}`)).toEqual(
        expect.arrayContaining([
          "POST /auth/register AuthController.register",
          "GET /me MeController.me",
          "GET /health/ready HealthController.ready",
        ]),
      );
      // Inventaris yang sama dengan rute Fastify terdaftar (tidak ada handler yang terlewat pemindai).
      const fastify = prod.app.getHttpAdapter().getInstance();
      for (const route of routes)
        expect(
          fastify.hasRoute({
            method: route.method.toUpperCase() as "GET",
            url: `/api/v1${route.path.replace(/{([^}]+)}/g, ":$1")}`,
          }),
          route.name,
        ).toBe(true);
    } finally {
      await prod.app.close();
    }
  });

  it("rute tanpa dekorator akses ditolak walau membawa token sah", async () => {
    const { accessToken } = await memberToken("verified");
    const res = await api.get("/__probe/undeclared", { token: accessToken });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");
    expect(res.body).not.toContain("leaked");
    expect((await api.get("/__probe/undeclared")).statusCode).toBe(403);
  });

  it("deklarasi tidak sah (@MemberAccess pada audience admin) ditolak", async () => {
    const admin = await createAdmin(t, { role: "super_admin" });
    const { accessToken } = await signInAdmin(t, admin);
    expect((await api.get("/__probe/misdeclared", { token: accessToken })).statusCode).toBe(403);
  });

  it("@Audience('any') + @MemberAccess hanya membatasi sesi mobile; sesi admin lolos", async () => {
    const suspended = await memberToken("suspended");
    expect((await api.get("/__probe/any/active", { token: suspended.accessToken })).json().code).toBe(
      "ACCOUNT_SUSPENDED",
    );
    const verified = await memberToken("verified");
    expect((await api.get("/__probe/any/active", { token: verified.accessToken })).json()).toMatchObject({
      effective_status: "verified",
    });
    const admin = await createAdmin(t, { role: "admin" });
    const { accessToken } = await signInAdmin(t, admin);
    const res = await api.get("/__probe/any/active", { token: accessToken });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ audience: "admin", effective_status: null });
  });

  it("@Public tidak memerlukan token dan aktor anonim", async () => {
    const res = await api.get("/__probe/public");
    expect(res.statusCode).toBe(200);
    expect(res.json().actor).toBe("anonymous");
  });

  it("@Audience menolak tanpa token (401), token rusak (401), dan audience lain (403)", async () => {
    expect((await api.get("/__probe/member/any")).statusCode).toBe(401);
    expect((await api.get("/__probe/member/any", { token: "bukan.jwt.valid" })).statusCode).toBe(401);
    const admin = await createAdmin(t, { role: "super_admin" });
    const { accessToken } = await signInAdmin(t, admin);
    const res = await api.get("/__probe/member/any", { token: accessToken });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");
  });

  it("aktor konteks request diisi guard (alumni/admin) untuk audit", async () => {
    const { accessToken } = await memberToken("verified");
    expect((await api.get("/__probe/any", { token: accessToken })).json().actor).toBe("alumni");
    const admin = await createAdmin(t, { role: "admin" });
    const session = await signInAdmin(t, admin);
    const res = await api.get("/__probe/any", { token: session.accessToken });
    expect(res.json()).toMatchObject({ actor: "admin", admin_id: admin.adminId, admin_role: "admin" });
  });
});

describe("PRD 2.2: @MemberAccess memakai effective_status per request", () => {
  const matrix: [AlumniFixtureStatus, Record<"any" | "nonsuspended" | "active", number | string>][] = [
    ["unverified", { any: 200, nonsuspended: 200, active: "MEMBERSHIP_REQUIRED" }],
    ["verified", { any: 200, nonsuspended: 200, active: 200 }],
    ["expiring", { any: 200, nonsuspended: 200, active: 200 }],
    ["expired", { any: 200, nonsuspended: 200, active: "MEMBERSHIP_REQUIRED" }],
    ["suspended", { any: 200, nonsuspended: "ACCOUNT_SUSPENDED", active: "ACCOUNT_SUSPENDED" }],
  ];

  it.each(matrix)("status %s", async (status, expected) => {
    const { accessToken } = await memberToken(status);
    for (const level of ["any", "nonsuspended", "active"] as const) {
      const res = await api.get(`/__probe/member/${level}`, { token: accessToken });
      const want = expected[level];
      if (want === 200) {
        expect(res.statusCode, `${status}/${level}`).toBe(200);
        expect(res.json().effective_status).toBe(status);
      } else {
        expect(res.statusCode, `${status}/${level}`).toBe(403);
        expect(res.json().code, `${status}/${level}`).toBe(want);
      }
    }
  });

  it("AC F07-3: masa aktif habis saat sesi berjalan langsung menutup akses aktif tanpa menunggu worker", async () => {
    const { member, accessToken } = await memberToken("expiring");
    expect((await api.get("/__probe/member/active", { token: accessToken })).statusCode).toBe(200);
    await t.db
      .update(alumni)
      .set({ expiresAt: t.clock.now(), startsAt: new Date(t.clock.now().getTime() - 86_400_000) })
      .where(eq(alumni.userId, member.userId));
    const res = await api.get("/__probe/member/active", { token: accessToken });
    expect(res.json().code).toBe("MEMBERSHIP_REQUIRED");
  });

  it("suspend berlaku seketika untuk token yang sudah diterbitkan (PRD 4.2)", async () => {
    const { member, accessToken } = await memberToken("verified");
    await t.db
      .update(alumni)
      .set({ suspendedAt: t.clock.now(), suspensionReason: "uji", suspensionMessage: "Dibatasi." })
      .where(eq(alumni.userId, member.userId));
    expect((await api.get("/__probe/member/active", { token: accessToken })).json().code).toBe(
      "ACCOUNT_SUSPENDED",
    );
    expect((await api.get("/me", { token: accessToken })).json().effective_status).toBe("suspended");
  });
});

describe("AC F15-1, F16-3: @RequirePermission dievaluasi dari database setiap request", () => {
  it("izin yang tepat diterima; izin kurang ditolak 403", async () => {
    const admin = await createAdmin(t, { permissions: ["payments.read"] });
    const { accessToken } = await signInAdmin(t, admin);
    const ok = await api.get("/__probe/admin/payments", { token: accessToken });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().permissions).toEqual(["payments.read"]);
    // Semua izin yang dideklarasikan wajib dimiliki.
    const missing = await api.get("/__probe/admin/decide", { token: accessToken });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().code).toBe("FORBIDDEN");
  });

  it("super_admin memiliki semua izin tanpa baris admin_permissions", async () => {
    const admin = await createAdmin(t, { role: "super_admin" });
    const { accessToken } = await signInAdmin(t, admin);
    const res = await api.get("/__probe/admin/decide", { token: accessToken });
    expect(res.statusCode).toBe(200);
    expect(res.json().permissions).toHaveLength(15);
  });

  it("AC F16-3: izin dicabut berlaku pada request berikutnya walau token belum kedaluwarsa", async () => {
    const admin = await createAdmin(t, { permissions: ["payments.read", "payments.decide"] });
    const { accessToken } = await signInAdmin(t, admin);
    expect((await api.get("/__probe/admin/decide", { token: accessToken })).statusCode).toBe(200);
    await t.db.delete(adminPermissions).where(eq(adminPermissions.adminId, admin.adminId));
    expect((await api.get("/__probe/admin/decide", { token: accessToken })).statusCode).toBe(403);
    expect((await api.get("/__probe/admin/payments", { token: accessToken })).statusCode).toBe(403);
  });

  it("admin dinonaktifkan langsung ditolak; akun alumni tertaut tersedia untuk cek konflik kepentingan", async () => {
    const linked = await createAlumni(t, { status: "verified" });
    const admin = await createAdmin(t, { permissions: ["payments.read"], linkedAlumniUserId: linked.userId });
    const { accessToken } = await signInAdmin(t, admin);
    const res = await api.get("/__probe/admin/payments", { token: accessToken });
    expect(res.json().linked_alumni_user_id).toBe(linked.userId);
    await t.db
      .update(admins)
      .set({ status: "disabled", disabledAt: t.clock.now() })
      .where(eq(admins.id, admin.adminId));
    expect((await api.get("/__probe/admin/payments", { token: accessToken })).statusCode).toBe(403);
  });

  it("@RequirePermission menolak sesi mobile (403)", async () => {
    const { accessToken } = await memberToken("verified");
    expect((await api.get("/__probe/admin/payments", { token: accessToken })).statusCode).toBe(403);
  });
});

describe("ARCHITECTURE §4.3: @RequireAnyPermission (permissions_any) dan @RequireRole (role) dari database", () => {
  it("permissions_any: salah satu izin cukup, tanpa izin itu 403; super_admin selalu lolos", async () => {
    for (const permission of ["members.read", "master.manage"] as const) {
      const admin = await createAdmin(t, { permissions: [permission] });
      const { accessToken } = await signInAdmin(t, admin);
      expect((await api.get("/__probe/admin/masters", { token: accessToken })).statusCode, permission).toBe(
        200,
      );
    }
    const other = await createAdmin(t, { permissions: ["payments.read"] });
    const otherSession = await signInAdmin(t, other);
    const denied = await api.get("/__probe/admin/masters", { token: otherSession.accessToken });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe("FORBIDDEN");
    const superAdmin = await createAdmin(t, { role: "super_admin" });
    const superSession = await signInAdmin(t, superAdmin);
    expect((await api.get("/__probe/admin/masters", { token: superSession.accessToken })).statusCode).toBe(
      200,
    );
  });

  it("AC F16-3: izin any-of yang dicabut berlaku pada request berikutnya", async () => {
    const admin = await createAdmin(t, { permissions: ["members.read"] });
    const { accessToken } = await signInAdmin(t, admin);
    expect((await api.get("/__probe/admin/masters", { token: accessToken })).statusCode).toBe(200);
    await t.db.delete(adminPermissions).where(eq(adminPermissions.adminId, admin.adminId));
    expect((await api.get("/__probe/admin/masters", { token: accessToken })).statusCode).toBe(403);
  });

  it("role super_admin: admin biasa dengan semua izin tetap 403; peran diturunkan berlaku seketika", async () => {
    const admin = await createAdmin(t, {
      permissions: ["members.read", "members.manage", "admins.manage", "settings.manage"],
    });
    const { accessToken } = await signInAdmin(t, admin);
    const denied = await api.get("/__probe/admin/super", { token: accessToken });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe("FORBIDDEN");

    // Super Admin kedua agar penurunan peran tidak melanggar penjaga Super Admin terakhir (AC F16-2).
    await createAdmin(t, { role: "super_admin" });
    const superAdmin = await createAdmin(t, { role: "super_admin" });
    const superSession = await signInAdmin(t, superAdmin);
    const ok = await api.get("/__probe/admin/super", { token: superSession.accessToken });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().admin_role).toBe("super_admin");
    await t.db.update(admins).set({ role: "admin" }).where(eq(admins.id, superAdmin.adminId));
    expect((await api.get("/__probe/admin/super", { token: superSession.accessToken })).statusCode).toBe(403);
  });

  it("sesi mobile ditolak 403; deklarasi any-of pada audience mobile ditolak (fail closed)", async () => {
    const { accessToken } = await memberToken("verified");
    expect((await api.get("/__probe/admin/masters", { token: accessToken })).statusCode).toBe(403);
    expect((await api.get("/__probe/admin/super", { token: accessToken })).statusCode).toBe(403);
    const misdeclared = await api.get("/__probe/misdeclared/any-permission", { token: accessToken });
    expect(misdeclared.statusCode).toBe(403);
    expect(misdeclared.body).not.toContain("leaked");
  });
});

describe("ARCHITECTURE §4.3: @RequireReauth (X-Reauth-Token aud kapdh-reauth, terikat sesi, 10 menit)", () => {
  async function reauthToken(accessToken: string, level = 1) {
    const claims = decodeJwt(accessToken);
    return (
      await t.app
        .get(TokenService)
        .signReauth({ userId: String(claims.sub), sessionId: String(claims.sid), level })
    ).token;
  }

  it("tanpa header atau token rusak → 403 REAUTH_REQUIRED", async () => {
    const { accessToken } = await memberToken("verified");
    const missing = await api.post("/__probe/sensitive", {}, { token: accessToken });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().code).toBe("REAUTH_REQUIRED");
    const broken = await api.post(
      "/__probe/sensitive",
      {},
      { token: accessToken, headers: { "x-reauth-token": "x" } },
    );
    expect(broken.json().code).toBe("REAUTH_REQUIRED");
  });

  it("token reauth sesi ini diterima dan kedaluwarsa setelah 10 menit", async () => {
    const { accessToken } = await memberToken("verified");
    const reauth = await reauthToken(accessToken);
    const ok = await api.post(
      "/__probe/sensitive",
      {},
      { token: accessToken, headers: { "x-reauth-token": reauth } },
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json().reauthenticated).toBe(true);
    t.clock.advance(10 * 60_000 + 1000);
    // Access token masih berlaku (15 menit), reauth tidak.
    const late = await api.post(
      "/__probe/sensitive",
      {},
      { token: accessToken, headers: { "x-reauth-token": reauth } },
    );
    expect(late.json().code).toBe("REAUTH_REQUIRED");
  });

  it("token reauth sesi lain atau access token sebagai reauth ditolak", async () => {
    const a = await memberToken("verified");
    const b = await memberToken("verified");
    const otherSession = await reauthToken(b.accessToken);
    expect(
      (
        await api.post(
          "/__probe/sensitive",
          {},
          { token: a.accessToken, headers: { "x-reauth-token": otherSession } },
        )
      ).json().code,
    ).toBe("REAUTH_REQUIRED");
    expect(
      (
        await api.post(
          "/__probe/sensitive",
          {},
          { token: a.accessToken, headers: { "x-reauth-token": a.accessToken } },
        )
      ).json().code,
    ).toBe("REAUTH_REQUIRED");
    // Token reauth tidak dapat dipakai sebagai access token.
    const reauth = await reauthToken(a.accessToken);
    expect((await api.get("/__probe/member/any", { token: reauth })).statusCode).toBe(401);
  });

  it("sesi admin wajib reautentikasi dengan TOTP (level 2)", async () => {
    const admin = await createAdmin(t, { role: "super_admin" });
    const { accessToken } = await signInAdmin(t, admin);
    const passwordOnly = await reauthToken(accessToken, 1);
    expect(
      (
        await api.post(
          "/__probe/sensitive",
          {},
          { token: accessToken, headers: { "x-reauth-token": passwordOnly } },
        )
      ).json().code,
    ).toBe("REAUTH_REQUIRED");
    const withTotp = await reauthToken(accessToken, 2);
    expect(
      (
        await api.post(
          "/__probe/sensitive",
          {},
          { token: accessToken, headers: { "x-reauth-token": withTotp } },
        )
      ).statusCode,
    ).toBe(200);
  });
});

describe("Sesi dan status akun diperiksa setiap request (F-02, PRD 2.2)", () => {
  it("akun disabled ditolak 401 walau access token belum kedaluwarsa", async () => {
    const { member, accessToken } = await memberToken("verified");
    await t.db.update(users).set({ status: "disabled" }).where(eq(users.id, member.userId));
    expect((await api.get("/__probe/member/any", { token: accessToken })).statusCode).toBe(401);
  });

  it("sesi dicabut atau kedaluwarsa ditolak 401", async () => {
    const a = await memberToken("verified");
    await t.db.update(sessions).set({ revokedAt: t.clock.now() }).where(eq(sessions.userId, a.member.userId));
    expect((await api.get("/__probe/member/any", { token: a.accessToken })).statusCode).toBe(401);
    const b = await memberToken("verified");
    await t.db.update(sessions).set({ expiresAt: t.clock.now() }).where(eq(sessions.userId, b.member.userId));
    expect((await api.get("/__probe/member/any", { token: b.accessToken })).statusCode).toBe(401);
  });
});
