/**
 * Akses modul chat (F-11, AC F11-4, F11-6; PRD 2.2; ARCHITECTURE §4.3): dekorator server sama dengan x-kapdh-access
 * kontrak chat.yaml untuk SETIAP operasi, penolakan audience/status, dan keanggotaan room pada setiap operasi.
 */
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FilesService } from "../../src/core/files/files.service.js";
import { accessMismatches, expectOperation, type HttpMethod, spec } from "../support/contract.js";
import { createAdmin, signInAdmin } from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
import { routeAccessList } from "../support/routes.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  api,
  errorCode,
  groupWith,
  type Member,
  member,
  openDirect,
  openFileUrl,
  sendRaw,
  sendText,
} from "./support.js";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

/** Semua operasi domain chat (kontrak domains/chat.yaml). */
const OPERATIONS: [HttpMethod, string][] = [
  ["get", "/chat/rooms"],
  ["post", "/chat/rooms"],
  ["post", "/chat/direct"],
  ["get", "/chat/rooms/{roomId}"],
  ["patch", "/chat/rooms/{roomId}"],
  ["get", "/chat/rooms/{roomId}/members"],
  ["patch", "/chat/rooms/{roomId}/members/{userId}"],
  ["delete", "/chat/rooms/{roomId}/members/{userId}"],
  ["post", "/chat/rooms/{roomId}/invitations"],
  ["get", "/chat/invitations"],
  ["post", "/chat/invitations/{roomId}/accept"],
  ["post", "/chat/invitations/{roomId}/decline"],
  ["post", "/chat/rooms/{roomId}/leave"],
  ["put", "/chat/rooms/{roomId}/mute"],
  ["get", "/chat/rooms/{roomId}/messages"],
  ["post", "/chat/rooms/{roomId}/messages"],
  ["delete", "/chat/rooms/{roomId}/messages/{messageId}"],
  ["put", "/chat/rooms/{roomId}/messages/{messageId}/reactions/{emoji}"],
  ["delete", "/chat/rooms/{roomId}/messages/{messageId}/reactions/{emoji}"],
  ["put", "/chat/rooms/{roomId}/read"],
];

const BODIES: Record<string, unknown> = {
  "post /chat/rooms": { name: "Grup Uji" },
  "post /chat/direct": { user_id: uuidv7() },
  "patch /chat/rooms/{roomId}": { name: "Nama Baru" },
  "patch /chat/rooms/{roomId}/members/{userId}": { role: "admin" },
  "post /chat/rooms/{roomId}/invitations": { user_ids: [uuidv7()] },
  "post /chat/rooms/{roomId}/leave": {},
  "put /chat/rooms/{roomId}/mute": { muted: true },
  "post /chat/rooms/{roomId}/messages": { client_message_id: uuidv7(), kind: "text", body: "Halo" },
  "put /chat/rooms/{roomId}/read": { message_id: uuidv7() },
};

function call(
  method: HttpMethod,
  template: string,
  params: { roomId: string; userId?: string; messageId?: string },
  token?: string,
) {
  const url = template
    .replace("{roomId}", params.roomId)
    .replace("{userId}", params.userId ?? uuidv7())
    .replace("{messageId}", params.messageId ?? uuidv7())
    .replace("{emoji}", encodeURIComponent("👍"));
  const body = BODIES[`${method} ${template}`];
  const client = api(t);
  const headers: Record<string, string> =
    method === "patch" && template === "/chat/rooms/{roomId}" ? { "if-match": "1" } : {};
  const options = { token, headers };
  switch (method) {
    case "get":
      return client.get(url, options);
    case "delete":
      return client.delete(url, options);
    case "post":
      return client.post(url, body ?? {}, options);
    case "put":
      return client.put(url, body ?? {}, options);
    case "patch":
      return client.patch(url, body ?? {}, options);
  }
}

