import { adminPermissions, admins, auditLogs, mfaTotp, outboxEvents, sessions, users } from "@kapdh/database";
import { and, desc, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { adminInviteTokenHash } from "../../src/core/identity/crypto.js";
import { RealtimeService } from "../../src/core/realtime/realtime.service.js";
import { expectOperation } from "../support/contract.js";
import {
  createAdmin,
  createAlumni,
  signInAdmin,
  signInAlumni,
  uniqueEmail,
} from "../support/factories.js";
import { httpClient, type HttpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { type AdminActor, adminActor, superAdminActor } from "./helpers.js";

let t: TestApp;
let api: HttpClient;
let root: AdminActor;

beforeAll(async () => {
  t = await createTestApp();
  api = httpClient(t.app);
  root = await superAdminActor(t, { displayName: "Super Admin Uji" });
});
afterAll(async () => {
  await t.app.close();
});

const ADMIN_PATH = "/admin/admins/{adminId}";

async function detail(adminId: string) {
  const res = await api.get(`/admin/admins/${adminId}`, { token: root.token });
  expect(res.statusCode, res.body).toBe(200);
  return expectOperation("get", ADMIN_PATH, res) as Record<string, any>;
}

/** Header sensitif Super Admin pemanggil + Idempotency-Key opsional. */
async function sensitive(ifMatch?: string | number, idempotencyKey?: string) {
  const options = await root.sensitive(ifMatch);
  if (idempotencyKey) options.headers["idempotency-key"] = idempotencyKey;
  return options;
}

async function invite(body: Record<string, unknown>, idempotencyKey = uuidv7()) {
  return api.post("/admin/admins", body, await sensitive(undefined, idempotencyKey));
}

async function lastAudit(action: string, entityId: string) {
  const [row] = await t.db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(1);
  return row;
}

/** Menjalankan worker outbox lalu mengambil tautan undangan terakhir ke alamat itu (email undangan F-16). */
async function invitationLink(email: string): Promise<{ token: string; subject: string; text: string }> {
  await t.jobs.drainOutbox();
  const message = [...t.mailer.messages].reverse().find((m) => m.to === email && m.text.includes("/invite/"));
  expect(message, `email undangan ke ${email}`).toBeDefined();
  const match = /http:\/\/admin\.test\/invite\/(\S+)/.exec(message!.text);
  expect(match, message!.text).not.toBeNull();
  return { token: match![1]!, subject: message!.subject, text: message!.text };
}

async function adminRow(adminId: string) {
  const [row] = await t.db.select().from(admins).where(eq(admins.id, adminId));
  return row!;
}

describe("GET /admin/permissions (F-16, ARCHITECTURE §4.5)", () => {
  it("F-16: katalog 15 izin dan 2 peran untuk semua admin ber-MFA; admins.manage tidak dapat ditugaskan", async () => {
    const plain = await adminActor(t, { permissions: [] });
    const res = await api.get("/admin/permissions", { token: plain.token });
    const body = expectOperation("get", "/admin/permissions", res) as {
      permissions: { permission: string; assignable: boolean; requires: string[]; label: string }[];
      roles: { role: string; label: string }[];
    };
    expect(res.statusCode).toBe(200);
    expect(body.permissions).toHaveLength(15);
    expect(body.permissions.find((p) => p.permission === "admins.manage")).toMatchObject({ assignable: false });
    expect(body.permissions.find((p) => p.permission === "payments.decide")).toMatchObject({
      requires: ["payments.read"],
      label: "Putuskan pembayaran",
    });
    expect(body.permissions.find((p) => p.permission === "audit.export")?.requires).toEqual(["audit.read"]);
    expect(body.roles.map((r) => r.label)).toEqual(["Super Admin", "Admin"]);
  });

  it("token aplikasi alumni ditolak 403; tanpa token 401", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const session = await signInAlumni(t, member);
    const res = await api.get("/admin/permissions", { token: session.accessToken });
    expect(res.statusCode).toBe(403);
    expect(expectOperation("get", "/admin/permissions", res)).toMatchObject({ code: "FORBIDDEN" });
    expect((await api.get("/admin/permissions")).statusCode).toBe(401);
  });
});

describe("POST /admin/admins: undangan dari alumni (AC F16-1, PRD 3.16)", () => {
  it("AC F16-1: identitas login admin TERPISAH ditautkan ke alumni, diaudit, email undangan berisi tautan sekali pakai lewat outbox", async () => {
    const member = await createAlumni(t, { status: "verified", fullName: "Siti Aminah" });
    const memberSession = await signInAlumni(t, member);
    const res = await invite({
      alumni_user_id: member.userId,
      role: "admin",
      permissions: ["payments.decide", "payments.read"],
    });
    const body = expectOperation("post", "/admin/admins", res) as Record<string, any>;
    expect(res.statusCode, res.body).toBe(201);
    expect(body.admin).toMatchObject({
      display_name: "Siti Aminah",
      email: member.email,
      role: "admin",
      status: "invited",
      permissions: ["payments.read", "payments.decide"],
      linked_alumni: {
        user_id: member.userId,
        full_name: "Siti Aminah",
        member_number: member.memberNumber,
        avatar_url: null,
      },
      mfa_enrolled: false,
      activated_at: null,
      invited_by: { admin_id: root.admin.adminId, display_name: "Super Admin Uji" },
      active_session_count: 0,
      version: "1",
    });
    expect(body.invitation_expires_at).toBe(new Date(t.clock.now().getTime() + 72 * 3600_000).toISOString());
    expect(body.admin.invite_expires_at).toBe(body.invitation_expires_at);
    expect(JSON.stringify(body)).not.toMatch(/token/i);

    // Akun login admin baru (kind admin), akun alumni tetap alumni dan tidak memperoleh hak admin.
    const row = await adminRow(body.admin.id);
    expect(row.linkedAlumniUserId).toBe(member.userId);
    expect(row.userId).not.toBe(member.userId);
    const [login] = await t.db.select().from(users).where(eq(users.id, row.userId));
    expect(login).toMatchObject({ kind: "admin", email: member.email, status: "active" });
    const [alumniAccount] = await t.db.select().from(users).where(eq(users.id, member.userId));
    expect(alumniAccount!.kind).toBe("alumni");
    const asAlumni = await api.get("/admin/dashboard", { token: memberSession.accessToken });
    expect(asAlumni.statusCode).toBe(403);

    // Audit transaksi yang sama (AC F16-1, F17-1) tanpa token/hash.
    const audit = await lastAudit("admin.invited", body.admin.id);
    expect(audit).toMatchObject({ actorAdminId: root.admin.adminId, effectiveRole: "super_admin" });
    expect(audit!.after).toMatchObject({
      role: "admin",
      permissions: ["payments.read", "payments.decide"],
      linked_alumni_user_id: member.userId,
      status: "invited",
    });
    expect(JSON.stringify(audit)).not.toMatch(/token_hash|invite_token/);

    // Outbox tidak memuat token; worker menerbitkan token dan hanya hash-nya yang tersimpan.
    const events = await t.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.dedupKey, `admin.invitation.requested:${body.admin.id}:${Date.parse(body.invitation_expires_at)}`));
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!.payload as object).sort()).toEqual(["admin_id", "invite_expires_at"]);
    const link = await invitationLink(member.email);
    expect(link.subject).toBe("Undangan pengurus KAPDH Apps");
    expect(link.text).toContain("Yth. Siti Aminah");
    expect((await adminRow(body.admin.id)).inviteTokenHash).toBe(adminInviteTokenHash(link.token));
  });

  it("PRD 4.3: Idempotency-Key yang sama memutar ulang hasil tanpa membuat admin kedua", async () => {
    const key = uuidv7();
    const email = uniqueEmail("admin-idem");
    const payload = { email, display_name: "Admin Idempoten", role: "admin", permissions: ["audit.read"] };
    const first = await invite(payload, key);
    expect(first.statusCode).toBe(201);
    const replay = await invite(payload, key);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json().admin.id).toBe(first.json().admin.id);
    const rows = await t.db.select().from(users).where(and(eq(users.email, email), eq(users.kind, "admin")));
    expect(rows).toHaveLength(1);
    const conflict = await invite({ ...payload, display_name: "Lain" }, key);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("AC F16-1: undangan email tanpa alumni; email dinormalisasi; Super Admin tanpa izin tersimpan", async () => {
    const email = uniqueEmail("pengurus");
    const res = await invite({
      email: `  ${email.toUpperCase()} `.trim(),
      display_name: "Ketua Pengurus",
      role: "super_admin",
      permissions: [],
    });
    const body = expectOperation("post", "/admin/admins", res) as Record<string, any>;
    expect(res.statusCode).toBe(201);
    expect(body.admin).toMatchObject({ email, role: "super_admin", linked_alumni: null });
    expect(body.admin.permissions).toHaveLength(15);
    expect(await t.db.select().from(adminPermissions).where(eq(adminPermissions.adminId, body.admin.id))).toEqual([]);
  });

  it.each([
    [{ role: "admin", permissions: ["admins.manage"] }, "permissions"],
    [{ role: "admin", permissions: ["payments.decide"] }, "permissions"],
    [{ role: "admin", permissions: ["audit.export"] }, "permissions"],
    [{ role: "admin", permissions: ["audit.read", "audit.read"] }, "permissions"],
    [{ role: "super_admin", permissions: ["audit.read"] }, "permissions"],
    [{ role: "pemilik", permissions: [] }, "role"],
  ])("AC F16-1: penugasan izin tidak sah %j ditolak 400 pada %s", async (input, field) => {
    const res = await invite({ email: uniqueEmail("x"), display_name: "X", ...input });
    expect(res.statusCode).toBe(400);
    expect(expectOperation("post", "/admin/admins", res)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { [field]: expect.any(Array) },
    });
  });

  it("tanpa alumni_user_id, email dan display_name wajib (400 per field)", async () => {
    const res = await invite({ role: "admin", permissions: [] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      field_errors: { email: expect.any(Array), display_name: expect.any(Array) },
    });
  });

  it.each([
    ["suspended", {}],
    ["pending_otp", {}],
    ["verified", { accountStatus: "deletion_pending" }],
    ["verified", { accountStatus: "disabled" }],
  ] as const)("alumni %s %j tidak memenuhi syarat: 400 pada alumni_user_id", async (status, extra) => {
    const member = await createAlumni(t, { status, ...extra });
    const res = await invite({ alumni_user_id: member.userId, role: "admin", permissions: [] });
    expect(res.statusCode).toBe(400);
    expect(expectOperation("post", "/admin/admins", res)).toMatchObject({
      field_errors: { alumni_user_id: expect.any(Array) },
    });
  });

  it("alumni tidak dikenal atau id akun admin: 400 pada alumni_user_id", async () => {
    for (const id of [uuidv7(), root.admin.userId]) {
      const res = await invite({ alumni_user_id: id, role: "admin", permissions: [] });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ field_errors: { alumni_user_id: expect.any(Array) } });
    }
  });

  it("alumni yang sudah tertaut dan email login yang sudah dipakai: 409 VALIDATION_ERROR pada field-nya", async () => {
    const member = await createAlumni(t, { status: "verified" });
    expect((await invite({ alumni_user_id: member.userId, role: "admin", permissions: [] })).statusCode).toBe(201);
    const linked = await invite({ alumni_user_id: member.userId, role: "admin", permissions: [] });
    expect(linked.statusCode).toBe(409);
    expect(expectOperation("post", "/admin/admins", linked)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { alumni_user_id: expect.any(Array) },
    });
    const taken = await invite({
      email: root.admin.email.toUpperCase(),
      display_name: "Duplikat",
      role: "admin",
      permissions: [],
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: "VALIDATION_ERROR", field_errors: { email: expect.any(Array) } });
  });

  it("AC F16-1: tanpa X-Reauth-Token 403 REAUTH_REQUIRED; admin tanpa admins.manage 403 FORBIDDEN", async () => {
    const noReauth = await api.post(
      "/admin/admins",
      { email: uniqueEmail("x"), display_name: "X", role: "admin", permissions: [] },
      { token: root.token },
    );
    expect(noReauth.statusCode).toBe(403);
    expect(expectOperation("post", "/admin/admins", noReauth)).toMatchObject({ code: "REAUTH_REQUIRED" });

    // Admin dengan seluruh izin yang dapat ditugaskan tetap bukan Super Admin (PRD 2.3).
    const strong = await adminActor(t, {
      permissions: [
        "payments.read",
        "payments.decide",
        "members.read",
        "members.manage",
        "settings.manage",
        "audit.read",
        "audit.export",
      ],
    });
    const forbidden = await api.post(
      "/admin/admins",
      { email: uniqueEmail("x"), display_name: "X", role: "admin", permissions: [] },
      await strong.sensitive(),
    );
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: "FORBIDDEN" });
    for (const path of ["/admin/admins", "/admin/admins/candidates", `/admin/admins/${root.admin.adminId}`]) {
      const res = await api.get(path, { token: strong.token });
      expect(res.statusCode, path).toBe(403);
    }
  });
});

