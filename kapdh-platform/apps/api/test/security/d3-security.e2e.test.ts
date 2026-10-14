import { auditLogs } from "@kapdh/database";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { totp } from "../../src/core/identity/crypto.js";
import { reauthTokenFor } from "../admin/helpers.js";
import {
  createAdmin,
  createAlumni,
  DEFAULT_PASSWORD,
  publishLegalVersions,
  signInAdmin,
  signInAlumni,
  TEST_CONSENT_VERSION,
} from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { addRoomMember, createGroupRoom, createMessage, reportOk } from "../moderation/fixtures.js";

/**
 * Audit keamanan Fase D, lensa D3 (OWASP ASVS L2). Setiap tes menyatakan perilaku AMAN yang diharapkan dan GAGAL pada
 * kode saat ini, membuktikan cacatnya. Tes ditandai `it.fails` agar suite tetap hijau sampai perbaikan masuk; setelah
 * perbaikan, `it.fails` akan gagal (tes lulus) dan wajib diganti menjadi `it` oleh pembuat perbaikan.
 *
 * Diperbaiki (hardening api-identity, kini `it` biasa): D3-01, D3-03, D3-04, D3-05, D3-06. D3-02 (modul files/moderasi)
 * masih `it.fails`.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  await publishLegalVersions(t);
});
// Setiap uji memulai dengan batas laju kosong (IP uji sama untuk semua permintaan inject).
beforeEach(() => {
  t.rateLimits.clear();
});
afterAll(async () => {
  await t.app.close();
});

const api = () => httpClient(t.app);

function registerBody(email: string) {
  return {
    full_name: "Penyerang Enumerasi",
    gender: "male",
    email,
    password: "Kapdh#2026",
    cohort: 29,
    class_in: 1,
    class_out: 6,
    accept_policy_version: TEST_CONSENT_VERSION,
  };
}

/** Anggaran registrasi per IP per jam (auth.service.ts REGISTER_ATTEMPTS_PER_IP_PER_HOUR). */
const REGISTER_BUDGET_PER_IP = 120;

describe("D3-01 enumerasi email terdaftar tanpa batas laju (PRD 2.5, ASVS 2.2.1)", () => {
  it(
    "POST /auth/register: jawaban 409 'Email sudah terdaftar' tidak memakai anggaran per IP sehingga dapat diulang tanpa batas",
    async () => {
      const victim = await createAlumni(t, { status: "verified" });
      const statuses = new Set<number>();
      for (let i = 0; i <= REGISTER_BUDGET_PER_IP; i++) {
        const res = await api().post("/auth/register", registerBody(victim.email));
        statuses.add(res.statusCode);
        if (res.statusCode === 429) break;
      }
      // Aman: setelah anggaran per IP habis, server menjawab 429 tanpa mengungkap keberadaan email.
      expect(statuses.has(429)).toBe(true);
    },
    120_000,
  );

  it(
    "POST /auth/email-correction: akun pending milik penyerang menjadi oracle email terdaftar tanpa batas (jatah login dikembalikan setiap kali)",
    async () => {
      const victim = await createAlumni(t, { status: "verified" });
      const reg = await api().post("/auth/register", registerBody("penyerang-koreksi@contoh.test"));
      expect(reg.statusCode).toBe(201);
      const challengeId = reg.json().challenge_id as string;
      const statuses: number[] = [];
      for (let i = 0; i < 40; i++) {
        const res = await api().post("/auth/email-correction", {
          challenge_id: challengeId,
          password: "Kapdh#2026",
          new_email: victim.email,
        });
        statuses.push(res.statusCode);
        if (res.statusCode === 429) break;
      }
      // Bukti oracle: jawaban membedakan email terdaftar.
      expect(statuses[0]).toBe(409);
      // Aman: percobaan berulang dibatasi (mis. kuota kirim OTP/registrasi per IP) sebelum 40 kali.
      expect(statuses).toContain(429);
    },
    120_000,
  );
});

