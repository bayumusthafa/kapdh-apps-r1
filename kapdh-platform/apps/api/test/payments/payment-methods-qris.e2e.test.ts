import { auditLogs, files, paymentMethods } from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectOperation } from "../support/contract.js";
import { createPaymentMethod, setSetting } from "../support/factories.js";
import { multipartBody, postFile, testPdf, testPngBomb, uploadTestFile } from "../support/files.js";
import { httpClient } from "../support/http.js";
import type { TestApp } from "../support/test-app.js";
import { createEventRow, reserve } from "../events/support.js";
import {
  type AdminSession,
  adminSession,
  createInstruction,
  createPaymentsApp,
  type JsonBody,
  memberSession,
  mobileHeaders,
} from "./support.js";

/**
 * Metode bayar QRIS dengan gambar QR (ADR-026; kontrak adminUploadPaymentQrImage, adminCreatePaymentMethod,
 * adminUpdatePaymentMethod, adminDeletePaymentMethod, listPaymentMethods, PaymentMethod.qr_image_url). Gambar QRIS
 * statis organisasi diunggah pengurus settings.manage, publik, menjadi identitas metode (terkunci setelah dipakai
 * payment), ikut snapshot payment, dan tidak mengubah aturan D13.
 */

let t: TestApp;
let treasurer: AdminSession;
const api = () => httpClient(t.app);
const UPLOAD = "/admin/payment-qr-images";

beforeAll(async () => {
  t = await createPaymentsApp();
});
// Bendahara baru per uji: kuota N-10 (10 unggahan payment_qr per akun per 24 jam) dihitung per pengunggah.
beforeEach(async () => {
  treasurer = await adminSession(t, ["settings.manage"], { displayName: "Bendahara QRIS" });
});
afterAll(async () => {
  await t.app.close();
});

/** Gambar persegi berpola kotak (mirip modul QR) berukuran `size` piksel. */
async function qrImage(size = 1024, format: "png" | "jpeg" | "webp" = "png"): Promise<Buffer> {
  const cell = Math.max(1, Math.floor(size / 8));
  const squares = Array.from({ length: 16 }, (_, i) => ({
    input: { create: { width: cell, height: cell, channels: 3 as const, background: "#000000" } },
    left: ((i * 3) % 8) * cell,
    top: Math.floor(i / 2) * cell,
  }));
  const image = sharp({
    create: { width: size, height: size, channels: 3, background: "#ffffff" },
  }).composite(squares);
  return format === "png"
    ? image.png().toBuffer()
    : format === "jpeg"
      ? image.jpeg().toBuffer()
      : image.webp().toBuffer();
}

interface UploadPart {
  data?: Buffer;
  filename?: string;
  contentType?: string;
  field?: string;
}