describe("GET /admin/admins/candidates (F-16, guideline hlm. 15)", () => {
  it("F-16: cari nama/nomor anggota/email; kelayakan dinyatakan; akun dihapus/deletion_pending tidak muncul", async () => {
    const tag = uuidv7().slice(-6);
    const eligible = await createAlumni(t, { status: "verified", fullName: `Kandidat ${tag} Layak` });
    const suspended = await createAlumni(t, { status: "suspended", fullName: `Kandidat ${tag} Dibatasi` });
    const pending = await createAlumni(t, { status: "pending_otp", fullName: `Kandidat ${tag} Belum OTP` });
    const disabled = await createAlumni(t, {
      status: "verified",
      accountStatus: "disabled",
      fullName: `Kandidat ${tag} Nonaktif`,
    });
    await createAlumni(t, { status: "verified", accountStatus: "deletion_pending", fullName: `Kandidat ${tag} Hapus` });
    await createAlumni(t, { status: "verified", accountStatus: "deleted", fullName: `Kandidat ${tag} Terhapus` });
    const linked = await createAlumni(t, { status: "verified", fullName: `Kandidat ${tag} Admin` });
    await createAdmin(t, { linkedAlumniUserId: linked.userId });

    const res = await api.get("/admin/admins/candidates", { token: root.token, query: { q: `kandidat ${tag}` } });
    const body = expectOperation("get", "/admin/admins/candidates", res) as {
      items: Record<string, any>[];
      total: number;
    };
    expect(res.statusCode).toBe(200);
    expect(body.total).toBe(5);
    const byId = new Map(body.items.map((item) => [item.user_id, item]));
    expect(byId.get(eligible.userId)).toMatchObject({
      eligible: true,
      ineligible_reason: null,
      effective_status: "verified",
      email: eligible.email,
      member_number: eligible.memberNumber,
    });
    expect(byId.get(suspended.userId)).toMatchObject({ eligible: false, ineligible_reason: "suspended" });
    expect(byId.get(pending.userId)).toMatchObject({
      eligible: false,
      ineligible_reason: "account_inactive",
      effective_status: "pending_otp",
    });
    expect(byId.get(disabled.userId)).toMatchObject({ eligible: false, ineligible_reason: "account_inactive" });
    expect(byId.get(linked.userId)).toMatchObject({ eligible: false, ineligible_reason: "already_admin" });

    const byNumber = await api.get("/admin/admins/candidates", {
      token: root.token,
      query: { q: eligible.memberNumber! },
    });
    expect(byNumber.json().items.map((i: { user_id: string }) => i.user_id)).toContain(eligible.userId);
    const byEmail = await api.get("/admin/admins/candidates", {
      token: root.token,
      query: { q: eligible.email.toUpperCase() },
    });
    expect(byEmail.json().items.map((i: { user_id: string }) => i.user_id)).toEqual([eligible.userId]);
  });

  it("paging keyset terbaru dahulu tanpa duplikasi", async () => {
    const tag = uuidv7().slice(-6);
    for (let i = 0; i < 5; i++) {
      await createAlumni(t, { status: "verified", fullName: `Halaman ${tag} ${i}` });
      t.clock.advance(1000);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: Record<string, string> = { q: `halaman ${tag}`, limit: "2" };
      if (cursor) query.cursor = cursor;
      const res = await api.get("/admin/admins/candidates", { token: root.token, query });
      const body = expectOperation("get", "/admin/admins/candidates", res) as {
        items: { full_name: string }[];
        next_cursor: string | null;
        total: number;
      };
      expect(body.total).toBe(5);
      seen.push(...body.items.map((i) => i.full_name));
      cursor = body.next_cursor;
    } while (cursor);
    expect(seen).toEqual([4, 3, 2, 1, 0].map((i) => `Halaman ${tag} ${i}`));
  });
});