describe("D3-02 akses berkas bukti moderasi melewati aturan konflik kepentingan dan audit (PRD 2.3, 3.12, AC F12-2)", () => {
  it.fails(
    "pengurus moderation.read yang tertaut ke terlapor tidak dapat melihat laporannya, tetapi GET /files/{id}/access membuka gambar buktinya tanpa audit",
    async () => {
      const reporter = await createAlumni(t, { status: "verified", fullName: "Pelapor D3" });
      const reporterToken = (await signInAlumni(t, reporter)).accessToken;
      const linked = await createAlumni(t, { status: "verified", fullName: "Alumni Tertaut D3" });
      const linkedToken = (await signInAlumni(t, linked)).accessToken;
      const group = await createGroupRoom(t, { name: "Grup D3", adminId: reporter.userId });
      await addRoomMember(t, group, linked.userId);
      // Akun alumni tertaut mengunggah gambar chat (id berkas diketahui pemiliknya sendiri).
      const image = await uploadTestFile(t, linkedToken, "chat_image");
      const message = await createMessage(t, group, linked.userId, { imageFileId: image.id, body: "foto" });

      const moderator = await createAdmin(t, {
        permissions: ["moderation.read", "moderation.resolve"],
        linkedAlumniUserId: linked.userId,
      });
      const adminToken = (await signInAdmin(t, moderator)).accessToken;

      // Sebelum dilaporkan: sesi admin tidak dapat membuka gambar chat.
      const before = await api().get(`/files/${image.id}/access`, { token: adminToken });
      expect(before.statusCode).toBe(404);

      const reportId = await reportOk(t.app, reporterToken, {
        target_type: "message",
        message_id: message,
        category: "harassment",
        description: "Laporan tersembunyi dari pengurus tertaut.",
      });
      // Laporan terhadap akun tertautnya disembunyikan (konflik kepentingan).
      const hidden = await api().get(`/admin/reports/${reportId}`, { token: adminToken });
      expect(hidden.statusCode).toBe(404);

      const auditBefore = await t.db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.actorAdminId, moderator.adminId), like(auditLogs.action, "moderation.%")));
      const after = await api().get(`/files/${image.id}/access`, { token: adminToken });
      const auditAfter = await t.db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.actorAdminId, moderator.adminId), like(auditLogs.action, "moderation.%")));
      // Aman: tetap 404 (laporan tersembunyi tidak boleh dapat disimpulkan dan buktinya tidak boleh dibuka), atau
      // setidaknya setiap akses bukti tercatat di audit (PRD 3.12 "akses bukti dibatasi dan diaudit").
      expect(after.statusCode).toBe(404);
      expect(auditAfter.length).toBeGreaterThan(auditBefore.length);
    },
  );

  it.fails(
    "pengurus moderation.read tanpa konflik membuka bukti lewat GET /files/{id}/access tanpa jejak audit apa pun",
    async () => {
      const reporter = await createAlumni(t, { status: "verified" });
      const reporterToken = (await signInAlumni(t, reporter)).accessToken;
      const sender = await createAlumni(t, { status: "verified" });
      const senderToken = (await signInAlumni(t, sender)).accessToken;
      const group = await createGroupRoom(t, { adminId: reporter.userId });
      await addRoomMember(t, group, sender.userId);
      const image = await uploadTestFile(t, senderToken, "chat_image");
      const message = await createMessage(t, group, sender.userId, { imageFileId: image.id });
      await reportOk(t.app, reporterToken, {
        target_type: "message",
        message_id: message,
        category: "sexual",
      });
      const moderator = await createAdmin(t, { permissions: ["moderation.read", "moderation.resolve"] });
      const adminToken = (await signInAdmin(t, moderator)).accessToken;

      const res = await api().get(`/files/${image.id}/access`, { token: adminToken });
      expect(res.statusCode).toBe(200);
      const rows = await t.db.select().from(auditLogs).where(eq(auditLogs.actorAdminId, moderator.adminId));
      // Aman: akses bukti tercatat (sama seperti GET /admin/reports/{id} → moderation.report_viewed).
      expect(rows.some((row) => row.entityId === image.id || row.action.startsWith("moderation."))).toBe(
        true,
      );
    },
  );
});

