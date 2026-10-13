/**
 * Sesi perangkat, pencabutan HTTP + socket, dan reautentikasi (F-02, AC F02-4, F02-6, N-08; kontrak listSessions,
 * revokeSession, logout, logoutAll, changePassword, resetPassword, reauthenticate). Socket nyata pada namespace
 * /realtime membuktikan bahwa socket lama ikut dicabut (AC F02-6, PRD 9.2).
 */
import { auditLogs, deviceTokens, mfaTotp, notifications, sessions, users } from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { io, type Socket } from "socket.io-client";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupCodeHash, newBackupCode, totp } from "../../src/core/identity/crypto.js";
import { ProbeModule } from "../core/probe.js";
import { expectOperation, expectRealtimeEnvelope } from "../support/contract.js";
import {
  type AlumniFixture,
  createAdmin,
  createAlumni,
  type EnrolledAdminFixture,
  signInAdmin,
  signInAlumni,
} from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp, testEnv } from "../support/test-app.js";

let t: TestApp;
let api: ReturnType<typeof httpClient>;
let baseUrl: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  // ProbeModule (uji core) menyediakan POST /__probe/sensitive ber-@RequireReauth untuk membuktikan token reauth.
  t = await createTestApp({ extraModules: [ProbeModule] });
  api = httpClient(t.app);
  await t.app.listen(0, "127.0.0.1");
  baseUrl = await t.app.getUrl();
});
afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  await t.app.close();
});

const MOBILE_HEADERS = { "x-app-platform": "android", "x-app-version": "1.4.2" };

interface ConnectError extends Error {
  data?: { code: string };
}

function connect(token: string): Promise<Socket> {
  const socket = io(`${baseUrl}/realtime`, {
    transports: ["websocket"],
    auth: { token },
    reconnection: false,
    forceNew: true,
    timeout: 5000,
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (error: ConnectError) => reject(error));
  });
}

/** Event `session.revoked` berikutnya (amplop + payload divalidasi kontrak events/*.schema.json). */
function revokedEvent(socket: Socket, timeoutMs = 3000): Promise<{ entity_id: string; payload: unknown }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session.revoked tidak diterima")), timeoutMs);
    socket.once("session.revoked", (data: { entity_id: string; payload: unknown }) => {
      clearTimeout(timer);
      resolve(expectRealtimeEnvelope(data));
    });
  });
}

function noRevocation(socket: Socket, ms = 300): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = () => reject(new Error("session.revoked tidak boleh diterima"));
    socket.once("session.revoked", handler);
    setTimeout(() => {
      socket.off("session.revoked", handler);
      resolve();
    }, ms);
  });
}