describe("GET /admin/admins dan /admin/admins/{adminId} (F-16)", () => {
  it("F-16: filter q/peran/status/izin, total mengikuti filter, counts seluruh admin", async () => {
    const tag = uuidv7().slice(-6);
    const auditor = await createAdmin(t, { displayName: `Auditor ${tag}`, permissions: ["audit.read"] });
    const disabled = await createAdmin(t, { displayName: `Nonaktif ${tag}`, status: "disabled" });
    await createAdmin(t, { displayName: `Diundang ${tag}`, status: "invited" });

    const all = await api.get("/admin/admins", { token: root.token, query: { q: tag } });
    const body = expectOperation("get", "/admin/admins", all) as Record<string, any>;
    expect(body.total).toBe(3);
    expect(body.items.map((i: { display_name: string }) => i.display_name)).toEqual([
      `Auditor ${tag}`,
      `Diundang ${tag}`,
      `Nonaktif ${tag}`,
    ]);
    expect(body.counts.total).toBe(body.counts.active + body.counts.invited + body.counts.disabled);

    const byPermission = await api.get("/admin/admins", {
      token: root.token,
      query: { q: tag, permission: "audit.read" },
    });
    expect(byPermission.json().items.map((i: { id: string }) => i.id)).toEqual([auditor.adminId]);
    const byStatus = await api.get("/admin/admins", { token: root.token, query: { q: tag, status: "disabled" } });
    expect(byStatus.json().items.map((i: { id: string }) => i.id)).toEqual([disabled.adminId]);
    // super_admin selalu cocok dengan filter izin (izin efektif).
    const supers = await api.get("/admin/admins", {
      token: root.token,
      query: { role: "super_admin", permission: "audit.export" },
    });
    expect(supers.json().items.map((i: { id: string }) => i.id)).toContain(root.admin.adminId);
    const byEmail = await api.get("/admin/admins", { token: root.token, query: { q: auditor.email.toUpperCase() } });
    expect(byEmail.json().total).toBe(1);
  });

  it("urutan created_at_desc dan last_login_at_desc dengan cursor tanpa duplikasi", async () => {
    const tag = uuidv7().slice(-6);
    for (let i = 0; i < 4; i++) {
      await createAdmin(t, { displayName: `Urut ${tag} ${i}` });
      t.clock.advance(1000);
    }
    for (const sort of ["created_at_desc", "last_login_at_desc", "display_name_asc"]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: Record<string, string> = { q: `Urut ${tag}`, sort, limit: "3" };
        if (cursor) query.cursor = cursor;
        const res = await api.get("/admin/admins", { token: root.token, query });
        const body = expectOperation("get", "/admin/admins", res) as Record<string, any>;
        seen.push(...body.items.map((i: { display_name: string }) => i.display_name));
        cursor = body.next_cursor;
      } while (cursor);
      expect(new Set(seen).size, sort).toBe(4);
      if (sort === "created_at_desc") expect(seen).toEqual([3, 2, 1, 0].map((i) => `Urut ${tag} ${i}`));
      if (sort === "display_name_asc") expect(seen).toEqual([0, 1, 2, 3].map((i) => `Urut ${tag} ${i}`));
    }
    const mismatch = await api.get("/admin/admins", {
      token: root.token,
      query: { sort: "created_at_desc", limit: "1" },
    });
    const cursor = mismatch.json().next_cursor as string;
    const wrong = await api.get("/admin/admins", { token: root.token, query: { sort: "display_name_asc", cursor } });
    expect(wrong.statusCode).toBe(400);
  });

  it("detail: id bukan UUID 400, tidak ada 404; admin aktif membawa jumlah sesi aktif", async () => {
    const bad = await api.get("/admin/admins/bukan-uuid", { token: root.token });
    expect(bad.statusCode).toBe(400);
    expect(expectOperation("get", ADMIN_PATH, bad)).toMatchObject({ code: "VALIDATION_ERROR" });
    const missing = await api.get(`/admin/admins/${uuidv7()}`, { token: root.token });
    expect(missing.statusCode).toBe(404);
    expect(expectOperation("get", ADMIN_PATH, missing)).toMatchObject({ code: "NOT_FOUND" });
    const me = await detail(root.admin.adminId);
    expect(me).toMatchObject({ status: "active", mfa_enrolled: true, role: "super_admin", invited_by: null });
    expect(me.active_session_count).toBeGreaterThanOrEqual(1);
    expect(me.last_login_at).not.toBeNull();
  });
});