/** POST /api/v1/admin/payment-qr-images multipart (field `file`). */
async function uploadRaw(token: string | null, part: UploadPart = {}) {
  const body = multipartBody([
    {
      name: part.field ?? "file",
      filename: part.filename ?? "qris.png",
      contentType: part.contentType ?? "image/png",
      data: part.data ?? (await qrImage()),
    },
  ]);
  return t.app.inject({
    method: "POST",
    url: `/api/v1${UPLOAD}`,
    payload: body.payload,
    headers: { ...body.headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
}

/** Unggah gambar QRIS yang wajib berhasil; mengembalikan AdminPaymentQrImage. */
async function uploadQr(token = treasurer.token, part: UploadPart = {}): Promise<JsonBody> {
  const res = await uploadRaw(token, part);
  expect(res.statusCode, res.body).toBe(201);
  return expectOperation("post", UPLOAD, res);
}

const qrisInput = (fileId: string | null | undefined, overrides: Record<string, unknown> = {}) => ({
  kind: "qris",
  provider: "QRIS",
  account_number: "ID1020304050607",
  account_holder: "KAPDH Pusat",
  instructions: "Masukkan nominal sesuai tagihan.",
  active: true,
  sort_order: 0,
  ...(fileId === undefined ? {} : { qr_image_file_id: fileId }),
  ...overrides,
});

async function createQris(fileId?: string, overrides: Record<string, unknown> = {}): Promise<JsonBody> {
  const image = fileId ?? (await uploadQr()).file_id;
  const res = await api().post("/admin/payment-methods", qrisInput(image, overrides), {
    token: treasurer.token,
  });
  expect(res.statusCode, res.body).toBe(201);
  return expectOperation("post", "/admin/payment-methods", res);
}

async function fileRow(id: string) {
  const [row] = await t.db.select().from(files).where(eq(files.id, id));
  return row!;
}

/** Path relatif /api/v1/... dari URL absolut API_PUBLIC_URL. */
function pathOf(url: string): string {
  expect(url.startsWith(`${t.env.API_PUBLIC_URL}/api/v1/`), url).toBe(true);
  return url.slice(t.env.API_PUBLIC_URL.length);
}

const fieldErrors = (res: { json: () => unknown }) =>
  (res.json() as { field_errors?: Record<string, string[]> }).field_errors ?? {};

describe("POST /admin/payment-qr-images (ADR-026, N-10)", () => {
  it("gambar QRIS PNG/JPG diproses: publik, ready, belum terlampir, milik pengunggah; gambar besar diperkecil", async () => {
    const png = await uploadQr();
    expect(png).toMatchObject({ mime: "image/png", width: 1024, height: 1024 });
    expect(png.url).toBe(`${t.env.API_PUBLIC_URL}/api/v1/files/public/${png.file_id}`);
    const row = await fileRow(png.file_id);
    expect(row).toMatchObject({
      purpose: "payment_qr",
      visibility: "public",
      status: "ready",
      attachedAt: null,
      ownerUserId: treasurer.userId,
      mime: "image/png",
    });
    expect(row.objectKey).toMatch(new RegExp(`^payment_qr/\\d{4}/\\d{2}/${png.file_id}$`));

    const jpeg = await uploadQr(treasurer.token, {
      data: await qrImage(600, "jpeg"),
      filename: "qris.jpg",
      contentType: "image/jpeg",
    });
    expect(jpeg).toMatchObject({ mime: "image/jpeg", width: 600, height: 600 });

    // Batas keluaran 2048 piksel tanpa pembesaran.
    const large = await uploadQr(treasurer.token, { data: await qrImage(3000) });
    expect(large).toMatchObject({ width: 2048, height: 2048 });
  });

  it("izin settings.manage wajib; tanpa token 401; sesi anggota 403", async () => {
    expect(expectOperation("post", UPLOAD, await uploadRaw(null))).toMatchObject({ code: "UNAUTHENTICATED" });
    const decider = await adminSession(t, ["payments.read", "payments.decide"]);
    const denied = await uploadRaw(decider.token);
    expect(denied.statusCode).toBe(403);
    expect(expectOperation("post", UPLOAD, denied)).toMatchObject({ code: "FORBIDDEN" });
    const member = await memberSession(t, "verified");
    const memberRes = await uploadRaw(member.token);
    expect(memberRes.statusCode).toBe(403);
    expectOperation("post", UPLOAD, memberRes);
  });

  it("WebP, SVG dan PDF ditolak 415; gambar kecil, rusak atau bom dekompresi 422; > 5 MB 413; penyamaran 415", async () => {
    const reject = async (part: UploadPart, status: number, message?: string | RegExp) => {
      const res = await uploadRaw(treasurer.token, part);
      expect(res.statusCode, res.body).toBe(status);
      const body = expectOperation("post", UPLOAD, res) as JsonBody;
      expect(body.code).toBe(status === 400 ? "VALIDATION_ERROR" : "FILE_INVALID");
      if (message) expect(body.message).toMatch(message);
      return body;
    };
    await reject(
      { data: await qrImage(800, "webp"), filename: "qris.webp", contentType: "image/webp" },
      415,
      "Gunakan gambar PNG atau JPG.",
    );
    await reject(
      {
        data: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800"/></svg>',
        ),
        filename: "qris.svg",
        contentType: "image/svg+xml",
      },
      415,
      "Gunakan gambar PNG atau JPG.",
    );
    await reject(
      { data: testPdf(), filename: "qris.pdf", contentType: "application/pdf" },
      415,
      "Gunakan gambar PNG atau JPG.",
    );
    await reject(
      { data: await qrImage(256) },
      422,
      "Gambar QRIS terlalu kecil (minimal 512 piksel) sehingga sulit dipindai.",
    );
    await reject({ data: testPngBomb() }, 422);
    const big = Buffer.concat([await qrImage(600), Buffer.alloc(5 * 1024 * 1024)]);
    await reject({ data: big }, 413, "Gambar terlalu besar. Maksimal 5 MB.");
    // PNG yang dinamai .jpg (atau Content-Type JPEG) = penyamaran.
    await reject({ filename: "qris.jpg", contentType: "image/png" }, 415, /Ekstensi/);
    await reject({ filename: "qris.png", contentType: "image/jpeg" }, 415, /Tipe berkas/);
    // Field selain `file` → 400 pada field file; body JSON → 415.
    const wrongField = await reject({ field: "gambar" }, 400);
    expect(wrongField.field_errors).toHaveProperty("file");
    const json = await api().post(UPLOAD, { file: "bukan-multipart" }, { token: treasurer.token });
    expect(json.statusCode).toBe(415);
    expectOperation("post", UPLOAD, json);
    // Tidak ada baris berkas yang tertinggal dari unggahan yang ditolak.
    const rows = await t.db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.ownerUserId, treasurer.userId), eq(files.status, "failed")));
    expect(rows).toEqual([]);
  });

  it("POST /files menolak purpose payment_qr (400 purpose) walau pemanggil settings.manage", async () => {
    const res = await postFile(t.app, treasurer.token, "payment_qr", { data: await qrImage(600) });
    expect(res.statusCode).toBe(400);
    expect(expectOperation("post", "/files", res)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { purpose: expect.any(Array) },
    });
  });
});