function disconnected(socket: Socket, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.disconnected) return resolve();
    const timer = setTimeout(() => reject(new Error("socket tidak diputus")), timeoutMs);
    socket.once("disconnect", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function login(member: Pick<AlumniFixture, "email" | "password">, deviceName?: string, headers = {}) {
  const res = await api.post(
    "/auth/login",
    { email: member.email, password: member.password, ...(deviceName ? { device_name: deviceName } : {}) },
    { headers },
  );
  expect(res.statusCode, res.body).toBe(200);
  const session = res.json().session as { access_token: string; refresh_token: string };
  return { accessToken: session.access_token, refreshToken: session.refresh_token };
}

async function familyOf(accessToken: string): Promise<string> {
  const [row] = await t.db
    .select({ familyId: sessions.familyId })
    .from(sessions)
    .where(eq(sessions.id, String(decodeJwt(accessToken).sid)));
  return row!.familyId;
}

interface SessionItem {
  id: string;
  audience: string;
  device_name: string | null;
  platform: string | null;
  app_version: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  current: boolean;
}

async function listSessions(accessToken: string, query: Record<string, string> = {}) {
  const res = await api.get("/auth/sessions", { token: accessToken, query });
  expect(res.statusCode, res.body).toBe(200);
  expectOperation("get", "/auth/sessions", res);
  return res.json() as { items: SessionItem[]; next_cursor: string | null };
}

describe("F-02: daftar sesi perangkat (kontrak listSessions)", () => {
  it("satu item per keluarga sesi: perangkat, platform, versi, current; id dan created_at stabil saat rotasi refresh", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const phone = await login(member, "Samsung A54", MOBILE_HEADERS);
    t.clock.advance(5_000);
    const tablet = await login(member, "iPad", { "x-app-platform": "ios", "x-app-version": "1.4.0" });

    const page = await listSessions(phone.accessToken);
    expect(page.next_cursor).toBeNull();
    expect(page.items).toHaveLength(2);
    // Urutan created_at terbaru lebih dahulu.
    const [newest, oldest] = page.items;
    expect(newest).toMatchObject({
      id: await familyOf(tablet.accessToken),
      audience: "mobile",
      device_name: "iPad",
      platform: "ios",
      app_version: "1.4.0",
      current: false,
    });
    expect(oldest).toMatchObject({
      id: await familyOf(phone.accessToken),
      device_name: "Samsung A54",
      platform: "android",
      app_version: "1.4.2",
      current: true,
    });
    // Tanpa token, hash maupun IP (N-14).
    expect(JSON.stringify(page)).not.toContain(phone.refreshToken);

    t.clock.advance(20 * 60_000);
    const rotated = await api.post(
      "/auth/refresh",
      { refresh_token: phone.refreshToken },
      { headers: MOBILE_HEADERS },
    );
    expect(rotated.statusCode).toBe(200);
    const again = await listSessions(rotated.json().access_token as string);
    const phoneAgain = again.items.find((item) => item.id === oldest!.id)!;
    expect(phoneAgain).toMatchObject({ current: true, created_at: oldest!.created_at });
    expect(new Date(phoneAgain.expires_at).getTime()).toBeGreaterThan(new Date(oldest!.expires_at).getTime());
  });

  it("paging keyset limit + cursor tanpa duplikasi atau item terlewat; cursor rusak → 400", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const devices = [];
    for (let i = 0; i < 3; i++) {
      devices.push(await login(member, `Perangkat ${i}`));
      t.clock.advance(1_000);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listSessions(devices[0]!.accessToken, { limit: "1", ...(cursor ? { cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(1);
      seen.push(...page.items.map((item) => item.device_name!));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toEqual(["Perangkat 2", "Perangkat 1", "Perangkat 0"]);
    const broken = await api.get("/auth/sessions", {
      token: devices[0]!.accessToken,
      query: { cursor: "rusak!" },
    });
    expect(broken.statusCode).toBe(400);
    expectOperation("get", "/auth/sessions", broken);
  });

  it("sesi yang dicabut atau kedaluwarsa tidak tampil; admin hanya melihat sesi web admin miliknya", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const a = await login(member, "A");
    const b = await login(member, "B");
    await api.post("/auth/logout", {}, { token: b.accessToken });
    const c = await login(member, "C");
    await t.db
      .update(sessions)
      .set({ expiresAt: t.clock.now() })
      .where(eq(sessions.familyId, await familyOf(c.accessToken)));
    expect((await listSessions(a.accessToken)).items.map((item) => item.device_name)).toEqual(["A"]);

    const admin = await createAdmin(t, { role: "admin", permissions: ["payments.read"] });
    const adminSession = await signInAdmin(t, admin);
    const adminPage = await listSessions(adminSession.accessToken);
    expect(adminPage.items).toHaveLength(1);
    expect(adminPage.items[0]).toMatchObject({ audience: "admin", platform: "web", current: true });
  });

  it("negatif: tanpa token → 401", async () => {
    const res = await api.get("/auth/sessions");
    expect(res.statusCode).toBe(401);
    expectOperation("get", "/auth/sessions", res);
  });
});

describe("F-02: cabut satu perangkat (kontrak revokeSession)", () => {
  it("perangkat lain dicabut: HTTP 401, refresh 401, token push dicabut, socketnya diputus; sesi ini tetap", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const mine = await login(member, "Milik saya");
    const other = await login(member, "Hilang");
    const otherFamily = await familyOf(other.accessToken);
    const tokenId = uuidv7();
    await t.db.insert(deviceTokens).values({
      id: tokenId,
      userId: member.userId,
      sessionId: String(decodeJwt(other.accessToken).sid),
      platform: "android",
      token: `fcm-uji-${tokenId}`,
      createdAt: t.clock.now(),
      updatedAt: t.clock.now(),
    });
    const mySocket = await connect(mine.accessToken);
    const otherSocket = await connect(other.accessToken);
    const revoked = revokedEvent(otherSocket);
    const closed = disconnected(otherSocket);
    const untouched = noRevocation(mySocket);

    const res = await api.delete(`/auth/sessions/${otherFamily}`, { token: mine.accessToken });
    expect(res.statusCode, res.body).toBe(204);
    expectOperation("delete", "/auth/sessions/{sessionId}", res);
    expect(await revoked).toMatchObject({
      entity_id: otherFamily,
      payload: { reason: "session_revoked", all_sessions: false },
    });
    await closed;
    await untouched;
    expect(mySocket.connected).toBe(true);
    expect((await api.get("/me", { token: other.accessToken })).statusCode).toBe(401);
    expect((await api.post("/auth/refresh", { refresh_token: other.refreshToken })).statusCode).toBe(401);
    expect((await api.get("/me", { token: mine.accessToken })).statusCode).toBe(200);
    const [token] = await t.db.select().from(deviceTokens).where(eq(deviceTokens.id, tokenId));
    expect(token!.revokedAt).not.toBeNull();
    await expect(connect(other.accessToken)).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "session.revoked"), eq(auditLogs.entityId, member.userId)));
    expect(audit!.after).toMatchObject({ session_id: otherFamily, current: false });
  });

  it("negatif: sesi pengguna lain, sudah dicabut, atau tidak dikenal → 404; id bukan UUID → 400", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const intruder = await createAlumni(t, { status: "verified" });
    const victim = await login(member, "Korban");
    const attacker = await login(intruder, "Penyerang");
    const victimFamily = await familyOf(victim.accessToken);
    const foreign = await api.delete(`/auth/sessions/${victimFamily}`, { token: attacker.accessToken });
    expect(foreign.statusCode).toBe(404);
    expectOperation("delete", "/auth/sessions/{sessionId}", foreign);
    expect((await api.get("/me", { token: victim.accessToken })).statusCode).toBe(200);
    expect((await api.delete(`/auth/sessions/${uuidv7()}`, { token: attacker.accessToken })).statusCode).toBe(
      404,
    );
    const malformed = await api.delete("/auth/sessions/bukan-uuid", { token: attacker.accessToken });
    expect(malformed.statusCode).toBe(400);
    expectOperation("delete", "/auth/sessions/{sessionId}", malformed);
    const second = await login(member, "Kedua");
    expect(
      (
        await api.delete(`/auth/sessions/${await familyOf(second.accessToken)}`, {
          token: victim.accessToken,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await api.delete(`/auth/sessions/${await familyOf(second.accessToken)}`, {
          token: victim.accessToken,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("mencabut sesi saat ini = logout (access token sesi ini ditolak)", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const mine = await login(member, "Ini");
    const res = await api.delete(`/auth/sessions/${await familyOf(mine.accessToken)}`, {
      token: mine.accessToken,
    });
    expect(res.statusCode).toBe(204);
    expect((await api.get("/me", { token: mine.accessToken })).statusCode).toBe(401);
  });
});

describe("AC F02-6: keluar semua perangkat memutus HTTP dan socket lama", () => {
  it("AC F02-6: semua sesi dicabut, session_version naik, socket diputus dan tidak dapat tersambung lagi, token push dicabut", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const phone = await login(member, "Ponsel");
    const tablet = await login(member, "Tablet");
    const tokenId = uuidv7();
    await t.db.insert(deviceTokens).values({
      id: tokenId,
      userId: member.userId,
      sessionId: String(decodeJwt(tablet.accessToken).sid),
      platform: "ios",
      token: `fcm-uji-${tokenId}`,
      createdAt: t.clock.now(),
      updatedAt: t.clock.now(),
    });
    const [before] = await t.db.select().from(users).where(eq(users.id, member.userId));
    const phoneSocket = await connect(phone.accessToken);
    const tabletSocket = await connect(tablet.accessToken);
    const events = [revokedEvent(phoneSocket), revokedEvent(tabletSocket)];
    const closed = [disconnected(phoneSocket), disconnected(tabletSocket)];

    const res = await api.post("/auth/logout-all", {}, { token: phone.accessToken });
    expect(res.statusCode).toBe(204);
    expectOperation("post", "/auth/logout-all", res);
    for (const event of await Promise.all(events))
      expect(event.payload).toEqual({ reason: "logout_all", all_sessions: true });
    await Promise.all(closed);

    for (const session of [phone, tablet]) {
      expect((await api.get("/me", { token: session.accessToken })).statusCode).toBe(401);
      expect((await api.get("/auth/sessions", { token: session.accessToken })).statusCode).toBe(401);
      expect((await api.post("/auth/refresh", { refresh_token: session.refreshToken })).statusCode).toBe(401);
      await expect(connect(session.accessToken)).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
    }
    const [after] = await t.db.select().from(users).where(eq(users.id, member.userId));
    expect(after!.sessionVersion).toBe(before!.sessionVersion + 1);
    const [token] = await t.db.select().from(deviceTokens).where(eq(deviceTokens.id, tokenId));
    expect(token!.revokedAt).not.toBeNull();
    const [notice] = await t.db.select().from(notifications).where(eq(notifications.userId, member.userId));
    expect(notice).toMatchObject({
      category: "security",
      title: "Keluar dari semua perangkat",
      data: { event: "logout_all" },
    });
    // Login baru tetap dapat dilakukan.
    expect((await login(member, "Baru")).accessToken).toBeTruthy();
  });

  it("anggota suspended dapat keluar dari semua perangkat (member_access any)", async () => {
    const member = await createAlumni(t, { status: "suspended" });
    const session = await signInAlumni(t, member);
    expect((await api.post("/auth/logout-all", {}, { token: session.accessToken })).statusCode).toBe(204);
  });

  it("admin keluar dari semua sesi: cookie refresh dihapus, tanpa notifikasi inbox (identitas admin)", async () => {
    const admin = await createAdmin(t, { role: "super_admin" });
    const session = await signInAdmin(t, admin);
    const res = await api.post("/auth/logout-all", {}, { token: session.accessToken });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers["set-cookie"])).toContain("kapdh_admin_rt=;");
    const refreshed = await api.post("/auth/refresh", undefined, {
      cookies: { kapdh_admin_rt: session.refreshCookie },
      headers: { origin: testEnv.ADMIN_ORIGIN },
    });
    expect(refreshed.statusCode).toBe(401);
    expect(
      await t.db.select().from(notifications).where(eq(notifications.userId, admin.userId)),
    ).toHaveLength(0);
  });
});

describe("AC F02-4: pencabutan socket saat sandi berganti", () => {
  it("ganti sandi: socket perangkat lain diputus (password_changed); socket sesi ini tetap", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const mine = await login(member, "Ini");
    const other = await login(member, "Lain");
    const mySocket = await connect(mine.accessToken);
    const otherSocket = await connect(other.accessToken);
    const revoked = revokedEvent(otherSocket);
    const untouched = noRevocation(mySocket);
    const res = await api.post(
      "/auth/password/change",
      { current_password: member.password, new_password: "Baru#Kapdh2026" },
      { token: mine.accessToken },
    );
    expect(res.statusCode).toBe(204);
    expect((await revoked).payload).toEqual({ reason: "password_changed", all_sessions: false });
    await disconnected(otherSocket);
    await untouched;
    expect(mySocket.connected).toBe(true);
  });

  it("reset sandi: semua socket diputus (password_reset)", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const session = await login(member, "Ponsel");
    const socket = await connect(session.accessToken);
    const revoked = revokedEvent(socket);
    const challenge = (await api.post("/auth/password/forgot", { email: member.email })).json();
    const grant = (
      await api.post("/auth/password/forgot/verify", {
        challenge_id: challenge.challenge_id,
        code: t.mailer.last(member.email)!,
      })
    ).json();
    expect(
      (
        await api.post("/auth/password/reset", {
          reset_token: grant.reset_token,
          new_password: "Baru#Kapdh2026",
        })
      ).statusCode,
    ).toBe(204);
    expect((await revoked).payload).toEqual({ reason: "password_reset", all_sessions: true });
    await disconnected(socket);
  });
});

