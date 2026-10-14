import type { Permission } from "@kapdh/contracts";
import { admins, auditLogs } from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdmin, createAlumni, signInAdmin, signInAlumni } from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { addRoomMember, createGroupRoom, createMessage, reportOk } from "./fixtures.js";

/**
 * Akses berkas bukti moderasi di luar detail laporan (PRD 2.3, 3.12 "akses bukti dibatasi dan diaudit", AC F12-2,
 * F17-1; kontrak admin-moderation aturan domain butir a dan c; temuan audit D1-02, D3-02): kebijakan
 * moderation/evidence-file-policy.ts hanya mengizinkan bila ada laporan perujuk yang terlihat bagi pengurus, dan
 * GET /files/{fileId}/access atas bukti menulis audit `moderation.evidence_viewed`.
 */

let t: TestApp;
const MODERATOR: Permission[] = ["moderation.read", "moderation.resolve"];

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

const api = () => httpClient(t.app);

async function member(fullName: string) {
  const fixture = await createAlumni(t, { fullName, status: "verified" });
  const session = await signInAlumni(t, fixture);
  return { ...fixture, token: session.accessToken };
}

async function moderator(options: { permissions?: Permission[]; linkedAlumniUserId?: string } = {}) {
  const admin = await createAdmin(t, {
    permissions: options.permissions ?? MODERATOR,
    linkedAlumniUserId: options.linkedAlumniUserId ?? null,
  });
  return { ...admin, token: (await signInAdmin(t, admin)).accessToken };
}

const evidenceAudits = (adminId: string) =>
  t.db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.actorAdminId, adminId), eq(auditLogs.action, "moderation.evidence_viewed")));

/** Grup berisi pelapor dan pengirim; pesan bergambar dari pengirim dilaporkan. */
async function reportedImage(names: { reporter: string; sender: string }) {
  const reporter = await member(names.reporter);
  const sender = await member(names.sender);
  const group = await createGroupRoom(t, { name: "Grup Bukti Berkas", adminId: reporter.userId });
  await addRoomMember(t, group, sender.userId);
  const image = await uploadTestFile(t, sender.token, "chat_image");
  const message = await createMessage(t, group, sender.userId, { imageFileId: image.id });
  const reportId = await reportOk(t.app, reporter.token, {
    target_type: "message",
    message_id: message,
    category: "sexual",
  });
  return { reporter, sender, group, image, reportId };
}

describe("GET /files/{fileId}/access atas berkas bukti moderasi", () => {
  it("URL bukti dari detail laporan mati begitu pengurus ditautkan ke pihak terlapor (kebijakan dievaluasi ulang)", async () => {
    const { sender, image, reportId } = await reportedImage({
      reporter: "Pelapor Tautan",
      sender: "Pengirim Tautan",
    });
    const admin = await moderator();
    const detail = await api().get(`/admin/reports/${reportId}`, { token: admin.token });
    expect(detail.statusCode, detail.body).toBe(200);
    const url = (detail.json() as { evidence: { messages: { image: { url: string } | null }[] } }).evidence
      .messages[0]!.image!.url;
    expect((await t.app.inject({ method: "GET", url: new URL(url).pathname })).statusCode).toBe(200);

    // Pengurus kemudian ditautkan ke akun pengirim (pihak terlapor): laporan dan buktinya tersembunyi seketika.
    await t.db.update(admins).set({ linkedAlumniUserId: sender.userId }).where(eq(admins.id, admin.adminId));
    expect((await t.app.inject({ method: "GET", url: new URL(url).pathname })).statusCode).toBe(404);
    expect((await api().get(`/files/${image.id}/access`, { token: admin.token })).statusCode).toBe(404);
    expect((await api().get(`/admin/reports/${reportId}`, { token: admin.token })).statusCode).toBe(404);
    expect(await evidenceAudits(admin.adminId)).toEqual([]);
  });

  it("laporan grup tanpa subjek tersembunyi bagi pengurus yang akun tertautnya anggota joined: avatar grup 404; pengurus lain 200 dan diaudit", async () => {
    const owner = await member("Admin Grup Bukti");
    const reporter = await member("Pelapor Grup Bukti");
    const linked = await member("Anggota Tertaut Grup");
    const avatar = await uploadTestFile(t, owner.token, "chat_image");
    const group = await createGroupRoom(t, {
      name: "Grup Dilaporkan",
      adminId: owner.userId,
      avatarFileId: avatar.id,
    });
    await addRoomMember(t, group, reporter.userId);
    await addRoomMember(t, group, linked.userId);
    const reportId = await reportOk(t.app, reporter.token, {
      target_type: "room",
      room_id: group,
      category: "spam",
    });

    const conflicted = await moderator({ linkedAlumniUserId: linked.userId });
    expect((await api().get(`/admin/reports/${reportId}`, { token: conflicted.token })).statusCode).toBe(404);
    expect((await api().get(`/files/${avatar.id}/access`, { token: conflicted.token })).statusCode).toBe(404);
    expect(await evidenceAudits(conflicted.adminId)).toEqual([]);

    const other = await moderator();
    const access = await api().get(`/files/${avatar.id}/access`, { token: other.token });
    expect(access.statusCode, access.body).toBe(200);
    const [audit] = await evidenceAudits(other.adminId);
    expect(audit).toMatchObject({ entityType: "file", entityId: avatar.id });
    expect(audit!.after).toEqual({ via: "file_access", purpose: "chat_image", report_ids: [reportId] });
  });

  it("akses non-bukti tidak dicatat sebagai pembukaan bukti: pengunggah membuka gambar chat, pengurus tanpa moderation.read ditolak", async () => {
    const { sender, image } = await reportedImage({
      reporter: "Pelapor Anggota",
      sender: "Pengirim Anggota",
    });
    // Sesi anggota (pengunggah) membuka gambar lewat kebijakan chat; tidak ada audit moderasi.
    expect((await api().get(`/files/${image.id}/access`, { token: sender.token })).statusCode).toBe(200);
    const memberAudits = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, image.id), eq(auditLogs.action, "moderation.evidence_viewed")));
    expect(memberAudits).toEqual([]);

    const finance = await moderator({ permissions: ["payments.read"] });
    expect((await api().get(`/files/${image.id}/access`, { token: finance.token })).statusCode).toBe(404);
    expect(await evidenceAudits(finance.adminId)).toEqual([]);
  });
});