describe("Membuat metode QRIS (ADR-026)", () => {
  it("metode qris melampirkan gambar, audit mencatat id + sha256, replay Idempotency-Key tidak membuat metode kedua", async () => {
    const image = await uploadQr();
    const key = uuidv7();
    const first = await api().post("/admin/payment-methods", qrisInput(image.file_id), {
      token: treasurer.token,
      headers: { "idempotency-key": key },
    });
    expect(first.statusCode, first.body).toBe(201);
    const created = expectOperation("post", "/admin/payment-methods", first) as JsonBody;
    expect(created).toMatchObject({
      kind: "qris",
      provider: "QRIS",
      account_number: "ID1020304050607",
      account_holder: "KAPDH Pusat",
      qr_image_file_id: image.file_id,
      qr_image_url: image.url,
      in_use: false,
      version: "1",
    });
    const row = await fileRow(image.file_id);
    expect(row.attachedAt).not.toBeNull();
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, created.id), eq(auditLogs.action, "payment_method.created")));
    expect(audit!.after).toMatchObject({
      kind: "qris",
      qr_image_file_id: image.file_id,
      qr_image_sha256: row.sha256,
      account_suffix: "0607",
    });
    expect(JSON.stringify(audit!.after)).not.toContain("ID1020304050607");

    const replay = await api().post("/admin/payment-methods", qrisInput(image.file_id), {
      token: treasurer.token,
      headers: { "idempotency-key": key },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json()).toEqual(created);
    const same = await t.db
      .select({ id: paymentMethods.id })
      .from(paymentMethods)
      .where(eq(paymentMethods.qrImageFileId, image.file_id));
    expect(same).toHaveLength(1);
  });

  it("validasi: qris wajib bergambar, jenis lain tanpa gambar, berkas harus payment_qr milik pengunggah yang belum dipakai", async () => {
    const expectQrError = async (
      body: Record<string, unknown>,
      message: string | RegExp,
      token = treasurer.token,
    ) => {
      const res = await api().post("/admin/payment-methods", body, { token });
      expect(res.statusCode, res.body).toBe(400);
      expectOperation("post", "/admin/payment-methods", res);
      expect(fieldErrors(res).qr_image_file_id?.[0]).toMatch(message);
    };
    const before = (await t.db.select({ id: paymentMethods.id }).from(paymentMethods)).length;
    await expectQrError(qrisInput(undefined), "Gambar QRIS wajib diunggah.");
    await expectQrError(qrisInput(null), "Gambar QRIS wajib diunggah.");
    await expectQrError(qrisInput("bukan-uuid"), "Gambar QRIS tidak valid");
    const image = await uploadQr();
    await expectQrError(qrisInput(image.file_id, { kind: "bank" }), "Gambar QR hanya untuk metode QRIS.");
    await expectQrError(qrisInput(image.file_id, { kind: "ewallet" }), "Gambar QR hanya untuk metode QRIS.");
    // Berkas tidak ada, purpose lain, milik pengurus lain, atau sudah dipakai metode lain.
    await expectQrError(qrisInput(uuidv7()), /Berkas tidak ditemukan/);
    const decider = await adminSession(t, ["payments.read", "payments.decide"]);
    const evidence = await uploadTestFile(t, decider.token, "adjustment_evidence");
    const both = await adminSession(t, ["settings.manage", "payments.read", "payments.decide"]);
    const ownEvidence = await uploadTestFile(t, both.token, "adjustment_evidence");
    await expectQrError(qrisInput(ownEvidence.id), /berbeda jenis/, both.token);
    await expectQrError(qrisInput(evidence.id), /Berkas tidak ditemukan/);
    const colleague = await adminSession(t, ["settings.manage"]);
    await expectQrError(qrisInput(image.file_id), /Berkas tidak ditemukan/, colleague.token);
    await createQris(image.file_id);
    await expectQrError(qrisInput(image.file_id), /sudah dipakai/);
    // Hanya createQris yang berhasil.
    expect((await t.db.select({ id: paymentMethods.id }).from(paymentMethods)).length).toBe(before + 1);
  });
});