describe("PATCH /admin/admins/{adminId} (AC F16-1, F16-3, F15-4)", () => {
  it("AC F16-3: izin yang dicabut langsung tidak berlaku pada request berikutnya walaupun token belum kedaluwarsa", async () => {
    const auditor = await adminActor(t, { permissions: ["audit.read", "payments.read"], displayName: "Auditor" });
    expect((await api.get("/admin/audit/entries", { token: auditor.token })).statusCode).toBe(200);
    const before = await detail(auditor.admin.adminId);
    const disconnect = vi.spyOn(t.app.get(RealtimeService), "disconnectUser");
    const res = await api.patch(
      `/admin/admins/${auditor.admin.adminId}`,
      { permissions: ["payments.read"], reason: "Rotasi tugas" },
      await sensitive(before.version),
    );
    const body = expectOperation("patch", ADMIN_PATH, res) as Record<string, any>;
    expect(res.statusCode, res.body).toBe(200);
    expect(body).toMatchObject({
      permissions: ["payments.read"],
      permissions_version: before.permissions_version + 1,
      version: String(Number(before.version) + 1),
    });
    expect(disconnect).toHaveBeenCalledWith(auditor.admin.userId, "permissions_changed");
    disconnect.mockRestore();

    // Token yang sama: audit.read sudah tidak berlaku, payments.read tetap (dasbor hanya bagian pembayaran).
    const denied = await api.get("/admin/audit/entries", { token: auditor.token });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "FORBIDDEN" });
    const dashboard = await api.get("/admin/dashboard", { token: auditor.token });
    expect(Object.keys(dashboard.json()).sort()).toEqual(["generated_at", "payments"]);

    const audit = await lastAudit("admin.updated", auditor.admin.adminId);
    expect(audit).toMatchObject({ reason: "Rotasi tugas", actorAdminId: root.admin.adminId });
    expect(audit!.before).toMatchObject({ permissions: ["payments.read", "audit.read"] });
    expect(audit!.after).toMatchObject({ permissions: ["payments.read"] });

    // Pemberitahuan keamanan ke email admin (pola AC F16-4).
    await t.jobs.drainOutbox();
    expect(t.mailer.lastMessage(auditor.admin.email)?.subject).toBe("Izin akun pengurus Anda diubah");
  });

  it("AC F16-1: menaikkan peran ke super_admin mengosongkan izin tersimpan; menurunkan ke admin wajib menyertakan izin", async () => {
    const target = await createAdmin(t, { permissions: ["members.read"] });
    let current = await detail(target.adminId);
    const promoted = await api.patch(
      `/admin/admins/${target.adminId}`,
      { role: "super_admin" },
      await sensitive(current.version),
    );
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect(promoted.json().permissions).toHaveLength(15);
    expect(await t.db.select().from(adminPermissions).where(eq(adminPermissions.adminId, target.adminId))).toEqual(
      [],
    );
    current = promoted.json();
    const missing = await api.patch(
      `/admin/admins/${target.adminId}`,
      { role: "admin" },
      await sensitive(current.version),
    );
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ field_errors: { permissions: expect.any(Array) } });
    const demoted = await api.patch(
      `/admin/admins/${target.adminId}`,
      { role: "admin", permissions: [] },
      await sensitive(current.version),
    );
    expect(expectOperation("patch", ADMIN_PATH, demoted)).toMatchObject({ role: "admin", permissions: [] });
  });

  it("AC F15-4: If-Match usang 409 VERSION_CONFLICT dengan current AdminAccountDetail; tanpa If-Match 400; body kosong 400", async () => {
    const target = await createAdmin(t, { displayName: "Versi Lama" });
    const current = await detail(target.adminId);
    const first = await api.patch(
      `/admin/admins/${target.adminId}`,
      { display_name: "Versi Baru" },
      await sensitive(current.version),
    );
    expect(first.statusCode).toBe(200);
    const stale = await api.patch(
      `/admin/admins/${target.adminId}`,
      { display_name: "Menimpa" },
      await sensitive(current.version),
    );
    const body = expectOperation("patch", ADMIN_PATH, stale) as Record<string, any>;
    expect(stale.statusCode).toBe(409);
    expect(body).toMatchObject({ code: "VERSION_CONFLICT", current: { display_name: "Versi Baru" } });
    const noIfMatch = await api.patch(`/admin/admins/${target.adminId}`, { display_name: "X" }, await sensitive());
    expect(noIfMatch.statusCode).toBe(400);
    const empty = await api.patch(`/admin/admins/${target.adminId}`, {}, await sensitive(Number(current.version) + 1));
    expect(empty.statusCode).toBe(400);
    const unknown = await api.patch(`/admin/admins/${uuidv7()}`, { display_name: "X" }, await sensitive(1));
    expect(unknown.statusCode).toBe(404);
  });

  it("AC F16-1, F16-3: menonaktifkan wajib alasan; seluruh sesi dicabut dan token lama langsung ditolak", async () => {
    const target = await adminActor(t, { permissions: ["members.read"] });
    const current = await detail(target.admin.adminId);
    const noReason = await api.patch(
      `/admin/admins/${target.admin.adminId}`,
      { status: "disabled" },
      await sensitive(current.version),
    );
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json()).toMatchObject({ field_errors: { reason: expect.any(Array) } });

    const res = await api.patch(
      `/admin/admins/${target.admin.adminId}`,
      { status: "disabled", reason: "Masa jabatan berakhir" },
      await sensitive(current.version),
    );
    const body = expectOperation("patch", ADMIN_PATH, res) as Record<string, any>;
    expect(res.statusCode, res.body).toBe(200);
    expect(body).toMatchObject({ status: "disabled", active_session_count: 0, disabled_at: t.clock.now().toISOString() });
    expect(body.permissions_version).toBe(current.permissions_version + 1);
    const after = await api.get("/admin/permissions", { token: target.token });
    expect(after.statusCode).toBe(401);
    const live = await t.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, target.admin.userId), isNull(sessions.revokedAt)));
    expect(live).toEqual([]);
    await t.jobs.drainOutbox();
    expect(t.mailer.lastMessage(target.admin.email)?.subject).toBe("Akun pengurus Anda dinonaktifkan");

    // Aktif kembali: pernah aktif + TOTP masih terverifikasi; kredensial lama berlaku lagi.
    const reactivated = await api.patch(
      `/admin/admins/${target.admin.adminId}`,
      { status: "active", reason: "Dilantik kembali" },
      await sensitive(body.version),
    );
    expect(expectOperation("patch", ADMIN_PATH, reactivated)).toMatchObject({ status: "active", disabled_at: null });
    const session = await signInAdmin(t, target.admin);
    expect((await api.get("/admin/permissions", { token: session.accessToken })).statusCode).toBe(200);
  });

  it("status active hanya untuk disabled yang pernah aktif dan masih ber-TOTP; selain itu 409 pada status", async () => {
    const invited = await createAdmin(t, { status: "invited" });
    const invitedDetail = await detail(invited.adminId);
    const fromInvited = await api.patch(
      `/admin/admins/${invited.adminId}`,
      { status: "active" },
      await sensitive(invitedDetail.version),
    );
    expect(fromInvited.statusCode).toBe(409);
    expect(expectOperation("patch", ADMIN_PATH, fromInvited)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { status: expect.any(Array) },
    });

    const noTotp = await createAdmin(t, { status: "disabled" });
    await t.db.delete(mfaTotp).where(eq(mfaTotp.userId, noTotp.userId));
    const noTotpDetail = await detail(noTotp.adminId);
    expect(noTotpDetail.mfa_enrolled).toBe(false);
    const res = await api.patch(
      `/admin/admins/${noTotp.adminId}`,
      { status: "active" },
      await sensitive(noTotpDetail.version),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ field_errors: { status: expect.any(Array) } });
  });

  it("koreksi email admin invited: token lama batal, undangan baru ke alamat baru; admin aktif 409; email+status 400", async () => {
    const created = await invite({
      email: uniqueEmail("salah-ketik"),
      display_name: "Calon Admin",
      role: "admin",
      permissions: [],
    });
    const adminId = created.json().admin.id as string;
    const oldHash = (await adminRow(adminId)).inviteTokenHash;
    const newEmail = uniqueEmail("benar");
    const res = await api.patch(
      `/admin/admins/${adminId}`,
      { email: newEmail.toUpperCase() },
      await sensitive(created.json().admin.version),
    );
    const body = expectOperation("patch", ADMIN_PATH, res) as Record<string, any>;
    expect(res.statusCode, res.body).toBe(200);
    expect(body.email).toBe(newEmail);
    expect(Date.parse(body.invite_expires_at)).toBeGreaterThan(Date.parse(created.json().invitation_expires_at));
    const row = await adminRow(adminId);
    expect(row.inviteTokenHash).not.toBe(oldHash);
    const link = await invitationLink(newEmail);
    expect((await adminRow(adminId)).inviteTokenHash).toBe(adminInviteTokenHash(link.token));
    const audit = await lastAudit("admin.updated", adminId);
    expect(audit!.before).toMatchObject({ email: created.json().admin.email });
    expect(audit!.after).toMatchObject({ email: newEmail });

    const both = await api.patch(
      `/admin/admins/${adminId}`,
      { email: uniqueEmail("x"), status: "disabled", reason: "uji" },
      await sensitive(body.version),
    );
    expect(both.statusCode).toBe(400);

    const active = await createAdmin(t);
    const activeDetail = await detail(active.adminId);
    const refused = await api.patch(
      `/admin/admins/${active.adminId}`,
      { email: uniqueEmail("baru") },
      await sensitive(activeDetail.version),
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "VALIDATION_ERROR", field_errors: { email: expect.any(Array) } });

    const taken = await api.patch(
      `/admin/admins/${adminId}`,
      { email: active.email },
      await sensitive(body.version),
    );
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ field_errors: { email: expect.any(Array) } });
  });

  it("nilai yang sama dengan keadaan sekarang tidak menaikkan versi dan tidak diaudit", async () => {
    const target = await createAdmin(t, { displayName: "Tetap", permissions: ["members.read"] });
    const current = await detail(target.adminId);
    const res = await api.patch(
      `/admin/admins/${target.adminId}`,
      { display_name: "Tetap", permissions: ["members.read"] },
      await sensitive(current.version),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(current.version);
    expect(await lastAudit("admin.updated", target.adminId)).toBeUndefined();
  });
});

