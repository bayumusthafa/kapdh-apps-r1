import type { ExecutionContext } from "@nestjs/common";
import { accountDeletions, auditLogs, otpCodes, outboxEvents, sessions, users } from "@kapdh/database";
import { and, eq, sql } from "drizzle-orm";
import { decodeJwt } from "jose";
import { lastValueFrom, throwError } from "rxjs";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppException } from "../../src/core/errors/app-exception.js";
import {
  DECOY_OTP_ROUTES,
  DeletionDecoyOtpInterceptor,
} from "../../src/modules/account/deletion-decoy-otp.interceptor.js";
import { otpExpired } from "../../src/modules/account/otp-policy.js";
import { WebDeletionDecoys } from "../../src/modules/account/web-deletion-decoys.js";
import { expectOperation } from "../support/contract.js";
import { createAdmin, createAlumni, signInAlumni } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

/**
 * Penghapusan akun dari situs /delete-account tanpa aplikasi (F-14, PRD 2.2, 2.5, R2; kontrak account.yaml
 * startWebDeletion, verifyWebDeletion, confirmWebDeletion): challenge email non-enumerasi -> OTP `deletion` ->
 * konfirmasi dengan deletion_token sekali pakai -> nomor permintaan tampil (AC F14-1).
 */

let t: TestApp;
const MINUTE = 60_000;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

type Challenge = {
  challenge_id: string;
  purpose: string;
  email_masked: string;
  expires_at: string;
  resend_available_at: string;
  attempts_left: number;
  max_attempts: number;
};

type Verification = {
  email_masked: string;
  deletable: boolean;
  registration_pending: boolean;
  blocked_reason: string | null;
  deletion: { request_number: string; status: string } | null;
  disclosure: { version: string; open_payments: unknown[] } | null;
  deletion_token: string | null;
  deletion_token_expires_at: string | null;
};

async function challenge(email: string) {
  const res = await httpClient(t.app).post("/public/deletion/challenge", { email });
  return res;
}

async function startChallenge(email: string): Promise<Challenge> {
  const res = await challenge(email);
  expect(res.statusCode, res.body).toBe(202);
  return expectOperation("post", "/public/deletion/challenge", res) as Challenge;
}

async function verify(challengeId: string, code: string) {
  return httpClient(t.app).post("/public/deletion/verify", { challenge_id: challengeId, code });
}

async function verified(email: string): Promise<Verification> {
  const started = await startChallenge(email);
  const code = t.mailer.last(email)!;
  const res = await verify(started.challenge_id, code);
  expect(res.statusCode, res.body).toBe(200);
  return expectOperation("post", "/public/deletion/verify", res) as Verification;
}

async function confirm(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return httpClient(t.app).post("/public/deletion/confirm", body, { headers });
}

/** Kode 6 digit yang pasti berbeda dari kode benar. */
const wrongCode = (code: string | undefined) => (code === "000000" ? "111111" : "000000");