describe("Kontrak akses chat (ARCHITECTURE §4.3, kontrak chat.yaml x-kapdh-access)", () => {
  it("AC F11-4 / ARCHITECTURE §4.3: setiap operasi chat.yaml diimplementasikan tepat satu rute ChatController", () => {
    const contractOps = Object.entries(spec.paths)
      .filter(([path]) => path.startsWith("/chat/"))
      .flatMap(([path, item]) =>
        Object.keys(item)
          .filter((key) => ["get", "post", "put", "patch", "delete"].includes(key))
          .map((method) => `${method} ${path}`),
      )
      .sort();
    expect(contractOps).toEqual(OPERATIONS.map(([m, p]) => `${m} ${p}`).sort());
    const routes = routeAccessList(t.app).filter((route) => route.name.startsWith("ChatController."));
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(contractOps);
  });

  it("AC F11-6 / ARCHITECTURE §4.3: dekorator ChatController cocok dengan x-kapdh-access setiap operasi (audience mobile, member_access active, idempotent)", () => {
    const routes = routeAccessList(t.app).filter((route) => route.name.startsWith("ChatController."));
    expect(routes).toHaveLength(OPERATIONS.length);
    expect(accessMismatches(routes)).toEqual([]);
    for (const route of routes) {
      expect(route.meta.audience, route.name).toBe("mobile");
      expect(route.meta.memberAccess, route.name).toBe("active");
      expect(route.meta.problems, route.name).toEqual([]);
    }
    const idempotent = routes.filter((r) => r.idempotent).map((r) => `${r.method} ${r.path}`);
    expect(idempotent.sort()).toEqual(
      [
        "post /chat/rooms",
        "delete /chat/rooms/{roomId}/members/{userId}",
        "post /chat/rooms/{roomId}/invitations",
        "post /chat/invitations/{roomId}/accept",
        "post /chat/invitations/{roomId}/decline",
        "post /chat/rooms/{roomId}/leave",
      ].sort(),
    );
  });
});

describe("AC F11-6 / PRD 2.2: hanya anggota aktif (verified/expiring) yang memakai chat", () => {
  it("AC F11-6 negatif: tanpa token 401, sesi admin 403, unverified/expired 403 MEMBERSHIP_REQUIRED, suspended 403 ACCOUNT_SUSPENDED pada setiap operasi", async () => {
    const admin = await createAdmin(t, { role: "super_admin" });
    const adminToken = (await signInAdmin(t, admin)).accessToken;
    const unverified = await member(t, "unverified");
    const expired = await member(t, "expired");
    const suspended = await member(t, "suspended");
    const roomId = uuidv7();
    for (const [method, path] of OPERATIONS) {
      const where = `${method.toUpperCase()} ${path}`;
      const anonymous = await call(method, path, { roomId });
      expect(anonymous.statusCode, where).toBe(401);
      expectOperation(method, path, anonymous);
      const asAdmin = await call(method, path, { roomId }, adminToken);
      expect([asAdmin.statusCode, errorCode(asAdmin)], where).toEqual([403, "FORBIDDEN"]);
      for (const [who, code] of [
        [unverified, "MEMBERSHIP_REQUIRED"],
        [expired, "MEMBERSHIP_REQUIRED"],
        [suspended, "ACCOUNT_SUSPENDED"],
      ] as [Member, string][]) {
        const res = await call(method, path, { roomId }, who.token);
        expect([res.statusCode, errorCode(res)], `${where} ${who.status}`).toEqual([403, code]);
        expectOperation(method, path, res);
      }
    }
  });

  it("AC F11-6: anggota expiring tetap aktif dan dapat membaca daftar room", async () => {
    const expiring = await member(t, "expiring");
    const res = await api(t).get("/chat/rooms", { token: expiring.token });
    expect(res.statusCode).toBe(200);
    expectOperation("get", "/chat/rooms", res);
  });
});