describe("DELETE /admin/admins/{adminId} (F-16)", () => {
  it("F-16: identitas yang belum pernah aktif dihapus; email login dan alumni tertaut bebas dipakai lagi; diaudit", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const created = await invite({ alumni_user_id: member.userId, role: "admin", permissions: ["members.read"] });
    expect(created.statusCode).toBe(201);
    const { id: adminId, version } = created.json().admin as { id: string; version: string };
    const userId = (await adminRow(adminId)).userId;
    const res = await api.delete(`/admin/admins/${adminId}`, await sensitive(version));
    expect(res.statusCode, res.body).toBe(204);
    expectOperation("delete", ADMIN_PATH, res);
    expect(await t.db.select().from(admins).where(eq(admins.id, adminId))).toEqual([]);
    expect(await t.db.select().from(users).where(eq(users.id, userId))).toEqual([]);
    const audit = await lastAudit("admin.deleted", adminId);
    expect(audit!.before).toMatchObject({
      linked_alumni_user_id: member.userId,
      status: "invited",
      permissions: ["members.read"],
    });
    expect((await api.get(`/admin/admins/${adminId}`, { token: root.token })).statusCode).toBe(404);
    // Alumni yang sama dapat diundang lagi.
    const again = await invite({ alumni_user_id: member.userId, role: "admin", permissions: [] });
    expect(again.statusCode).toBe(201);
  });

  it("identitas yang pernah aktif ditolak 409; If-Match usang 409 VERSION_CONFLICT; tidak ada 404", async () => {
    const active = await createAdmin(t, { status: "disabled" });
    const activeDetail = await detail(active.adminId);
    const refused = await api.delete(`/admin/admins/${active.adminId}`, await sensitive(activeDetail.version));
    expect(refused.statusCode).toBe(409);
    expect(expectOperation("delete", ADMIN_PATH, refused)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { _: expect.any(Array) },
    });
    const invited = await createAdmin(t, { status: "invited" });
    const stale = await api.delete(`/admin/admins/${invited.adminId}`, await sensitive(99));
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT" });
    const missing = await api.delete(`/admin/admins/${uuidv7()}`, await sensitive(1));
    expect(missing.statusCode).toBe(404);
    const noIfMatch = await api.delete(`/admin/admins/${invited.adminId}`, await sensitive());
    expect(noIfMatch.statusCode).toBe(400);
  });
});