describe("POST /public/deletion/challenge (F-14, PRD 2.5 non-enumerasi)", () => {
  it("PRD 2.5: akun alumni aktif, email tak terdaftar, akun admin dan akun yang sudah dihapus menerima respons berbentuk identik; hanya akun yang memenuhi syarat menerima email", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const admin = await createAdmin(t, {});
    const deleted = await createAlumni(t, { status: "verified", accountStatus: "deleted" });
    const unknown = `tidak-ada-${uuidv7()}@kapdh.test`;
    const sentBefore = t.mailer.sent.length;
    const now = t.clock.now().getTime();

    const results: Challenge[] = [];
    for (const email of [member.email, unknown, admin.email, deleted.email])
      results.push(await startChallenge(email));
    for (const result of results) {
      expect(Object.keys(result).sort()).toEqual([
        "attempts_left",
        "challenge_id",
        "email_masked",
        "expires_at",
        "max_attempts",
        "purpose",
        "resend_available_at",
      ]);
      expect(result).toMatchObject({ purpose: "deletion", attempts_left: 5, max_attempts: 5 });
      expect(result.challenge_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(new Date(result.expires_at).getTime()).toBe(now + 10 * MINUTE);
      expect(new Date(result.resend_available_at).getTime()).toBe(now + MINUTE);
      expect(result.email_masked).toMatch(/\*\*\*@/);
    }
    // Hanya akun alumni yang memenuhi syarat yang benar-benar menerima kode.
    const sent = t.mailer.sent.slice(sentBefore);
    expect(sent).toEqual([expect.objectContaining({ to: member.email, purpose: "deletion" })]);
    const [row] = await t.db.select().from(otpCodes).where(eq(otpCodes.id, results[0]!.challenge_id));
    expect(row).toMatchObject({ userId: member.userId, purpose: "deletion" });
  });

  it("PRD 2.5: batas 5 pengiriman per jam per email sama untuk email terdaftar dan tidak terdaftar (429 identik)", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const unknown = `tidak-ada-${uuidv7()}@kapdh.test`;
    const bodies: string[] = [];
    for (const email of [member.email, unknown]) {
      for (let i = 0; i < 5; i++) expect((await challenge(email)).statusCode).toBe(202);
      const limited = await challenge(email);
      expect(limited.statusCode).toBe(429);
      const error = expectOperation("post", "/public/deletion/challenge", limited) as Record<string, unknown>;
      expect(error).toMatchObject({ code: "RATE_LIMITED", retry_after_seconds: expect.any(Number) });
      bodies.push(String(error.message));
    }
    expect(bodies[0]).toBe(bodies[1]);
  });

  it("F-14: challenge deletion baru menggantikan challenge deletion lama tetapi tidak menyentuh challenge aktivasi; email tidak valid → 400", async () => {
    const pending = await createAlumni(t, { status: "pending_otp" });
    const login = await httpClient(t.app).post("/auth/login", {
      email: pending.email,
      password: pending.password,
    });
    expect(login.json().next).toBe("verify_otp");
    const activationId = login.json().challenge.challenge_id as string;
    const first = await startChallenge(pending.email);
    t.clock.advance(2 * MINUTE);
    const second = await startChallenge(pending.email);
    const rowsByUser = await t.db.select().from(otpCodes).where(eq(otpCodes.userId, pending.userId));
    const byId = Object.fromEntries(rowsByUser.map((row) => [row.id, row]));
    expect(byId[first.challenge_id]!.supersededAt).not.toBeNull();
    expect(byId[second.challenge_id]!.supersededAt).toBeNull();
    expect(byId[activationId]!.supersededAt).toBeNull();

    const invalid = await challenge("bukan-email");
    expect(invalid.statusCode).toBe(400);
    expect(expectOperation("post", "/public/deletion/challenge", invalid)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { email: [expect.any(String)] },
    });
  });
});