describe("D3-03 mfa_token admin tidak terikat keadaan kredensial (N-08, AC F02-4, F02-6; ASVS 3.3.1)", () => {
  async function newAdminWithPendingMfa() {
    const admin = await createAdmin(t, { permissions: ["members.read"] });
    // Sesi sah admin (perangkat korban).
    const session = await signInAdmin(t, admin);
    // Tahap sandi oleh pihak lain yang mengetahui sandi lama: mfa_token 5 menit.
    const login = await api().post("/admin/auth/login", { email: admin.email, password: admin.password });
    expect(login.statusCode).toBe(200);
    return { admin, session, mfaToken: login.json().mfa_token as string };
  }

  function nextTotp(admin: { totpSecret: string; lastTotpStep?: number }) {
    const step = Math.floor(t.clock.now().getTime() / 30_000);
    if (admin.lastTotpStep !== undefined && step <= admin.lastTotpStep)
      t.clock.advance((admin.lastTotpStep - step + 1) * 30_000);
    return totp(admin.totpSecret, t.clock.now());
  }

  it(
    "mfa_token yang terbit sebelum admin mengganti sandi masih menghasilkan sesi admin baru",
    async () => {
      const { admin, session, mfaToken } = await newAdminWithPendingMfa();
      const changed = await api().post(
        "/admin/auth/password/change",
        { current_password: admin.password, new_password: "Pengurus#Baru2026" },
        { token: session.accessToken },
      );
      expect(changed.statusCode).toBe(204);
      const mfa = await api().post("/admin/auth/mfa", { mfa_token: mfaToken, totp_code: nextTotp(admin) });
      // Aman: kredensial yang dinilai di tahap sandi sudah tidak berlaku → 401.
      expect(mfa.statusCode).toBe(401);
    },
  );

  it(
    "mfa_token yang terbit sebelum 'keluar semua perangkat' masih menghasilkan sesi admin baru",
    async () => {
      const { admin, session, mfaToken } = await newAdminWithPendingMfa();
      const all = await api().post("/auth/logout-all", {}, { token: session.accessToken });
      expect(all.statusCode).toBe(204);
      const mfa = await api().post("/admin/auth/mfa", { mfa_token: mfaToken, totp_code: nextTotp(admin) });
      // Aman: session_version naik → token tahap sandi lama tidak berlaku.
      expect(mfa.statusCode).toBe(401);
    },
  );
});