describe("POST /admin/admins/{adminId}/invitation (F-16)", () => {
  it("F-16: kirim ulang menerbitkan token baru (token lama tidak berlaku), menaikkan versi, diaudit", async () => {
    const created = await invite({ email: uniqueEmail("ulang"), display_name: "Undangan Ulang", role: "admin", permissions: [] });
    const { id: adminId, email, version } = created.json().admin as { id: string; email: string; version: string };
    const firstLink = await invitationLink(email);
    t.clock.advance(60_000);
    const res = await api.post(
      `/admin/admins/${adminId}/invitation`,
      {},
      await sensitive(version, uuidv7()),
    );
    const body = expectOperation("post", "/admin/admins/{adminId}/invitation", res) as Record<string, any>;
    expect(res.statusCode, res.body).toBe(200);
    expect(body.admin).toMatchObject({ status: "invited", version: String(Number(version) + 1) });
    expect(Date.parse(body.invitation_expires_at)).toBe(t.clock.now().getTime() + 72 * 3600_000);
    const secondLink = await invitationLink(email);
    expect(secondLink.token).not.toBe(firstLink.token);
    const hash = (await adminRow(adminId)).inviteTokenHash;
    expect(hash).toBe(adminInviteTokenHash(secondLink.token));
    expect(hash).not.toBe(adminInviteTokenHash(firstLink.token));
    expect(await lastAudit("admin.invitation_resent", adminId)).toBeDefined();
  });

  it("disabled yang belum pernah aktif kembali invited; admin aktif ditolak 409; If-Match usang 409", async () => {
    const created = await invite({ email: uniqueEmail("batal"), display_name: "Batal", role: "admin", permissions: [] });
    const adminId = created.json().admin.id as string;
    const disabled = await api.patch(
      `/admin/admins/${adminId}`,
      { status: "disabled", reason: "Undangan ditunda" },
      await sensitive(created.json().admin.version),
    );
    expect(disabled.json()).toMatchObject({ status: "disabled", invite_expires_at: null });
    const resent = await api.post(`/admin/admins/${adminId}/invitation`, {}, await sensitive(disabled.json().version));
    expect(expectOperation("post", "/admin/admins/{adminId}/invitation", resent)).toMatchObject({
      admin: { status: "invited", disabled_at: null },
    });

    const active = await createAdmin(t);
    const activeDetail = await detail(active.adminId);
    const refused = await api.post(`/admin/admins/${active.adminId}/invitation`, {}, await sensitive(activeDetail.version));
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    const stale = await api.post(`/admin/admins/${adminId}/invitation`, {}, await sensitive(1));
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("worker tidak mengirim undangan usang (undangan sudah diganti atau dibatalkan)", async () => {
    const email = uniqueEmail("usang");
    const created = await invite({ email, display_name: "Usang", role: "admin", permissions: [] });
    const adminId = created.json().admin.id as string;
    await api.patch(
      `/admin/admins/${adminId}`,
      { status: "disabled", reason: "Dibatalkan sebelum terkirim" },
      await sensitive(created.json().admin.version),
    );
    const before = t.mailer.messages.length;
    await t.jobs.drainOutbox();
    expect(t.mailer.messages.slice(before).filter((m) => m.to === email)).toEqual([]);
    expect((await adminRow(adminId)).inviteTokenHash).toBeNull();
  });
});

describe("POST /admin/admins/{adminId}/recovery (F-16, PRD 3.16)", () => {
  it("F-16: sandi dan MFA direset, sesi dicabut, email dialihkan, undangan pemulihan + pemberitahuan ke alamat lama", async () => {
    const target = await adminActor(t, { permissions: ["payments.read"], displayName: "Admin Lupa" });
    const before = await detail(target.admin.adminId);
    const [oldLogin] = await t.db.select().from(users).where(eq(users.id, target.admin.userId));
    const disconnect = vi.spyOn(t.app.get(RealtimeService), "disconnectUser");
    const newEmail = uniqueEmail("pulih");
    const res = await api.post(
      `/admin/admins/${target.admin.adminId}/recovery`,
      { reason: "Perangkat TOTP hilang, diverifikasi lewat telepon", email: newEmail },
      await sensitive(before.version, uuidv7()),
    );
    const body = expectOperation("post", "/admin/admins/{adminId}/recovery", res) as Record<string, any>;
    expect(res.statusCode, res.body).toBe(200);
    expect(body.admin).toMatchObject({
      status: "invited",
      email: newEmail,
      mfa_enrolled: false,
      active_session_count: 0,
      permissions: ["payments.read"],
      permissions_version: before.permissions_version + 1,
    });
    expect(body.admin.activated_at).toBe(before.activated_at);
    expect(body.revoked_session_count).toBeGreaterThanOrEqual(1);
    expect(disconnect).toHaveBeenCalledWith(target.admin.userId, "password_reset");
    disconnect.mockRestore();

    // Token lama mati, TOTP dihapus, sandi lama tidak lagi berlaku, session_version naik.
    expect((await api.get("/admin/permissions", { token: target.token })).statusCode).toBe(401);
    expect(await t.db.select().from(mfaTotp).where(eq(mfaTotp.userId, target.admin.userId))).toEqual([]);
    const [login] = await t.db.select().from(users).where(eq(users.id, target.admin.userId));
    expect(login!.passwordHash).not.toBe(oldLogin!.passwordHash);
    expect(login!.sessionVersion).toBe(oldLogin!.sessionVersion + 1);
    const passwordLogin = await api.post("/admin/auth/login", { email: newEmail, password: target.admin.password });
    expect(passwordLogin.statusCode).toBe(401);

    const audit = await lastAudit("admin.recovery_initiated", target.admin.adminId);
    expect(audit).toMatchObject({ reason: "Perangkat TOTP hilang, diverifikasi lewat telepon" });
    expect(audit!.before).toMatchObject({ status: "active", email: target.admin.email });
    expect(audit!.after).toMatchObject({ status: "invited", email: newEmail });

    const link = await invitationLink(newEmail);
    expect(link.subject).toBe("Pemulihan akun pengurus KAPDH Apps");
    expect((await adminRow(target.admin.adminId)).inviteTokenHash).toBe(adminInviteTokenHash(link.token));
    const toNew = t.mailer.messages.filter((m) => m.to === newEmail).map((m) => m.subject);
    expect(toNew).toContain("Sandi dan autentikator akun pengurus Anda direset");
    const toOld = t.mailer.messages.filter((m) => m.to === target.admin.email);
    expect(toOld.map((m) => m.subject)).toContain("Email login akun pengurus Anda dialihkan");
    expect(toOld.every((m) => !m.text.includes("/invite/"))).toBe(true);
  });

  it("Super Admin memulihkan dirinya, admin invited/belum pernah aktif: 409 pada _; If-Match usang 409 VERSION_CONFLICT", async () => {
    const self = await api.post(
      `/admin/admins/${root.admin.adminId}/recovery`,
      { reason: "Uji pemulihan diri" },
      await sensitive((await detail(root.admin.adminId)).version),
    );
    expect(self.statusCode).toBe(409);
    expect(expectOperation("post", "/admin/admins/{adminId}/recovery", self)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { _: expect.any(Array) },
    });
    const invited = await createAdmin(t, { status: "invited" });
    const invitedRes = await api.post(
      `/admin/admins/${invited.adminId}/recovery`,
      { reason: "Uji pemulihan" },
      await sensitive((await detail(invited.adminId)).version),
    );
    expect(invitedRes.statusCode).toBe(409);
    expect(invitedRes.json()).toMatchObject({ field_errors: { _: expect.any(Array) } });
    const active = await createAdmin(t);
    const stale = await api.post(`/admin/admins/${active.adminId}/recovery`, { reason: "Uji pemulihan" }, await sensitive(7));
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT", current: { id: active.adminId } });
    const shortReason = await api.post(`/admin/admins/${active.adminId}/recovery`, { reason: "  " }, await sensitive(1));
    expect(shortReason.statusCode).toBe(400);
    expect(shortReason.json()).toMatchObject({ field_errors: { reason: expect.any(Array) } });
  });

  it("disabled yang pernah aktif dapat dipulihkan; email bentrok 409 pada email", async () => {
    const disabled = await createAdmin(t, { status: "disabled" });
    const taken = await api.post(
      `/admin/admins/${disabled.adminId}/recovery`,
      { reason: "Pemulihan admin nonaktif", email: root.admin.email },
      await sensitive((await detail(disabled.adminId)).version),
    );
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ field_errors: { email: expect.any(Array) } });
    const res = await api.post(
      `/admin/admins/${disabled.adminId}/recovery`,
      { reason: "Pemulihan admin nonaktif" },
      await sensitive((await detail(disabled.adminId)).version),
    );
    expect(expectOperation("post", "/admin/admins/{adminId}/recovery", res)).toMatchObject({
      admin: { status: "invited", disabled_at: null, email: disabled.email },
      revoked_session_count: 0,
    });
  });
});