describe("Anggota dan snapshot payment (ADR-026, D13)", () => {
  it("GET /payment-methods memuat qr_image_url publik untuk qris (null untuk bank); URL dilayani cache publik + ETag", async () => {
    const qris = await createQris(undefined, { provider: "QRIS Anggota", sort_order: 1 });
    const bank = await createPaymentMethod(t, { provider: "Bank Anggota", sortOrder: 2 });
    const member = await memberSession(t);
    const list = await api().get("/payment-methods", { token: member.token });
    const body = expectOperation("get", "/payment-methods", list) as JsonBody;
    const items = body.items as { id: string; kind: string; qr_image_url?: string | null }[];
    expect(items.find((i) => i.id === qris.id)).toMatchObject({
      kind: "qris",
      qr_image_url: qris.qr_image_url,
    });
    expect(items.find((i) => i.id === bank.id)).toMatchObject({ kind: "bank", qr_image_url: null });
    // Tidak ada id berkas internal di respons anggota.
    expect(JSON.stringify(body)).not.toContain("qr_image_file_id");

    const image = await t.app.inject({ method: "GET", url: pathOf(qris.qr_image_url) });
    expectOperation("get", "/files/public/{fileId}", image);
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["cache-control"]).toBe("public, max-age=86400");
    expect(String(image.headers.etag)).toBe(`"${(await fileRow(qris.qr_image_file_id)).sha256}"`);
  });

  it("instruksi iuran menyimpan snapshot QR; ganti ke bank menghapus QR dari instruksi; pengurus melihat snapshot yang sama", async () => {
    const qris = await createQris();
    const member = await memberSession(t);
    const instruction = await createInstruction(t, member, "registration", qris.id);
    const detail = await api().get(`/me/payments/${instruction.paymentId}`, { token: member.token });
    const view = expectOperation("get", "/me/payments/{paymentId}", detail) as JsonBody;
    expect(view.method).toEqual({
      id: qris.id,
      kind: "qris",
      provider: "QRIS",
      account_number: "ID1020304050607",
      account_holder: "KAPDH Pusat",
      instructions: "Masukkan nominal sesuai tagihan.",
      qr_image_url: qris.qr_image_url,
    });
    expect(view.method_active).toBe(true);
    const finance = await adminSession(t, ["payments.read"]);
    const adminView = await api().get(`/admin/payments/${instruction.paymentId}`, { token: finance.token });
    expect(
      (expectOperation("get", "/admin/payments/{paymentId}", adminView) as JsonBody).method,
    ).toMatchObject({ kind: "qris", qr_image_url: qris.qr_image_url });

    const bank = await createPaymentMethod(t, { provider: "Bank Pengganti" });
    const changed = await api().put(
      `/me/payments/${instruction.paymentId}/method`,
      { payment_method_id: bank.id },
      { token: member.token, headers: { "if-match": instruction.version } },
    );
    const afterChange = expectOperation("put", "/me/payments/{paymentId}/method", changed) as JsonBody;
    expect(afterChange.method).toMatchObject({ id: bank.id, kind: "bank", qr_image_url: null });
    const back = await api().put(
      `/me/payments/${instruction.paymentId}/method`,
      { payment_method_id: qris.id },
      { token: member.token, headers: { "if-match": afterChange.version } },
    );
    expect(
      (expectOperation("put", "/me/payments/{paymentId}/method", back) as JsonBody).method,
    ).toMatchObject({
      id: qris.id,
      kind: "qris",
      qr_image_url: qris.qr_image_url,
    });
  });

  it("D13 tidak berubah: platform tersembunyi tetap menerima objek metode yang sama dan instructions_hidden true", async () => {
    const qris = await createQris();
    const member = await memberSession(t);
    const instruction = await createInstruction(t, member, "registration", qris.id);
    await setSetting(t, "payment_instructions", { dues_hidden_platforms: ["ios"] });
    try {
      const hidden = await api().get(`/me/payments/${instruction.paymentId}`, {
        token: member.token,
        headers: mobileHeaders("ios"),
      });
      expect(expectOperation("get", "/me/payments/{paymentId}", hidden)).toMatchObject({
        instructions_hidden: true,
        method: { kind: "qris", qr_image_url: qris.qr_image_url },
        actions: { can_submit_proof: false, can_change_method: false },
      });
      const android = await api().get(`/me/payments/${instruction.paymentId}`, {
        token: member.token,
        headers: mobileHeaders("android"),
      });
      expect(android.json()).toMatchObject({ instructions_hidden: false });
    } finally {
      await setSetting(t, "payment_instructions", { dues_hidden_platforms: [] });
    }
  });

  it("tiket event dengan metode qris: TicketPaymentMethod.kind qris, gambar dibuka dari instruksi pembayaran (tiket tidak pernah disembunyikan)", async () => {
    const qris = await createQris();
    const member = await memberSession(t, "verified");
    const event = await createEventRow(t, { price: "75000.00" });
    await setSetting(t, "payment_instructions", { dues_hidden_platforms: ["ios"] });
    try {
      const ticket = await reserve(t, member, { id: event.id, price: event.price }, qris.id);
      expect(ticket.payment.method).toEqual({
        kind: "qris",
        provider: "QRIS",
        account_number: "ID1020304050607",
        account_holder: "KAPDH Pusat",
        instructions: "Masukkan nominal sesuai tagihan.",
      });
      const mine = await api().get(`/me/tickets/${ticket.id}`, { token: member.token });
      expect(expectOperation("get", "/me/tickets/{ticketId}", mine)).toMatchObject({
        payment: { method: { kind: "qris" } },
      });
      const payment = await api().get(`/me/payments/${ticket.payment.id}`, {
        token: member.token,
        headers: mobileHeaders("ios"),
      });
      expect(expectOperation("get", "/me/payments/{paymentId}", payment)).toMatchObject({
        type: "ticket",
        instructions_hidden: false,
        method: { kind: "qris", qr_image_url: qris.qr_image_url },
      });
    } finally {
      await setSetting(t, "payment_instructions", { dues_hidden_platforms: [] });
    }
  });
});