describe("kontrak reauthenticate: token X-Reauth-Token <= 10 menit terikat keluarga sesi", () => {
  const sensitive = (accessToken: string, reauth: string) =>
    api.post("/__probe/sensitive", {}, { token: accessToken, headers: { "x-reauth-token": reauth } });

  it("alumni: sandi benar → token aud kapdh-reauth (sid = keluarga sesi, lvl 1, 10 menit) diterima tindakan sensitif", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const session = await login(member, "Ponsel");
    const res = await api.post("/auth/reauth", { password: member.password }, { token: session.accessToken });
    expect(res.statusCode, res.body).toBe(200);
    expectOperation("post", "/auth/reauth", res);
    const { reauth_token: token, expires_at: expiresAt } = res.json() as {
      reauth_token: string;
      expires_at: string;
    };
    const claims = decodeJwt(token);
    expect(claims).toMatchObject({
      aud: "kapdh-reauth",
      sub: member.userId,
      sid: await familyOf(session.accessToken),
      lvl: 1,
    });
    expect(new Date(expiresAt).getTime() - t.clock.now().getTime()).toBeLessThanOrEqual(10 * 60_000);
    const ok = await sensitive(session.accessToken, token);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().reauthenticated).toBe(true);
    const [row] = await t.db
      .select({ reauthenticatedAt: sessions.reauthenticatedAt })
      .from(sessions)
      .where(eq(sessions.id, String(decodeJwt(session.accessToken).sid)));
    expect(row!.reauthenticatedAt?.toISOString()).toBe(t.clock.now().toISOString());
    // Perangkat lain (keluarga lain) tidak dapat memakai token ini.
    const other = await login(member, "Tablet");
    expect((await sensitive(other.accessToken, token)).json().code).toBe("REAUTH_REQUIRED");
    t.clock.advance(10 * 60_000 + 1000);
    const fresh = await login(member, "Ponsel lagi");
    expect((await sensitive(fresh.accessToken, token)).json().code).toBe("REAUTH_REQUIRED");
  });

  it("sandi salah → 400 field_errors.password dengan sisa percobaan; 5 kegagalan per sesi → 429; sesi lain tidak terpengaruh", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const session = await login(member, "Ponsel");
    for (let left = 4; left >= 0; left--) {
      const res = await api.post("/auth/reauth", { password: "Salah#2026x" }, { token: session.accessToken });
      expect(res.statusCode).toBe(400);
      expectOperation("post", "/auth/reauth", res);
      expect(res.json().field_errors.password).toHaveLength(1);
      if (left > 0) expect(res.json().message).toBe(`Sandi salah. Sisa percobaan ${left}.`);
    }
    const limited = await api.post(
      "/auth/reauth",
      { password: member.password },
      { token: session.accessToken },
    );
    expect(limited.statusCode).toBe(429);
    expectOperation("post", "/auth/reauth", limited);
    const other = await login(member, "Tablet");
    expect(
      (await api.post("/auth/reauth", { password: member.password }, { token: other.accessToken }))
        .statusCode,
    ).toBe(200);
  });

  it("keberhasilan mengembalikan jatah: kegagalan sebelumnya tetap dihitung, keberhasilan tidak", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const session = await login(member, "Ponsel");
    await api.post("/auth/reauth", { password: "Salah#2026x" }, { token: session.accessToken });
    expect(
      (await api.post("/auth/reauth", { password: member.password }, { token: session.accessToken }))
        .statusCode,
    ).toBe(200);
    const next = await api.post("/auth/reauth", { password: "Salah#2026x" }, { token: session.accessToken });
    expect(next.json().message).toBe("Sandi salah. Sisa percobaan 3.");
  });

  it("PRD 2.2: anggota suspended tetap dapat reautentikasi (penghapusan akun)", async () => {
    const member = await createAlumni(t, { status: "suspended" });
    const session = await signInAlumni(t, member);
    expect(
      (await api.post("/auth/reauth", { password: member.password }, { token: session.accessToken }))
        .statusCode,
    ).toBe(200);
  });

  describe("admin: sandi + TOTP atau backup code (AC F15-3, F16-1)", () => {
    let admin: EnrolledAdminFixture;
    let accessToken: string;

    beforeAll(async () => {
      admin = await createAdmin(t, { role: "super_admin" });
      accessToken = (await signInAdmin(t, admin)).accessToken;
    });

    /** Kode TOTP langkah waktu yang belum pernah dipakai (server menolak replay). */
    function freshTotp(): string {
      let step = Math.floor(t.clock.now().getTime() / 30_000);
      if (admin.lastTotpStep !== undefined && step <= admin.lastTotpStep) {
        t.clock.advance((admin.lastTotpStep - step + 1) * 30_000);
        step = Math.floor(t.clock.now().getTime() / 30_000);
      }
      admin.lastTotpStep = step;
      return totp(admin.totpSecret, t.clock.now());
    }

    it("sandi + TOTP → token tingkat 2 diterima tindakan sensitif admin; TOTP yang sama tidak dapat diputar ulang", async () => {
      const code = freshTotp();
      const res = await api.post(
        "/auth/reauth",
        { password: admin.password, totp_code: code },
        { token: accessToken },
      );
      expect(res.statusCode, res.body).toBe(200);
      const token = res.json().reauth_token as string;
      expect(decodeJwt(token)).toMatchObject({ lvl: 2, sub: admin.userId, sid: await familyOf(accessToken) });
      expect((await sensitive(accessToken, token)).statusCode).toBe(200);
      const replay = await api.post(
        "/auth/reauth",
        { password: admin.password, totp_code: code },
        { token: accessToken },
      );
      expect(replay.statusCode).toBe(400);
      expect(replay.json().field_errors.totp_code).toBeDefined();
      const [audit] = await t.db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "session.reauthenticated"), eq(auditLogs.entityId, admin.userId)));
      expect(audit).toMatchObject({
        effectiveRole: "super_admin",
        after: { method: "totp", audience: "admin" },
      });
    });

    it("backup code sekali pakai; tanpa faktor kedua atau keduanya → 400; sandi salah → 400 field password", async () => {
      const code = newBackupCode();
      await t.db
        .update(mfaTotp)
        .set({ backupCodeHashes: [backupCodeHash(testEnv.OTP_HMAC_SECRET, code)] })
        .where(eq(mfaTotp.userId, admin.userId));
      const first = await api.post(
        "/auth/reauth",
        { password: admin.password, backup_code: code },
        { token: accessToken },
      );
      expect(first.statusCode, first.body).toBe(200);
      const second = await api.post(
        "/auth/reauth",
        { password: admin.password, backup_code: code },
        { token: accessToken },
      );
      expect(second.statusCode).toBe(400);
      expect(second.json().field_errors.backup_code).toBeDefined();
      const none = await api.post("/auth/reauth", { password: admin.password }, { token: accessToken });
      expect(none.statusCode).toBe(400);
      expect(none.json().field_errors.totp_code).toBeDefined();
      const both = await api.post(
        "/auth/reauth",
        { password: admin.password, totp_code: "123456", backup_code: "ABCDE-FGHIJ" },
        { token: accessToken },
      );
      expect(both.statusCode).toBe(400);
      const wrong = await api.post(
        "/auth/reauth",
        { password: "Salah#2026x", totp_code: freshTotp() },
        { token: accessToken },
      );
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().field_errors.password).toBeDefined();
    });
  });

  it("negatif: tanpa token → 401; token tahap sandi admin → 401", async () => {
    expect((await api.post("/auth/reauth", { password: "x" })).statusCode).toBe(401);
    const admin = await createAdmin(t, { role: "admin" });
    const mfa = (
      await api.post("/admin/auth/login", { email: admin.email, password: admin.password })
    ).json();
    const res = await api.post("/auth/reauth", { password: admin.password }, { token: mfa.mfa_token });
    expect(res.statusCode).toBe(401);
    expectOperation("post", "/auth/reauth", res);
  });
});
