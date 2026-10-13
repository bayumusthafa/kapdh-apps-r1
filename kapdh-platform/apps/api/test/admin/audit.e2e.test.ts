import { auditLogs, files, outboxEvents } from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeAudit } from "../../src/core/audit/write-audit.js";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { AuditExportJob } from "../../src/modules/admin/audit-export.job.js";
import { expectOperation } from "../support/contract.js";
import { createAlumni, signInAlumni } from "../support/factories.js";
import { httpClient, type HttpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { type AdminActor, adminActor, type JsonBody, signInActor, superAdminActor } from "./helpers.js";

let t: TestApp;
let api: HttpClient;
let root: AdminActor;
let auditor: AdminActor;
let exporter: AdminActor;

const ENTRIES = "/admin/audit/entries";
const EXPORTS = "/admin/audit/exports";
const EXPORT = "/admin/audit/exports/{exportId}";
const ACCESS = "/admin/audit/exports/{exportId}/access";

beforeAll(async () => {
  t = await createTestApp();
  api = httpClient(t.app);
  root = await superAdminActor(t, { displayName: "Super Admin Audit" });
  auditor = await adminActor(t, { permissions: ["audit.read"], displayName: "Pemeriksa Audit" });
  exporter = await adminActor(t, {
    permissions: ["audit.read", "audit.export"],
    displayName: "Pengekspor Audit",
  });
});
afterAll(async () => {
  await t.app.close();
});

interface Seeded {
  tag: string;
  ids: string[];
  /** Waktu entri ke-i (berurutan naik, selisih 1 menit). */
  times: Date[];
  memberId: string;
}

/**
 * Entri audit sintetis dengan tag unik pada entity_type: dua pelaku (admin `exporter` dan alumni), before/after
 * dengan kolom privat, dan alasan berformula (AC F17-3).
 */
async function seed(count = 6): Promise<Seeded> {
  const tag = `uji_${uuidv7().replace(/-/g, "").slice(-10)}`;
  const member = await createAlumni(t, { status: "verified", fullName: `Pelaku Alumni ${tag}` });
  const base = t.clock.now().getTime() - 60 * 60_000;
  const ids: string[] = [];
  const times: Date[] = [];
  for (let i = 0; i < count; i++) {
    const at = new Date(base + i * 60_000);
    const byAdmin = i % 2 === 0;
    ids.push(
      await writeAudit(t.db, {
        actorAdminId: byAdmin ? exporter.admin.adminId : null,
        actorUserId: byAdmin ? exporter.admin.userId : member.userId,
        effectiveRole: byAdmin ? "admin" : "alumni",
        action: i < 4 ? "payment.approved" : "member.profile_updated",
        entityType: tag,
        entityId: `entitas-${i % 3}`,
        requestId: `req-${tag}-${i}`,
        reason: i === 1 ? '=HYPERLINK("http://contoh.test")' : `alasan ${i}`,
        before: {
          email: `lama-${i}@contoh.test`,
          phone: "+628111",
          status: "pending",
          nested: { city: "Bandung" },
        },
        after: { status: "paid", amount: "60000.00", proof_file_id: uuidv7() },
        createdAt: at,
      }),
    );
    times.push(at);
  }
  return { tag, ids, times, memberId: member.userId };
}

async function search(token: string, query: Record<string, string>) {
  const res = await api.get(ENTRIES, { token, query });
  return { res, body: expectOperation("get", ENTRIES, res) as JsonBody };
}

async function createExport(actor: AdminActor, filters: Record<string, unknown>, key = uuidv7()) {
  return api.post(EXPORTS, filters, { token: actor.token, headers: { "idempotency-key": key } });
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  return rows;
}

async function download(url: string) {
  const path = new URL(url).pathname;
  return t.app.inject({ method: "GET", url: path });
}

describe("GET /admin/audit/entries (AC F17-2, F17-4)", () => {
  it("AC F17-4: filter aktor/entitas/waktu digabung AND, total mengikuti filter, urutan created_at menurun", async () => {
    const s = await seed(6);
    const all = await search(auditor.token, { entity_type: s.tag });
    expect(all.res.statusCode).toBe(200);
    expect(all.body.total).toBe(6);
    expect(all.body.items.map((i: { id: string }) => i.id)).toEqual([...s.ids].reverse());
    // Item daftar tanpa before/after; nama pelaku dari identitas server.
    expect(all.body.items[0]).not.toHaveProperty("before");
    const byAdmin = all.body.items.find((i: { id: string }) => i.id === s.ids[0]);
    expect(byAdmin).toMatchObject({
      action: "payment.approved",
      effective_role: "admin",
      actor: {
        admin_id: exporter.admin.adminId,
        user_id: exporter.admin.userId,
        display_name: "Pengekspor Audit",
      },
      request_id: `req-${s.tag}-0`,
      reason: "alasan 0",
    });
    const byMember = all.body.items.find((i: { id: string }) => i.id === s.ids[1]);
    expect(byMember.actor).toEqual({
      admin_id: null,
      user_id: s.memberId,
      display_name: `Pelaku Alumni ${s.tag}`,
    });

    const cases: [Record<string, string>, number[]][] = [
      [{ action: "payment.approved" }, [3, 2, 1, 0]],
      [{ effective_role: "alumni" }, [5, 3, 1]],
      [{ actor_admin_id: exporter.admin.adminId }, [4, 2, 0]],
      [{ actor_user_id: s.memberId }, [5, 3, 1]],
      [{ actor_q: "pengekspor" }, [4, 2, 0]],
      [{ actor_q: s.tag.slice(-6).toUpperCase() }, [5, 3, 1]],
      [{ entity_id: "entitas-1" }, [4, 1]],
      [{ request_id: `req-${s.tag}-3` }, [3]],
      // from inklusif, to eksklusif.
      [{ from: s.times[2]!.toISOString(), to: s.times[4]!.toISOString() }, [3, 2]],
      [{ action: "payment.approved", effective_role: "admin", from: s.times[1]!.toISOString() }, [2]],
    ];
    for (const [filter, expected] of cases) {
      const { body } = await search(auditor.token, { entity_type: s.tag, ...filter });
      expect(
        body.items.map((i: { id: string }) => i.id),
        JSON.stringify(filter),
      ).toEqual(expected.map((n) => s.ids[n]));
      expect(body.total, JSON.stringify(filter)).toBe(expected.length);
    }
  });

  it("AC F17-4: paging keyset (created_at, id) naik/turun tanpa duplikasi; total tetap", async () => {
    const s = await seed(5);
    for (const sort of ["created_at_desc", "created_at_asc"]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: Record<string, string> = { entity_type: s.tag, sort, limit: "2" };
        if (cursor) query.cursor = cursor;
        const { body } = await search(auditor.token, query);
        expect(body.total).toBe(5);
        seen.push(...body.items.map((i: { id: string }) => i.id));
        cursor = body.next_cursor;
      } while (cursor);
      expect(seen).toEqual(sort === "created_at_asc" ? s.ids : [...s.ids].reverse());
    }
  });

  it.each([
    [{ actor_q: "a" }, "actor_q"],
    [{ actor_admin_id: "bukan-uuid" }, "actor_admin_id"],
    [{ effective_role: "pemilik" }, "effective_role"],
    [{ from: "2026-10-12" }, "from"],
    [{ from: "2026-10-12T10:00:00Z", to: "2026-10-12T10:00:00Z" }, "to"],
    [{ sort: "acak" }, "sort"],
  ])("filter tidak sah %j ditolak 400 pada %s", async (query, field) => {
    const res = await api.get(ENTRIES, { token: auditor.token, query: query as Record<string, string> });
    expect(res.statusCode).toBe(400);
    expect(expectOperation("get", ENTRIES, res)).toMatchObject({
      field_errors: { [field]: expect.any(Array) },
    });
  });

  it("detail memuat before/after sebagaimana disimpan (tanpa penyamaran di dalam sistem); 404 dan 400", async () => {
    const s = await seed(1);
    const res = await api.get(`${ENTRIES}/${s.ids[0]}`, { token: auditor.token });
    const body = expectOperation("get", "/admin/audit/entries/{entryId}", res) as JsonBody;
    expect(body.before).toMatchObject({ email: "lama-0@contoh.test" });
    expect(body.after).toMatchObject({ status: "paid" });
    expect((await api.get(`${ENTRIES}/${uuidv7()}`, { token: auditor.token })).statusCode).toBe(404);
    const bad = await api.get(`${ENTRIES}/bukan-uuid`, { token: auditor.token });
    expect(bad.statusCode).toBe(400);
    expect(expectOperation("get", "/admin/audit/entries/{entryId}", bad)).toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("AC F17-2: tanpa audit.read ditolak 403 walaupun URL/id diketahui; token alumni 403; tanpa token 401", async () => {
    const s = await seed(1);
    const other = await adminActor(t, { permissions: ["payments.read", "settings.manage"] });
    for (const path of [ENTRIES, `${ENTRIES}/${s.ids[0]}`]) {
      const res = await api.get(path, { token: other.token });
      expect(res.statusCode, path).toBe(403);
      expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
    }
    const member = await createAlumni(t, { status: "verified" });
    const session = await signInAlumni(t, member);
    expect((await api.get(ENTRIES, { token: session.accessToken })).statusCode).toBe(403);
    expect((await api.get(ENTRIES)).statusCode).toBe(401);
  });
});

describe("Ekspor audit CSV asinkron (AC F17-2, F17-3, F17-4)", () => {
  it("AC F17-3, F17-4: filter sama dengan pencarian, worker menulis berkas privat kedaluwarsa, CSV dinetralkan dan disamarkan", async () => {
    const s = await seed(6);
    const filters = { entity_type: s.tag, action: "payment.approved" };
    const searched = await search(exporter.token, filters);

    const created = await createExport(exporter, filters);
    const exp = expectOperation("post", EXPORTS, created) as JsonBody;
    expect(created.statusCode, created.body).toBe(202);
    expect(exp).toMatchObject({
      status: "processing",
      filters,
      requested_by: { admin_id: exporter.admin.adminId, display_name: "Pengekspor Audit" },
      requested_at: t.clock.now().toISOString(),
      completed_at: null,
      file_name: null,
      failure_reason: null,
    });
    // Satu transaksi: entri audit permintaan + outbox dengan dedup id ekspor (AC F17-1).
    const [requested] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "audit.export.requested"), eq(auditLogs.entityId, exp.id)));
    expect(requested).toMatchObject({ entityType: "audit_export", actorAdminId: exporter.admin.adminId });
    expect(requested!.after).toEqual({ filters });
    const [event] = await t.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.dedupKey, `audit.export.requested:${exp.id}`));
    expect(event!.payload).toMatchObject({ export_id: exp.id });

    // Belum diproses: status processing dan unduhan 409 dengan current.
    const early = await api.get(`${EXPORTS}/${exp.id}/access`, { token: exporter.token });
    expect(early.statusCode).toBe(409);
    expect(expectOperation("get", ACCESS, early)).toMatchObject({
      code: "VERSION_CONFLICT",
      current: { id: exp.id, status: "processing" },
    });

    await t.jobs.drainOutbox();
    const ready = await api.get(`${EXPORTS}/${exp.id}`, { token: exporter.token });
    const readyBody = expectOperation("get", EXPORT, ready) as JsonBody;
    const day = t.clock.now().toISOString().slice(0, 10).replace(/-/g, "");
    expect(readyBody).toMatchObject({
      status: "ready",
      row_count: searched.body.total,
      file_name: `audit-${day}-${exp.id.replace(/-/g, "").slice(0, 8)}.csv`,
      expires_at: new Date(t.clock.now().getTime() + 24 * 3600_000).toISOString(),
      failure_reason: null,
    });
    expect(readyBody.bytes).toBeGreaterThan(0);
    expect(readyBody.completed_at).not.toBeNull();

    // Berkas privat purpose audit_export milik akun login peminta, entri completed dari sistem.
    const [completed] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "audit.export.completed"), eq(auditLogs.entityId, exp.id)));
    expect(completed).toMatchObject({ effectiveRole: "system", actorAdminId: null });
    const fileId = (completed!.after as { file_id: string }).file_id;
    const [file] = await t.db.select().from(files).where(eq(files.id, fileId));
    expect(file).toMatchObject({
      purpose: "audit_export",
      visibility: "private",
      status: "ready",
      ownerUserId: exporter.admin.userId,
      mime: "text/csv",
    });

    // Unduhan: URL bertanda tangan <= 10 menit, diaudit, tanpa cache publik.
    const access = await api.get(`${EXPORTS}/${exp.id}/access`, { token: exporter.token });
    const grant = expectOperation("get", ACCESS, access) as {
      url: string;
      expires_at: string;
      file_name: string;
    };
    expect(access.statusCode).toBe(200);
    expect(access.headers["cache-control"]).toBe("no-store");
    expect(grant.file_name).toBe(readyBody.file_name);
    expect(Date.parse(grant.expires_at) - t.clock.now().getTime()).toBeLessThanOrEqual(10 * 60_000);
    const [downloaded] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "audit.export.downloaded"), eq(auditLogs.entityId, exp.id)));
    expect(downloaded).toMatchObject({ actorAdminId: exporter.admin.adminId });

    const content = await download(grant.url);
    expect(content.statusCode).toBe(200);
    const rows = parseCsv(content.body);
    expect(rows[0]).toEqual([
      "created_at",
      "action",
      "entity_type",
      "entity_id",
      "effective_role",
      "actor_admin_id",
      "actor_user_id",
      "actor_name",
      "request_id",
      "reason",
      "before",
      "after",
    ]);
    const data = rows.slice(1);
    // Hasil ekspor = hasil pencarian dengan filter yang sama, urutan sama (AC F17-4).
    expect(data.map((r) => r[8])).toEqual(
      searched.body.items.map((i: { request_id: string }) => i.request_id),
    );
    // AC F17-3: formula dinetralkan, kolom privat/secret tidak ikut ekspor.
    const formula = data.find((r) => r[8] === `req-${s.tag}-1`)!;
    expect(formula[9]).toBe('\'=HYPERLINK("http://contoh.test")');
    expect(content.body).not.toMatch(/lama-\d@contoh\.test/);
    expect(content.body).not.toContain("+628111");
    const before = JSON.parse(formula[10]!) as Record<string, unknown>;
    expect(before).toEqual({
      email: "[disembunyikan]",
      phone: "[disembunyikan]",
      status: "pending",
      nested: { city: "[disembunyikan]" },
    });
    expect(JSON.parse(formula[11]!)).toMatchObject({ proof_file_id: "[disembunyikan]", status: "paid" });
  });

  it("PRD 4.3: Idempotency-Key yang sama tidak membuat job ganda", async () => {
    const key = uuidv7();
    const filters = { entity_type: `idem_${uuidv7().slice(-8)}` };
    const first = await createExport(exporter, filters, key);
    const replay = await createExport(exporter, filters, key);
    expect(replay.statusCode).toBe(202);
    expect(replay.json().id).toBe(first.json().id);
    const rows = await t.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "audit.export.requested"),
          eq(auditLogs.actorAdminId, exporter.admin.adminId),
        ),
      );
    expect(
      rows.filter(
        (r) => (r.after as { filters: { entity_type?: string } }).filters.entity_type === filters.entity_type,
      ),
    ).toHaveLength(1);
  });

  it("AC F17-2: hanya peminta atau Super Admin; admin lain 404; tanpa audit.export 403 walaupun id/URL berkas diketahui", async () => {
    const s = await seed(2);
    const created = await createExport(exporter, { entity_type: s.tag });
    const id = created.json().id as string;
    await t.jobs.drainOutbox();

    const peer = await adminActor(t, { permissions: ["audit.read", "audit.export"] });
    for (const path of [`${EXPORTS}/${id}`, `${EXPORTS}/${id}/access`]) {
      const res = await api.get(path, { token: peer.token });
      expect(res.statusCode, path).toBe(404);
    }
    const peerList = await api.get(EXPORTS, { token: peer.token });
    expect(peerList.json().items.map((i: { id: string }) => i.id)).not.toContain(id);

    // Tanpa audit.export (hanya audit.read): semua operasi ekspor 403.
    for (const res of [
      await api.get(EXPORTS, { token: auditor.token }),
      await api.get(`${EXPORTS}/${id}`, { token: auditor.token }),
      await api.get(`${EXPORTS}/${id}/access`, { token: auditor.token }),
      await createExport(auditor, { entity_type: s.tag }),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
    }

    // Jalur berkas umum tidak membuka berkas audit_export tanpa pemeriksaan yang sama (N-09: 404).
    const [completed] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "audit.export.completed"), eq(auditLogs.entityId, id)));
    const fileId = (completed!.after as { file_id: string }).file_id;
    for (const actor of [auditor, peer]) {
      const res = await api.get(`/files/${fileId}/access`, { token: actor.token });
      expect(res.statusCode).toBe(404);
    }
    expect((await api.get(`/files/${fileId}/access`, { token: exporter.token })).statusCode).toBe(200);

    // Super Admin melihat semua ekspor beserta peminta dan dapat mengunduh.
    const list = await api.get(EXPORTS, { token: root.token });
    const item = (expectOperation("get", EXPORTS, list) as { items: JsonBody[] }).items.find(
      (i) => i.id === id,
    );
    expect(item).toMatchObject({ status: "ready", requested_by: { admin_id: exporter.admin.adminId } });
    expect((await api.get(`${EXPORTS}/${id}/access`, { token: root.token })).statusCode).toBe(200);
  });

  it("AC F17-2: URL unduh yang sudah diterbitkan mati saat audit.export peminta dicabut", async () => {
    const holder = await adminActor(t, { permissions: ["audit.read", "audit.export"] });
    const s = await seed(1);
    const id = (await createExport(holder, { entity_type: s.tag })).json().id as string;
    await t.jobs.drainOutbox();
    const grant = (await api.get(`${EXPORTS}/${id}/access`, { token: holder.token })).json() as {
      url: string;
    };
    expect((await download(grant.url)).statusCode).toBe(200);

    const detail = (await api.get(`/admin/admins/${holder.admin.adminId}`, { token: root.token })).json();
    const revoke = await api.patch(
      `/admin/admins/${holder.admin.adminId}`,
      { permissions: ["audit.read"] },
      await root.sensitive(detail.version),
    );
    expect(revoke.statusCode).toBe(200);
    expect((await download(grant.url)).statusCode).toBe(404);
    expect((await api.get(`${EXPORTS}/${id}/access`, { token: holder.token })).statusCode).toBe(403);
  });

  it("daftar ekspor milik sendiri urut terbaru, filter status, total mengikuti filter", async () => {
    const own = await adminActor(t, { permissions: ["audit.read", "audit.export"] });
    const s = await seed(1);
    const first = (await createExport(own, { entity_type: s.tag })).json().id as string;
    await t.jobs.drainOutbox();
    t.clock.advance(1000);
    const second = (await createExport(own, { entity_type: s.tag, action: "tidak.ada" })).json().id as string;
    const all = await api.get(EXPORTS, { token: own.token });
    const body = expectOperation("get", EXPORTS, all) as {
      items: { id: string; status: string }[];
      total: number;
    };
    expect(body.items.map((i) => i.id)).toEqual([second, first]);
    expect(body.total).toBe(2);
    const processing = await api.get(EXPORTS, { token: own.token, query: { status: "processing" } });
    expect(processing.json()).toMatchObject({ total: 1, items: [{ id: second }] });
    const ready = await api.get(EXPORTS, { token: own.token, query: { status: "ready", limit: "1" } });
    expect(ready.json()).toMatchObject({ total: 1, items: [{ id: first }], next_cursor: null });
    const paged = await api.get(EXPORTS, { token: own.token, query: { limit: "1" } });
    const next = await api.get(EXPORTS, {
      token: own.token,
      query: { limit: "1", cursor: paged.json().next_cursor },
    });
    expect(next.json().items.map((i: { id: string }) => i.id)).toEqual([first]);
    expect((await api.get(EXPORTS, { token: own.token, query: { status: "lain" } })).statusCode).toBe(400);
  });

  it("filter ekspor tidak sah ditolak 400 dengan aturan yang sama dengan pencarian", async () => {
    const res = await createExport(exporter, { from: "2026-10-12T10:00:00Z", to: "2026-10-12T09:00:00Z" });
    expect(res.statusCode).toBe(400);
    expect(expectOperation("post", EXPORTS, res)).toMatchObject({ field_errors: { to: expect.any(Array) } });
    const unknownRole = await createExport(exporter, { effective_role: "pemilik" });
    expect(unknownRole.statusCode).toBe(400);
  });

  it("AC F17-4: hasil melebihi batas baris gagal row_limit_exceeded, tidak dipotong diam-diam", async () => {
    const job = t.app.get(AuditExportJob);
    const s = await seed(4);
    job.rowLimit = 3;
    try {
      const id = (await createExport(exporter, { entity_type: s.tag })).json().id as string;
      await t.jobs.drainOutbox();
      const res = await api.get(`${EXPORTS}/${id}`, { token: exporter.token });
      expect(expectOperation("get", EXPORT, res)).toMatchObject({
        status: "failed",
        failure_reason: "row_limit_exceeded",
        file_name: null,
        row_count: null,
      });
      expect(res.json().completed_at).not.toBeNull();
      const files = await t.db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "audit.export.completed"), eq(auditLogs.entityId, id)));
      expect(files).toEqual([]);
    } finally {
      job.rowLimit = 50_000;
    }
  });

  it("job yang tidak selesai sebelum batas waktu menjadi failed/timed_out dan tidak menulis berkas", async () => {
    const own = await adminActor(t, { permissions: ["audit.read", "audit.export"] });
    const s = await seed(1);
    const id = (await createExport(own, { entity_type: s.tag })).json().id as string;
    t.clock.advance(3600_000 + 1000);
    // Idle timeout admin 30 menit (AC F02-5) mencabut sesi lama: masuk ulang.
    const again = await signInActor(t, own.admin);
    const res = await api.get(`${EXPORTS}/${id}`, { token: again.token });
    expect(expectOperation("get", EXPORT, res)).toMatchObject({
      status: "failed",
      failure_reason: "timed_out",
      completed_at: null,
    });
    await t.jobs.drainOutbox();
    const terminal = await t.db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
    expect(terminal.map((r) => r.action)).toEqual(["audit.export.requested"]);
    const access = await api.get(`${EXPORTS}/${id}/access`, { token: again.token });
    expect(access.statusCode).toBe(409);
    expect(access.json()).toMatchObject({ current: { status: "failed", failure_reason: "timed_out" } });
  });

  it("galat storage diulang outbox; setelah batas percobaan ditulis tepat satu entri processing_failed", async () => {
    const own = await adminActor(t, { permissions: ["audit.read", "audit.export"] });
    const s = await seed(1);
    const id = (await createExport(own, { entity_type: s.tag })).json().id as string;
    t.storage.failNext("put", 3);
    for (let attempt = 0; attempt < 3; attempt++) {
      await t.jobs.dispatchOutbox();
      t.clock.advance(60_000);
    }
    const res = await api.get(`${EXPORTS}/${id}`, { token: own.token });
    expect(expectOperation("get", EXPORT, res)).toMatchObject({
      status: "failed",
      failure_reason: "processing_failed",
    });
    const failed = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "audit.export.failed"), eq(auditLogs.entityId, id)));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      effectiveRole: "system",
      after: { failure_reason: "processing_failed" },
    });
    // Tidak ada objek storage maupun baris berkas yatim dari percobaan yang gagal.
    const exportFiles = await t.db.select().from(files).where(eq(files.ownerUserId, own.admin.userId));
    expect(exportFiles).toEqual([]);
    // Event berikutnya (mis. redelivery) tidak menulis entri terminal kedua.
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;
    await runAsSystem(() =>
      t.app.get(AuditExportJob).handle(
        {
          id: uuidv7(),
          topic: "audit.export.requested",
          dedupKey: "uji",
          attempts: 1,
          requestId: null,
          payload: { export_id: id, admin_id: own.admin.adminId },
        },
        { jobId: "uji", requestId: "uji", logger },
      ),
    );
    const terminal = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.entityType, "audit_export")));
    expect(terminal.filter((r) => r.action !== "audit.export.requested")).toHaveLength(1);
  });

  it("AC F17-4: berkas kedaluwarsa otomatis: status expired, unduhan 404, maintenance.cleanup menghapus objek", async () => {
    const own = await adminActor(t, { permissions: ["audit.read", "audit.export"] });
    const s = await seed(1);
    const id = (await createExport(own, { entity_type: s.tag })).json().id as string;
    await t.jobs.drainOutbox();
    const [completed] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "audit.export.completed"), eq(auditLogs.entityId, id)));
    const fileId = (completed!.after as { file_id: string }).file_id;
    const [file] = await t.db.select().from(files).where(eq(files.id, fileId));
    expect(await t.storage.exists(file!.objectKey)).toBe(true);

    t.clock.advance(24 * 3600_000 + 1000);
    const again = await signInActor(t, own.admin);
    const expired = await api.get(`${EXPORTS}/${id}`, { token: again.token });
    expect(expectOperation("get", EXPORT, expired)).toMatchObject({ status: "expired" });
    const access = await api.get(`${EXPORTS}/${id}/access`, { token: again.token });
    expect(access.statusCode).toBe(404);
    expect(expectOperation("get", ACCESS, access)).toMatchObject({ code: "NOT_FOUND" });
    const expiredList = await api.get(EXPORTS, { token: again.token, query: { status: "expired" } });
    expect(expiredList.json()).toMatchObject({ total: 1, items: [{ id }] });

    await t.jobs.runScheduled("maintenance.cleanup");
    const [after] = await t.db.select().from(files).where(eq(files.id, fileId));
    expect(after!.status).toBe("deleted");
    expect(await t.storage.exists(file!.objectKey)).toBe(false);
    const still = await api.get(`${EXPORTS}/${id}`, { token: again.token });
    expect(still.json()).toMatchObject({ status: "expired", file_name: expect.any(String) });
  });

  it("pembuatan ekspor dibatasi per admin (429 RATE_LIMITED dengan retry_after_seconds)", async () => {
    const busy = await adminActor(t, { permissions: ["audit.read", "audit.export"] });
    for (let i = 0; i < 10; i++)
      expect((await createExport(busy, { entity_type: `batas_${i}` })).statusCode).toBe(202);
    const res = await createExport(busy, { entity_type: "batas_11" });
    expect(res.statusCode).toBe(429);
    expect(expectOperation("post", EXPORTS, res)).toMatchObject({
      code: "RATE_LIMITED",
      retry_after_seconds: expect.any(Number),
    });
  });
});