describe("Mengubah dan menghapus metode QRIS (ADR-026, AC F15-3, F15-4)", () => {
  const put = (id: string, version: string, body: Record<string, unknown>) =>
    api().put(`/admin/payment-methods/${id}`, body, {
      token: treasurer.token,
      headers: { "if-match": version },
    });

  it("ganti gambar: berkas baru terlampir, berkas lama dibuang setelah commit; audit before/after sha256", async () => {
    const created = await createQris();
    const oldId = created.qr_image_file_id as string;
    const next = await uploadQr(treasurer.token, { data: await qrImage(800) });
    const res = await put(created.id, created.version, qrisInput(next.file_id));
    const updated = expectOperation("put", "/admin/payment-methods/{methodId}", res) as JsonBody;
    expect(updated).toMatchObject({ qr_image_file_id: next.file_id, qr_image_url: next.url, version: "2" });
    expect((await fileRow(next.file_id)).attachedAt).not.toBeNull();
    const old = await fileRow(oldId);
    expect(old.status).toBe("deleted");
    expect((await t.app.inject({ method: "GET", url: pathOf(created.qr_image_url) })).statusCode).toBe(404);
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, created.id), eq(auditLogs.action, "payment_method.updated")));
    expect(audit!.before).toMatchObject({ qr_image_file_id: oldId, qr_image_sha256: old.sha256 });
    expect(audit!.after).toMatchObject({
      qr_image_file_id: next.file_id,
      qr_image_sha256: (await fileRow(next.file_id)).sha256,
    });
  });

  it("tetap: tanpa qr_image_file_id atau dengan id yang sama gambar tidak berubah dan tidak dilampirkan ulang", async () => {
    const created = await createQris();
    const absent = await put(created.id, created.version, qrisInput(undefined, { instructions: "Baru" }));
    expect(expectOperation("put", "/admin/payment-methods/{methodId}", absent)).toMatchObject({
      instructions: "Baru",
      qr_image_file_id: created.qr_image_file_id,
      version: "2",
    });
    const same = await put(created.id, "2", qrisInput(created.qr_image_file_id, { sort_order: 5 }));
    expect(same.json()).toMatchObject({
      sort_order: 5,
      qr_image_file_id: created.qr_image_file_id,
      version: "3",
    });
    expect((await fileRow(created.qr_image_file_id)).status).toBe("ready");
  });

  it("ganti jenis: qris → bank wajib qr_image_file_id null (gambar dibuang); bank → qris wajib gambar baru", async () => {
    const created = await createQris();
    const keepImage = await put(created.id, created.version, qrisInput(undefined, { kind: "bank" }));
    expect(keepImage.statusCode).toBe(400);
    expect(fieldErrors(keepImage).qr_image_file_id).toEqual(["Gambar QR hanya untuk metode QRIS."]);
    const toBank = await put(
      created.id,
      created.version,
      qrisInput(null, { kind: "bank", provider: "Bank Syariah Indonesia", account_number: "7123456789" }),
    );
    expect(expectOperation("put", "/admin/payment-methods/{methodId}", toBank)).toMatchObject({
      kind: "bank",
      qr_image_file_id: null,
      qr_image_url: null,
      version: "2",
    });
    expect((await fileRow(created.qr_image_file_id)).status).toBe("deleted");

    const missing = await put(created.id, "2", qrisInput(undefined));
    expect(fieldErrors(missing).qr_image_file_id).toEqual(["Gambar QRIS wajib diunggah."]);
    const image = await uploadQr();
    const toQris = await put(created.id, "2", qrisInput(image.file_id));
    expect(toQris.json()).toMatchObject({ kind: "qris", qr_image_file_id: image.file_id, version: "3" });
  });

  it("If-Match usang → 409 VERSION_CONFLICT dengan current berisi gambar; berkas baru tidak dilampirkan", async () => {
    const created = await createQris();
    await put(created.id, created.version, qrisInput(undefined, { sort_order: 3 }));
    const next = await uploadQr();
    const stale = await put(created.id, created.version, qrisInput(next.file_id));
    expect(expectOperation("put", "/admin/payment-methods/{methodId}", stale)).toMatchObject({
      code: "VERSION_CONFLICT",
      current: { id: created.id, version: "2", qr_image_file_id: created.qr_image_file_id },
    });
    expect((await fileRow(next.file_id)).attachedAt).toBeNull();
  });

  it("metode in_use: gambar tidak dapat diganti atau dihapus; nonaktifkan tetap boleh; hapus ditolak", async () => {
    const created = await createQris();
    const member = await memberSession(t);
    await createInstruction(t, member, "registration", created.id);
    const viewed = (
      await api().get(`/admin/payment-methods/${created.id}`, { token: treasurer.token })
    ).json();
    expect(viewed.in_use).toBe(true);
    const locked =
      "Metode ini sudah dipakai pembayaran sehingga rekeningnya tidak dapat diubah. Nonaktifkan lalu buat metode baru.";

    const next = await uploadQr();
    const replace = await put(created.id, viewed.version, qrisInput(next.file_id));
    expect(expectOperation("put", "/admin/payment-methods/{methodId}", replace)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { qr_image_file_id: [locked] },
    });
    const toBank = await put(created.id, viewed.version, qrisInput(null, { kind: "bank" }));
    expect(Object.keys(fieldErrors(toBank)).sort()).toEqual(["kind", "qr_image_file_id"]);
    expect((await fileRow(next.file_id)).attachedAt).toBeNull();

    const deactivated = await put(created.id, viewed.version, qrisInput(undefined, { active: false }));
    expect(expectOperation("put", "/admin/payment-methods/{methodId}", deactivated)).toMatchObject({
      active: false,
      in_use: true,
      qr_image_file_id: created.qr_image_file_id,
    });
    const removed = await api().delete(`/admin/payment-methods/${created.id}`, {
      token: treasurer.token,
      headers: { "if-match": deactivated.json().version },
    });
    expect(removed.statusCode).toBe(400);
    expect((await fileRow(created.qr_image_file_id)).status).toBe("ready");
    // Snapshot instruksi tetap dapat menampilkan QR yang sama.
    expect((await t.app.inject({ method: "GET", url: pathOf(created.qr_image_url) })).statusCode).toBe(200);
  });

  it("hapus metode qris yang belum dipakai membuang gambarnya; audit before mencatat sha256", async () => {
    const created = await createQris();
    const sha256 = (await fileRow(created.qr_image_file_id)).sha256;
    const removed = await api().delete(`/admin/payment-methods/${created.id}`, {
      token: treasurer.token,
      headers: { "if-match": created.version },
    });
    expect(removed.statusCode, removed.body).toBe(204);
    expect((await fileRow(created.qr_image_file_id)).status).toBe("deleted");
    expect((await t.app.inject({ method: "GET", url: pathOf(created.qr_image_url) })).statusCode).toBe(404);
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, created.id), eq(auditLogs.action, "payment_method.deleted")));
    expect(audit!.before).toMatchObject({
      qr_image_file_id: created.qr_image_file_id,
      qr_image_sha256: sha256,
    });
  });
});