describe("AC F11-4: keanggotaan room diperiksa pada setiap baca, kirim, unggah dan subscribe (UUID bukan izin)", () => {
  it("AC F11-4: anggota aktif yang bukan anggota room mendapat 404 pada setiap operasi room, tanpa membocorkan isi", async () => {
    const a = await member(t);
    const b = await member(t);
    const outsider = await member(t);
    const roomId = await groupWith(t, a, [b]);
    const sent = await sendText(t, a, roomId, "Rahasia grup");
    const roomOps: [HttpMethod, string][] = OPERATIONS.filter(
      ([, path]) => path.includes("{roomId}") && !path.startsWith("/chat/invitations"),
    );
    for (const [method, path] of roomOps) {
      const res = await call(method, path, { roomId, userId: b.userId, messageId: sent.id }, outsider.token);
      expect([res.statusCode, errorCode(res)], `${method.toUpperCase()} ${path}`).toEqual([404, "NOT_FOUND"]);
      expectOperation(method, path, res);
      expect(res.body).not.toContain("Rahasia grup");
    }
    // Undangan milik orang lain tidak dapat diterima/ditolak dengan menebak id room.
    for (const action of ["accept", "decline"]) {
      const res = await api(t).post(`/chat/invitations/${roomId}/${action}`, {}, { token: outsider.token });
      expect(res.statusCode).toBe(404);
    }
    // ID bukan UUID → 404 tanpa menyentuh SQL.
    expect((await api(t).get("/chat/rooms/bukan-uuid", { token: a.token })).statusCode).toBe(404);
  });

  it("AC F11-4: anggota yang sudah keluar tidak dapat membaca riwayat, mengirim, maupun membuka gambar room", async () => {
    const a = await member(t);
    const b = await member(t);
    const roomId = await groupWith(t, a, [b]);
    const image = await uploadTestFile(t, a.token, "chat_image");
    const sent = await api(t).post(
      `/chat/rooms/${roomId}/messages`,
      { client_message_id: uuidv7(), kind: "image", image_file_id: image.id },
      { token: a.token },
    );
    expect(sent.statusCode, sent.body).toBe(201);
    const imageAccessBefore = await api(t).get(`/files/${image.id}/access`, { token: b.token });
    expect(imageAccessBefore.statusCode).toBe(200);
    const signedPath = (imageAccessBefore.json() as { url: string }).url.slice(t.env.API_PUBLIC_URL.length);

    const left = await api(t).post(`/chat/rooms/${roomId}/leave`, {}, { token: b.token });
    expect(left.statusCode, left.body).toBe(204);
    expectOperation("post", "/chat/rooms/{roomId}/leave", left);
    for (const res of [
      await api(t).get(`/chat/rooms/${roomId}/messages`, { token: b.token }),
      await api(t).get(`/chat/rooms/${roomId}`, { token: b.token }),
      await api(t).post(
        `/chat/rooms/${roomId}/messages`,
        { client_message_id: uuidv7(), kind: "text", body: "Masih bisa?" },
        { token: b.token },
      ),
      await api(t).get(`/files/${image.id}/access`, { token: b.token }),
    ])
      expect(res.statusCode).toBe(404);
    // URL bertanda tangan yang sudah beredar ikut mati: otorisasi diulang saat dibuka (PRD 5.4).
    expect((await t.app.inject({ method: "GET", url: signedPath })).statusCode).toBe(404);
  });

  it("AC F11-4: gambar chat hanya untuk anggota joined; pengguna lain dan sesi admin tanpa izin mendapat 404", async () => {
    const a = await member(t);
    const b = await member(t);
    const outsider = await member(t);
    const room = await openDirect(t, a, b);
    const image = await uploadTestFile(t, a.token, "chat_image");
    const sent = await api(t).post(
      `/chat/rooms/${room.id}/messages`,
      { client_message_id: uuidv7(), kind: "image", image_file_id: image.id, body: "Foto reuni" },
      { token: a.token },
    );
    expect(sent.statusCode, sent.body).toBe(201);
    expect((await api(t).get(`/files/${image.id}/access`, { token: b.token })).statusCode).toBe(200);
    expect((await api(t).get(`/files/${image.id}/access`, { token: outsider.token })).statusCode).toBe(404);
    const admin = await createAdmin(t, { permissions: ["members.read"] });
    const adminToken = (await signInAdmin(t, admin)).accessToken;
    expect((await api(t).get(`/files/${image.id}/access`, { token: adminToken })).statusCode).toBe(404);
  });

  it("AC F11-4: pengunggah gambar pesan atau avatar grup yang sudah keluar room tidak lagi dapat membukanya; unggahan sendiri yang belum terpakai tetap dapat dibuka", async () => {
    const a = await member(t);
    const b = await member(t);
    const c = await member(t);
    const avatar = await uploadTestFile(t, a.token, "chat_image");
    const created = await api(t).post(
      "/chat/rooms",
      { name: "Grup Foto", avatar_file_id: avatar.id, invitee_user_ids: [b.userId, c.userId] },
      { token: a.token },
    );
    expect(created.statusCode, created.body).toBe(201);
    const roomId = (created.json() as { room: { id: string } }).room.id;
    for (const m of [b, c])
      expect(
        (await api(t).post(`/chat/invitations/${roomId}/accept`, {}, { token: m.token })).statusCode,
      ).toBe(200);

    // Unggahan yang belum dipakai: hanya pengunggahnya (pratinjau sebelum dikirim).
    const pending = await uploadTestFile(t, b.token, "chat_image");
    expect((await api(t).get(`/files/${pending.id}/access`, { token: b.token })).statusCode).toBe(200);
    expect((await api(t).get(`/files/${pending.id}/access`, { token: c.token })).statusCode).toBe(404);
    const sent = await sendRaw(t, b, roomId, { kind: "image", image_file_id: pending.id });
    expect(sent.statusCode, sent.body).toBe(201);
    const grant = await api(t).get(`/files/${pending.id}/access`, { token: b.token });
    expect(grant.statusCode).toBe(200);
    const circulating = (grant.json() as { url: string }).url;

    // Pengirim keluar: gambarnya sendiri ikut tertutup, termasuk URL yang sudah beredar (PRD 5.4).
    expect((await api(t).post(`/chat/rooms/${roomId}/leave`, {}, { token: b.token })).statusCode).toBe(204);
    expect((await api(t).get(`/files/${pending.id}/access`, { token: b.token })).statusCode).toBe(404);
    expect(await openFileUrl(t, circulating)).toBe(404);
    expect((await api(t).get(`/files/${pending.id}/access`, { token: c.token })).statusCode).toBe(200);

    // Pengunggah avatar grup (admin) keluar setelah menunjuk pengganti: avatar grup tidak lagi dapat dibukanya.
    expect((await api(t).get(`/files/${avatar.id}/access`, { token: a.token })).statusCode).toBe(200);
    const leave = await api(t).post(
      `/chat/rooms/${roomId}/leave`,
      { successor_user_id: c.userId },
      { token: a.token },
    );
    expect(leave.statusCode, leave.body).toBe(204);
    expect((await api(t).get(`/files/${avatar.id}/access`, { token: a.token })).statusCode).toBe(404);
    expect((await api(t).get(`/files/${avatar.id}/access`, { token: c.token })).statusCode).toBe(200);
  });

  it("AC F11-4: kebijakan chat_image tambahan dari modul lain (mis. bukti laporan untuk moderator) tetap berlaku di samping aturan anggota room", async () => {
    const a = await member(t);
    const b = await member(t);
    const room = await openDirect(t, a, b);
    const image = await uploadTestFile(t, a.token, "chat_image");
    expect(
      (await sendRaw(t, a, room.id, { kind: "image", image_file_id: image.id, body: "Bukti" })).statusCode,
    ).toBe(201);
    const moderator = await createAdmin(t, { permissions: ["moderation.read"] });
    const moderatorToken = (await signInAdmin(t, moderator)).accessToken;
    expect((await api(t).get(`/files/${image.id}/access`, { token: moderatorToken })).statusCode).toBe(404);
    // Pola modul moderation: berkas yang dirujuk bukti laporan untuk pengurus moderation.read.
    t.app
      .get(FilesService)
      .registerAccessPolicy(
        "chat_image",
        ({ file, viewer }) =>
          viewer.audience === "admin" && viewer.permissions.has("moderation.read") && file.id === image.id,
      );
    expect((await api(t).get(`/files/${image.id}/access`, { token: moderatorToken })).statusCode).toBe(200);
    expect((await api(t).get(`/files/${image.id}/access`, { token: b.token })).statusCode).toBe(200);
  });
});