describe("POST /public/deletion/verify (F-14, PRD 2.2 challenge terbatas)", () => {
  it("F-14: kode benar → status dan pengungkapan + deletion_token 10 menit terikat akun/challenge/session_version/status; kode dipakai sekali", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const started = await startChallenge(member.email);
    const code = t.mailer.last(member.email)!;
    const wrong = await verify(started.challenge_id, wrongCode(code));
    expect(wrong.statusCode).toBe(400);
    expect(expectOperation("post", "/public/deletion/verify", wrong)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { code: ["Kode salah. Sisa percobaan 4."] },
    });

    const res = await verify(started.challenge_id, code);
    expect(res.statusCode, res.body).toBe(200);
    const body = expectOperation("post", "/public/deletion/verify", res) as Verification;
    expect(body).toMatchObject({
      deletable: true,
      registration_pending: false,
      blocked_reason: null,
      deletion: null,
      disclosure: { version: expect.any(String) },
    });
    const expiresAt = new Date(body.deletion_token_expires_at!).getTime();
    expect(expiresAt - t.clock.now().getTime()).toBeLessThanOrEqual(10 * MINUTE);
    const claims = decodeJwt(body.deletion_token!);
    expect(claims.sub).toBe(member.userId);
    expect(claims.aud).toBe("kapdh-web-deletion");
    expect(claims).toMatchObject({ cid: started.challenge_id, sv: 1, st: "active" });
    // Tidak ada sesi yang diterbitkan (challenge terbatas, PRD 2.2).
    expect(await t.db.select().from(sessions).where(eq(sessions.userId, member.userId))).toEqual([]);

    const reused = await verify(started.challenge_id, code);
    expect(reused.statusCode).toBe(410);
    expect(expectOperation("post", "/public/deletion/verify", reused)).toMatchObject({ code: "OTP_EXPIRED" });
  });

  it("PRD 2.5: challenge pengganti selalu kode salah dengan sisa percobaan yang sama seperti challenge nyata, lalu 410 setelah 5 percobaan", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const real = await startChallenge(member.email);
    const realCode = t.mailer.last(member.email);
    const decoy = await startChallenge(`tidak-ada-${uuidv7()}@kapdh.test`);
    const transcript = async (challengeId: string, code: string) => {
      const out: { status: number; code: string; field: unknown }[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await verify(challengeId, code);
        const error = expectOperation("post", "/public/deletion/verify", res) as {
          code: string;
          field_errors?: { code?: string[] };
        };
        out.push({ status: res.statusCode, code: error.code, field: error.field_errors?.code ?? null });
      }
      return out;
    };
    const realTranscript = await transcript(real.challenge_id, wrongCode(realCode));
    const decoyTranscript = await transcript(decoy.challenge_id, "123456");
    expect(decoyTranscript).toEqual(realTranscript);
    expect(realTranscript.map((x) => x.status)).toEqual([400, 400, 400, 400, 410, 410]);
    expect(realTranscript[0]!.field).toEqual(["Kode salah. Sisa percobaan 4."]);
  });

  it("F-14: kedaluwarsa (10 menit), challenge tak dikenal, atau challenge tujuan lain → 410; kode bukan 6 digit → 400", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const started = await startChallenge(member.email);
    const code = t.mailer.last(member.email)!;
    t.clock.advance(10 * MINUTE + 1000);
    expect((await verify(started.challenge_id, code)).statusCode).toBe(410);
    expect((await verify(uuidv7(), "123456")).statusCode).toBe(410);
    const pending = await createAlumni(t, { status: "pending_otp" });
    const login = await httpClient(t.app).post("/auth/login", {
      email: pending.email,
      password: pending.password,
    });
    const signup = login.json().challenge.challenge_id as string;
    expect((await verify(signup, t.mailer.last(pending.email)!)).statusCode).toBe(410);
    const malformed = await verify(started.challenge_id, "12ab");
    expect(malformed.statusCode).toBe(400);
    expect(expectOperation("post", "/public/deletion/verify", malformed)).toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("PRD 2.2: akun deletion_pending → deletable false + status permintaan; akun disabled → account_disabled; tanpa token", async () => {
    const pendingDeletion = await createAlumni(t, { status: "verified", accountStatus: "deletion_pending" });
    const inProgress = await verified(pendingDeletion.email);
    expect(inProgress).toMatchObject({
      deletable: false,
      registration_pending: false,
      blocked_reason: "deletion_in_progress",
      deletion: { request_number: pendingDeletion.deletionRequestNumber, status: "pending" },
      disclosure: null,
      deletion_token: null,
      deletion_token_expires_at: null,
    });
    const disabled = await createAlumni(t, { status: "verified", accountStatus: "disabled" });
    expect(await verified(disabled.email)).toMatchObject({
      deletable: false,
      blocked_reason: "account_disabled",
      deletion: null,
      disclosure: null,
      deletion_token: null,
    });
  });
});