describe("D3-05 kuota kirim OTP per email tidak dibagi antarmodul (PRD 2.5: 5 kirim per jam per email)", () => {
  it(
    "lupa sandi (kunci otp:<HMAC email>) dan hapus akun web (kunci otp:<email mentah>) masing-masing mengirim 5 OTP per jam ke email yang sama",
    async () => {
      const victim = await createAlumni(t, { status: "verified" });
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push((await api().post("/auth/password/forgot", { email: victim.email })).statusCode);
        t.clock.advance(61_000);
      }
      // Kuota per email modul auth habis setelah 5 kirim.
      expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
      for (let i = 0; i < 5; i++) {
        statuses.push((await api().post("/public/deletion/challenge", { email: victim.email })).statusCode);
        t.clock.advance(61_000);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const sent = t.mailer.sent.filter((mail) => mail.to === victim.email).length;
      // Aman: total email OTP ke satu alamat dalam satu jam <= 5 (kuota dipakai bersama semua tujuan).
      expect(sent).toBeLessThanOrEqual(5);
      // Hapus akun web setelah kuota habis dijawab 429 yang sama (nyata maupun pengganti).
      expect(statuses.slice(6)).toEqual([429, 429, 429, 429, 429]);
    },
  );

  it("hapus akun web lebih dulu lalu pemulihan sandi oleh Super Admin: satu kuota 5 per jam untuk email yang sama", async () => {
    const victim = await createAlumni(t, { status: "verified" });
    for (let i = 0; i < 3; i++) {
      expect((await api().post("/public/deletion/challenge", { email: victim.email })).statusCode).toBe(202);
      t.clock.advance(61_000);
    }
    const superAdmin = await createAdmin(t, { permissions: [], role: "super_admin" });
    const session = await signInAdmin(t, superAdmin);
    const reauth = await reauthTokenFor(t, session.accessToken);
    const reset = () =>
      api().post(
        `/admin/members/${victim.userId}/password-reset`,
        { reason: "Uji kuota OTP lintas modul", confirm: true },
        {
          token: session.accessToken,
          headers: { "idempotency-key": uuidv7(), "x-reauth-token": reauth },
        },
      );
    expect((await reset()).statusCode).toBe(202);
    expect((await reset()).statusCode).toBe(202);
    const limited = await reset();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("D3-06 sesi admin tanpa batas umur absolut (N-08, PRD 5.2 'TTL refresh terpisah dari idle'; ASVS 3.3.2 L2)", () => {
  it(
    "rotasi refresh menggeser kedaluwarsa 12 jam setiap 15 menit sehingga admin aktif tidak pernah wajib autentikasi ulang",
    async () => {
      const admin = await createAdmin(t, { permissions: ["members.read"] });
      let { accessToken, refreshCookie } = await signInAdmin(t, admin);
      const startedAt = t.clock.now().getTime();
      let refreshes = 0;
      let endedAtHours = 0;
      let ended: { me: number; refresh: number | null } | null = null;
      // 14 jam aktivitas: setiap 14 menit satu permintaan admin (aktivitas) lalu refresh terjadwal.
      for (let i = 0; i < 60; i++) {
        t.clock.advance(14 * 60_000);
        const hours = (t.clock.now().getTime() - startedAt) / 3600_000;
        const me = await api().get("/admin/me", { token: accessToken });
        if (me.statusCode !== 200) {
          ended = { me: me.statusCode, refresh: null };
          endedAtHours = hours;
          break;
        }
        const refresh = await api().post(
          "/auth/refresh",
          {},
          { cookies: { kapdh_admin_rt: refreshCookie }, headers: { origin: t.env.ADMIN_ORIGIN } },
        );
        if (refresh.statusCode !== 200) {
          ended = { me: me.statusCode, refresh: refresh.statusCode };
          endedAtHours = hours;
          break;
        }
        refreshes++;
        accessToken = refresh.json().access_token as string;
        refreshCookie = /kapdh_admin_rt=([^;]+)/.exec(String(refresh.headers["set-cookie"]))![1]!;
        // Baris hasil rotasi mewarisi batas keluarga (12 jam sejak login), tidak bergeser.
        const expires = /Expires=([^;]+)/i.exec(String(refresh.headers["set-cookie"]))?.[1];
        expect(Date.parse(expires ?? "")).toBe(Math.floor((startedAt + 12 * 3600_000) / 1000) * 1000);
      }
      // Aman: sebelum 12 jam sesi tetap dapat dipakai dan diperbarui; setelah 12 jam sejak login MFA sesi berakhir
      // (access token dan refresh ditolak 401) dan admin wajib masuk ulang (sandi + TOTP).
      expect(refreshes).toBe(51);
      expect(endedAtHours).toBeGreaterThan(12);
      expect(endedAtHours).toBeLessThanOrEqual(12 + 14 / 60);
      expect(ended).toMatchObject({ me: 401 });
      const late = await api().post(
        "/auth/refresh",
        {},
        { cookies: { kapdh_admin_rt: refreshCookie }, headers: { origin: t.env.ADMIN_ORIGIN } },
      );
      expect(late.statusCode).toBe(401);
    },
    120_000,
  );

  it("refresh mobile juga tidak memperpanjang umur keluarga sesi (60 hari sejak login)", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const login = await api().post("/auth/login", { email: member.email, password: DEFAULT_PASSWORD });
    expect(login.statusCode).toBe(200);
    const first = login.json().session as { refresh_token: string; refresh_expires_at: string };
    t.clock.advance(30 * 24 * 3600_000);
    const rotated = await api().post("/auth/refresh", { refresh_token: first.refresh_token });
    expect(rotated.statusCode).toBe(200);
    // Batas keluarga tetap = login + 60 hari.
    expect(rotated.json().refresh_expires_at).toBe(first.refresh_expires_at);
    t.clock.advance(30 * 24 * 3600_000 + 60_000);
    const expired = await api().post("/auth/refresh", { refresh_token: rotated.json().refresh_token });
    expect(expired.statusCode).toBe(401);
  });
});

describe("D3-04 respons token dan data pribadi tanpa Cache-Control: no-store (RFC 6749 §5.1, ASVS 8.2.1)", () => {
  const noStore = (value: unknown) => String(value ?? "").includes("no-store");

  it(
    "login, verifikasi OTP, refresh, reauth, reset token dan MFA admin tidak mengirim no-store",
    async () => {
      const member = await createAlumni(t, { status: "verified" });
      const login = await api().post("/auth/login", { email: member.email, password: DEFAULT_PASSWORD });
      expect(login.statusCode).toBe(200);
      const refresh = await api().post("/auth/refresh", {
        refresh_token: login.json().session.refresh_token,
      });
      expect(refresh.statusCode).toBe(200);
      const reauth = await api().post(
        "/auth/reauth",
        { password: DEFAULT_PASSWORD },
        { token: refresh.json().access_token },
      );
      expect(reauth.statusCode).toBe(200);
      const forgot = await api().post("/auth/password/forgot", { email: member.email });
      const verify = await api().post("/auth/password/forgot/verify", {
        challenge_id: forgot.json().challenge_id,
        code: t.mailer.last(member.email)!,
      });
      expect(verify.statusCode).toBe(200);
      const admin = await createAdmin(t, { permissions: ["members.read"] });
      const adminLogin = await api().post("/admin/auth/login", {
        email: admin.email,
        password: admin.password,
      });
      const mfa = await api().post("/admin/auth/mfa", {
        mfa_token: adminLogin.json().mfa_token,
        totp_code: totp(admin.totpSecret, t.clock.now()),
      });
      expect(mfa.statusCode).toBe(200);
      const headers = {
        login: login.headers["cache-control"],
        refresh: refresh.headers["cache-control"],
        reauth: reauth.headers["cache-control"],
        reset_token: verify.headers["cache-control"],
        admin_mfa_token: adminLogin.headers["cache-control"],
        admin_session: mfa.headers["cache-control"],
      };
      for (const [name, value] of Object.entries(headers)) expect(noStore(value), name).toBe(true);
    },
  );

  it("GET /me dan GET /admin/members/{id} (PII) tidak mengirim no-store", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const token = (await signInAlumni(t, member)).accessToken;
    const me = await api().get("/me", { token });
    expect(me.statusCode).toBe(200);
    const admin = await createAdmin(t, { permissions: ["members.read"] });
    const adminToken = (await signInAdmin(t, admin)).accessToken;
    const detail = await api().get(`/admin/members/${member.userId}`, { token: adminToken });
    expect(detail.statusCode).toBe(200);
    expect(noStore(me.headers["cache-control"]), "/me").toBe(true);
    expect(noStore(detail.headers["cache-control"]), "/admin/members/{id}").toBe(true);
  });

  it("galat juga no-store + Pragma no-cache; rute yang menyatakan cache publik sendiri tidak ditimpa", async () => {
    const unauth = await api().get("/me");
    expect(unauth.statusCode).toBe(401);
    expect(unauth.headers["cache-control"]).toBe("no-store");
    expect(unauth.headers["pragma"]).toBe("no-cache");
    const config = await api().get("/public/config");
    expect(config.statusCode).toBe(200);
    expect(config.headers["cache-control"]).toBe("public, max-age=30");
    expect(config.headers["pragma"]).toBeUndefined();
  });
});