describe("AC F16-2: Super Admin aktif terakhir (penjaga transaksi admins_last_super_admin_chk)", () => {
  let solo: TestApp;
  let soloApi: HttpClient;
  let only: AdminActor;

  beforeAll(async () => {
    solo = await createTestApp();
    soloApi = httpClient(solo.app);
    only = await superAdminActor(solo, { displayName: "Satu-satunya" });
  });
  afterAll(async () => {
    await solo.app.close();
  });

  async function soloDetail(adminId: string) {
    return (await soloApi.get(`/admin/admins/${adminId}`, { token: only.token })).json() as Record<string, any>;
  }

  it("AC F16-2: menurunkan atau menonaktifkan dirinya sebagai Super Admin terakhir ditolak 409 dengan current", async () => {
    const current = await soloDetail(only.admin.adminId);
    const demote = await soloApi.patch(
      `/admin/admins/${only.admin.adminId}`,
      { role: "admin", permissions: [] },
      await only.sensitive(current.version),
    );
    expect(demote.statusCode).toBe(409);
    expect(expectOperation("patch", ADMIN_PATH, demote)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { role: expect.any(Array) },
      current: { id: only.admin.adminId, role: "super_admin", version: current.version },
    });
    const disable = await soloApi.patch(
      `/admin/admins/${only.admin.adminId}`,
      { status: "disabled", reason: "Uji penjaga" },
      await only.sensitive(current.version),
    );
    expect(disable.statusCode).toBe(409);
    expect(disable.json()).toMatchObject({ field_errors: { status: expect.any(Array) } });
    // Tidak ada perubahan atau audit yang tersisa dari transaksi yang batal (AC F17-1).
    const [row] = await solo.db.select().from(admins).where(eq(admins.id, only.admin.adminId));
    expect(row).toMatchObject({ role: "super_admin", status: "active", version: Number(current.version) });
    const [audit] = await solo.db.select().from(auditLogs).where(eq(auditLogs.action, "admin.updated"));
    expect(audit).toBeUndefined();
  });

  it("AC F16-2: dengan Super Admin kedua, penurunan sah; penurunan berikutnya atas yang terakhir ditolak", async () => {
    const second = await createAdmin(solo, { role: "super_admin" });
    const secondDetail = await soloDetail(second.adminId);
    const demoted = await soloApi.patch(
      `/admin/admins/${second.adminId}`,
      { role: "admin", permissions: ["audit.read"] },
      await only.sensitive(secondDetail.version),
    );
    expect(demoted.statusCode, demoted.body).toBe(200);
    const selfDemote = await soloApi.patch(
      `/admin/admins/${only.admin.adminId}`,
      { role: "admin", permissions: [] },
      await only.sensitive((await soloDetail(only.admin.adminId)).version),
    );
    expect(selfDemote.statusCode).toBe(409);
  });
});