describe("POST /public/deletion/confirm (AC F14-1, F-14)", () => {
  it("AC F14-1: konfirmasi web → satu permintaan sumber web, deletion_pending, sesi dicabut, audit + outbox, nomor permintaan tampil", async () => {
    const member = await createAlumni(t, { status: "verified" });
    await signInAlumni(t, member);
    const result = await verified(member.email);
    const res = await confirm({
      deletion_token: result.deletion_token,
      confirm: true,
      acknowledged_disclosure_version: result.disclosure!.version,
    });
    expect(res.statusCode, res.body).toBe(202);
    const body = expectOperation("post", "/public/deletion/confirm", res) as Record<string, string>;
    expect(body).toMatchObject({ status: "pending", source: "web", completed_at: null });
    expect(body.request_number).toMatch(/^DEL-2026-[0-9A-Z]{8}$/);

    const [user] = await t.db.select().from(users).where(eq(users.id, member.userId));
    expect(user!.status).toBe("deletion_pending");
    expect(user!.sessionVersion).toBe(2);
    const sessionRows = await t.db.select().from(sessions).where(eq(sessions.userId, member.userId));
    expect(sessionRows.length).toBeGreaterThan(0);
    expect(sessionRows.every((s) => s.revokedAt !== null)).toBe(true);
    const [deletion] = await t.db
      .select()
      .from(accountDeletions)
      .where(eq(accountDeletions.userId, member.userId));
    expect(deletion).toMatchObject({ source: "web", status: "pending", requestNumber: body.request_number });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, member.userId), eq(auditLogs.action, "account.deletion_requested")));
    expect(audit).toMatchObject({ actorUserId: member.userId, effectiveRole: "alumni" });
    expect(audit!.after).toMatchObject({ source: "web", request_number: body.request_number });
    expect(JSON.stringify(audit)).not.toContain(member.email);
    const [event] = await t.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.dedupKey, `account.deletion.requested:${deletion!.id}`));
    expect(event).toBeDefined();

    // Token sekali pakai: pengulangan tanpa Idempotency-Key → 410 (status dilihat lewat challenge -> verify).
    const again = await confirm({
      deletion_token: result.deletion_token,
      confirm: true,
      acknowledged_disclosure_version: result.disclosure!.version,
    });
    expect(again.statusCode).toBe(410);
    expect(expectOperation("post", "/public/deletion/confirm", again)).toMatchObject({ code: "OTP_EXPIRED" });
    const status = await verified(member.email);
    expect(status.deletion).toMatchObject({ request_number: body.request_number, status: "pending" });
  });

  it("F-14: pengulangan dengan Idempotency-Key sama mengembalikan respons pertama; satu permintaan saja", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const result = await verified(member.email);
    const payload = {
      deletion_token: result.deletion_token,
      confirm: true,
      acknowledged_disclosure_version: result.disclosure!.version,
    };
    const headers = { "idempotency-key": uuidv7() };
    const first = await confirm(payload, headers);
    expect(first.statusCode).toBe(202);
    const replay = await confirm(payload, headers);
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(first.json());
    expect(
      await t.db.select().from(accountDeletions).where(eq(accountDeletions.userId, member.userId)),
    ).toHaveLength(1);
  });

  it("F-14: anggota suspended mendapat jalur deletion-only (deletable true) dan dapat mengonfirmasi", async () => {
    const member = await createAlumni(t, { status: "suspended" });
    const result = await verified(member.email);
    expect(result).toMatchObject({ deletable: true, registration_pending: false });
    const res = await confirm({
      deletion_token: result.deletion_token,
      confirm: true,
      acknowledged_disclosure_version: result.disclosure!.version,
    });
    expect(res.statusCode, res.body).toBe(202);
  });

  it("F-14: pengungkapan berubah → 409 VERSION_CONFLICT dengan current (token tetap berlaku); konfirmasi bukan true → 400", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const result = await verified(member.email);
    const now = t.clock.now();
    await t.db
      .execute(sql`insert into app.payments (id, user_id, type, status, amount, lines_snapshot, method_snapshot,
      settings_version, proof_version, created_at, updated_at)
      values (${uuidv7()}, ${member.userId}, 'renewal', 'pending', '10000.00', '[]'::jsonb, '{}'::jsonb, 1, 0,
              ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)`);
    const notConfirmed = await confirm({
      deletion_token: result.deletion_token,
      confirm: false,
      acknowledged_disclosure_version: result.disclosure!.version,
    });
    expect(notConfirmed.statusCode).toBe(400);
    expect(expectOperation("post", "/public/deletion/confirm", notConfirmed)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { confirm: [expect.any(String)] },
    });
    const stale = await confirm({
      deletion_token: result.deletion_token,
      confirm: true,
      acknowledged_disclosure_version: result.disclosure!.version,
    });
    expect(stale.statusCode).toBe(409);
    const conflict = expectOperation("post", "/public/deletion/confirm", stale) as {
      code: string;
      current: { version: string; open_payments: unknown[] };
    };
    expect(conflict).toMatchObject({
      code: "VERSION_CONFLICT",
      current: { open_payments: [expect.anything()] },
    });
    const ok = await confirm({
      deletion_token: result.deletion_token,
      confirm: true,
      acknowledged_disclosure_version: conflict.current.version,
    });
    expect(ok.statusCode, ok.body).toBe(202);
  });

  it("F-14: token tidak sah, kedaluwarsa, atau keadaan akun berubah (session_version naik) → 410 yang sama", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const result = await verified(member.email);
    const version = result.disclosure!.version;
    const forged = await confirm({
      deletion_token: `${result.deletion_token!.slice(0, -4)}AAAA`,
      confirm: true,
      acknowledged_disclosure_version: version,
    });
    expect(forged.statusCode).toBe(410);
    // Logout semua perangkat menaikkan session_version → token lama tidak berlaku.
    await t.db
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, member.userId));
    const bumped = await confirm({
      deletion_token: result.deletion_token,
      confirm: true,
      acknowledged_disclosure_version: version,
    });
    expect(bumped.statusCode).toBe(410);
    const fresh = await verified(member.email);
    t.clock.advance(10 * MINUTE + 1000);
    const expired = await confirm({
      deletion_token: fresh.deletion_token,
      confirm: true,
      acknowledged_disclosure_version: fresh.disclosure!.version,
    });
    expect(expired.statusCode).toBe(410);
    for (const res of [forged, bumped, expired])
      expect(expectOperation("post", "/public/deletion/confirm", res)).toMatchObject({
        code: "OTP_EXPIRED",
        message: "Tautan konfirmasi tidak berlaku lagi. Ulangi verifikasi email.",
      });
    const [user] = await t.db.select().from(users).where(eq(users.id, member.userId));
    expect(user!.status).toBe("active");
  });

  it("F-14, D2: pendaftaran pending_otp dibatalkan lewat web; kode aktivasi yang sudah terkirim tidak lagi dapat mengaktifkan akun", async () => {
    const pending = await createAlumni(t, { status: "pending_otp" });
    const login = await httpClient(t.app).post("/auth/login", {
      email: pending.email,
      password: pending.password,
    });
    const activation = login.json().challenge.challenge_id as string;
    const activationCode = t.mailer.last(pending.email)!;
    const result = await verified(pending.email);
    expect(result).toMatchObject({
      deletable: true,
      registration_pending: true,
      disclosure: { open_payments: [] },
    });
    expect(decodeJwt(result.deletion_token!)).toMatchObject({ st: "pending_otp" });
    const res = await confirm({
      deletion_token: result.deletion_token,
      confirm: true,
      acknowledged_disclosure_version: result.disclosure!.version,
    });
    expect(res.statusCode, res.body).toBe(202);
    const [user] = await t.db.select().from(users).where(eq(users.id, pending.userId));
    expect(user!.status).toBe("deletion_pending");
    const activate = await httpClient(t.app).post("/auth/otp/verify", {
      challenge_id: activation,
      code: activationCode,
    });
    expect(activate.statusCode).toBe(410);
    const [after] = await t.db.select().from(users).where(eq(users.id, pending.userId));
    expect(after!.status).toBe("deletion_pending");
  });
});

describe("Challenge pengganti: delegasi kirim ulang/status untuk modul auth (PRD 2.5)", () => {
  it("PRD 2.5: kirim ulang decoy memakai cooldown 60 detik dan kuota yang sama, menggantikan decoy lama; status tanpa mengganti kode", async () => {
    const decoys = t.app.get(WebDeletionDecoys);
    const email = `tidak-ada-${uuidv7()}@kapdh.test`;
    const first = await startChallenge(email);
    expect(decoys.isDecoy(first.challenge_id)).toBe(true);
    const member = await createAlumni(t, { status: "verified" });
    const real = await startChallenge(member.email);
    expect(decoys.isDecoy(real.challenge_id)).toBe(false);
    expect(await decoys.resendIfDecoy(real.challenge_id)).toBeNull();
    expect(await decoys.statusIfDecoy(real.challenge_id)).toBeNull();

    await expect(decoys.resendIfDecoy(first.challenge_id)).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
    });
    expect(await decoys.statusIfDecoy(first.challenge_id)).toEqual(first);
    t.clock.advance(MINUTE);
    const resent = (await decoys.resendIfDecoy(first.challenge_id))!;
    expect(resent).toMatchObject({ purpose: "deletion", attempts_left: 5, email_masked: first.email_masked });
    expect(resent.challenge_id).not.toBe(first.challenge_id);
    await expect(decoys.resendIfDecoy(first.challenge_id)).rejects.toMatchObject({ status: 410 });
    await expect(decoys.statusIfDecoy(first.challenge_id)).rejects.toMatchObject({ status: 410 });
    expect((await verify(first.challenge_id, "123456")).statusCode).toBe(410);
    expect((await verify(resent.challenge_id, "123456")).statusCode).toBe(400);
  });
});

/** Ringkasan respons galat/sukses yang boleh dibandingkan antara email terdaftar dan tidak terdaftar. */
function outcomeOf(res: { statusCode: number; json: () => unknown }) {
  const body = res.json() as Record<string, unknown>;
  if (res.statusCode >= 400)
    return {
      status: res.statusCode,
      code: body.code,
      message: body.message,
      field_errors: body.field_errors ?? null,
      retry_after_seconds: body.retry_after_seconds ?? null,
    };
  const now = t.clock.now().getTime();
  return {
    status: res.statusCode,
    keys: Object.keys(body).sort(),
    purpose: body.purpose,
    attempts_left: body.attempts_left,
    max_attempts: body.max_attempts,
    expires_in: new Date(String(body.expires_at)).getTime() - now,
    resend_in: new Date(String(body.resend_available_at)).getTime() - now,
  };
}

describe("Non-enumerasi lintas challenge dan kirim ulang (PRD 2.5)", () => {
  it("PRD 2.5: challenge kedua untuk email yang sama menggantikan challenge pertama dengan cara yang sama untuk email terdaftar dan tidak terdaftar (verify dan kirim ulang id lama identik)", async () => {
    // Jendela kuota per jam yang bersih untuk uji ini (kuota per IP dipakai bersama seluruh berkas uji).
    t.clock.advance(60 * MINUTE);
    const member = await createAlumni(t, { status: "verified" });
    const unknown = `tidak-ada-${uuidv7()}@kapdh.test`;
    const transcript = async (email: string) => {
      const first = await startChallenge(email);
      const second = await startChallenge(email);
      const api = httpClient(t.app);
      const code = t.mailer.last(email);
      return [
        outcomeOf(await verify(first.challenge_id, "000000")),
        outcomeOf(await api.post("/auth/otp/resend", { challenge_id: first.challenge_id })),
        outcomeOf(await verify(second.challenge_id, wrongCode(code))),
      ];
    };
    const registered = await transcript(member.email);
    const unregistered = await transcript(unknown);
    expect(unregistered).toEqual(registered);
    expect(registered.map((x) => x.status)).toEqual([410, 410, 400]);
    expect(registered[0]).toMatchObject({ code: "OTP_EXPIRED" });
    expect(registered[1]).toMatchObject({
      code: "OTP_EXPIRED",
      message: "Kode ini sudah diganti kode yang lebih baru.",
    });
    expect(registered[2]).toMatchObject({ field_errors: { code: ["Kode salah. Sisa percobaan 4."] } });
  });

  it("PRD 2.5: POST /auth/otp/resend untuk challenge penghapusan web identik bagi email terdaftar dan tidak terdaftar (cooldown 429, 200 dengan challenge baru, 410 untuk id lama); hanya akun nyata menerima kode", async () => {
    t.clock.advance(60 * MINUTE);
    const member = await createAlumni(t, { status: "verified" });
    const unknown = `tidak-ada-${uuidv7()}@kapdh.test`;
    const decoys = t.app.get(WebDeletionDecoys);
    const transcript = async (email: string) => {
      const api = httpClient(t.app);
      const resend = (challengeId: string) => api.post("/auth/otp/resend", { challenge_id: challengeId });
      const first = await startChallenge(email);
      const sentBefore = t.mailer.sent.length;
      const out = [outcomeOf(await resend(first.challenge_id))];
      t.clock.advance(MINUTE + 1000);
      const resent = await resend(first.challenge_id);
      expect(resent.statusCode, resent.body).toBe(200);
      const next = expectOperation("post", "/auth/otp/resend", resent) as Challenge;
      expect(next.challenge_id).not.toBe(first.challenge_id);
      expect(next.email_masked).toBe(first.email_masked);
      out.push(outcomeOf(resent));
      out.push(outcomeOf(await resend(first.challenge_id)));
      out.push(outcomeOf(await resend(next.challenge_id)));
      out.push(outcomeOf(await verify(first.challenge_id, "000000")));
      out.push(outcomeOf(await verify(next.challenge_id, wrongCode(t.mailer.last(email)))));
      return { out, next, sent: t.mailer.sent.slice(sentBefore) };
    };
    const registered = await transcript(member.email);
    const unregistered = await transcript(unknown);
    expect(unregistered.out).toEqual(registered.out);
    expect(registered.out.map((x) => x.status)).toEqual([429, 200, 410, 429, 410, 400]);
    expect(registered.out[0]).toMatchObject({ code: "RATE_LIMITED", retry_after_seconds: 60 });
    expect(registered.out[1]).toMatchObject({ purpose: "deletion", attempts_left: 5, resend_in: 60_000 });
    // Kode baru hanya dikirim ke akun nyata; decoy baru tetap dikenali sebagai decoy.
    expect(registered.sent).toEqual([expect.objectContaining({ to: member.email, purpose: "deletion" })]);
    expect(unregistered.sent).toEqual([]);
    expect(decoys.isDecoy(unregistered.next.challenge_id)).toBe(true);
    expect(decoys.isDecoy(registered.next.challenge_id)).toBe(false);
  });

  it("PRD 2.5: interceptor hanya menggantikan jawaban 410 modul auth untuk id decoy pada rute resend/status; galat lain dan id lain diteruskan apa adanya", async () => {
    t.clock.advance(60 * MINUTE);
    const decoy = await startChallenge(`tidak-ada-${uuidv7()}@kapdh.test`);
    const subject = new DeletionDecoyOtpInterceptor(t.app.get(WebDeletionDecoys));
    const context = (url: string, body: unknown) =>
      ({
        getType: () => "http",
        switchToHttp: () => ({ getRequest: () => ({ method: "POST", routeOptions: { url }, body }) }),
      }) as unknown as ExecutionContext;
    const failing = (error: unknown) => ({ handle: () => throwError(() => error) });
    const run = (url: string, body: unknown, error: unknown) =>
      lastValueFrom(subject.intercept(context(url, body), failing(error)));

    // POST /auth/otp/status (getOtpChallengeStatus) untuk decoy: keadaan decoy, tanpa mengganti kode.
    expect(await run("/api/v1/auth/otp/status", { challenge_id: decoy.challenge_id }, otpExpired())).toEqual(
      decoy,
    );
    expect(DECOY_OTP_ROUTES).toEqual({
      "POST /api/v1/auth/otp/resend": "resend",
      "POST /api/v1/auth/otp/status": "status",
    });
    // Galat selain 410 (mis. batas laju modul auth) tidak disentuh.
    const limited = new AppException(429, "RATE_LIMITED", "Terlalu banyak permintaan.");
    await expect(run("/api/v1/auth/otp/status", { challenge_id: decoy.challenge_id }, limited)).rejects.toBe(
      limited,
    );
    // Id bukan decoy dan rute lain: jawaban modul auth diteruskan.
    const original = otpExpired();
    await expect(run("/api/v1/auth/otp/resend", { challenge_id: uuidv7() }, original)).rejects.toBe(original);
    await expect(run("/api/v1/auth/otp/verify", { challenge_id: decoy.challenge_id }, original)).rejects.toBe(
      original,
    );
    await expect(run("/api/v1/auth/otp/resend", "bukan-objek", original)).rejects.toBe(original);
  });
});
