import type { Permission } from "@kapdh/contracts";
import { adminPermissions, admins, alumni, files } from "@kapdh/database";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeAudit } from "../../src/core/audit/write-audit.js";
import { withTx } from "../../src/core/db/tx.js";
import { FilePolicies } from "../../src/core/files/access-policy.js";
import { FILE_URL_MAX_TTL_SECONDS } from "../../src/core/files/file-token.js";
import { FilesService } from "../../src/core/files/files.service.js";
import { GENERAL_UPLOAD_PURPOSES } from "../../src/core/files/purposes.js";
import { etagMatches } from "../../src/modules/files/files.controller.js";
import { ajv, expectOperation } from "../support/contract.js";
import {
  type AlumniFixtureStatus,
  createAdmin,
  createAlumni,
  signInAdmin,
  signInAlumni,
} from "../support/factories.js";
import {
  multipartBody,
  postFile,
  testJpeg,
  testPdf,
  testPng,
  testPngBomb,
  uploadDomainFile,
  uploadTestFile,
} from "../support/files.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

let t: TestApp;
let service: FilesService;

beforeAll(async () => {
  t = await createTestApp();
  service = t.app.get(FilesService);
});
afterAll(async () => {
  await t.app.close();
});

async function member(status: AlumniFixtureStatus = "verified") {
  const fixture = await createAlumni(t, { status });
  const session = await signInAlumni(t, fixture);
  return { ...fixture, token: session.accessToken };
}

async function admin(permissions: Permission[]) {
  const fixture = await createAdmin(t, { permissions });
  const session = await signInAdmin(t, fixture);
  return { ...fixture, permissions, token: session.accessToken };
}

/** Path relatif /api/v1/... dari URL absolut yang dikembalikan API (API_PUBLIC_URL uji = http://api.test). */
function pathOf(url: string): string {
  expect(url.startsWith(`${t.env.API_PUBLIC_URL}/api/v1/`), url).toBe(true);
  return url.slice(t.env.API_PUBLIC_URL.length);
}

async function fileRow(id: string) {
  const [row] = await t.db.select().from(files).where(eq(files.id, id));
  return row!;
}

describe("POST /files (PRD 2.5, N-10)", () => {
  it("N-10: gambar diterima, tipe dari magic bytes, diputar sesuai orientasi, EXIF dibuang, object key tanpa PII", async () => {
    const owner = await member();
    const original = await testJpeg({ width: 64, height: 32, orientation: 6, withPrivateExif: true });
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const res = await postFile(t.app, owner.token, "avatar", {
      data: original,
      filename: "budi-santoso.jpeg",
    });
    const body = expectOperation("post", "/files", res) as Record<string, unknown>;
    expect(body).toMatchObject({
      purpose: "avatar",
      mime: "image/jpeg",
      visibility: "private",
      public_url: null,
    });
    // Orientasi 6 diterapkan ke piksel: 64x32 menjadi 32x64.
    expect(body).toMatchObject({ width: 32, height: 64 });
    expect(JSON.stringify(body)).not.toContain("budi");

    const row = await fileRow(body.id as string);
    expect(row).toMatchObject({
      status: "ready",
      ownerUserId: owner.userId,
      storageDriver: "local",
      attachedAt: null,
    });
    expect(row.objectKey).toMatch(/^avatar\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
    expect(row.objectKey).not.toContain("budi");
    const stored = t.storage.contents(row.objectKey)!;
    expect(stored.byteLength).toBe(row.bytes);
    const meta = await sharp(stored).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(stored.toString("latin1")).not.toContain("Data pribadi uji");
  });

  it("PRD 2.5: PDF hanya untuk payment_proof; PDF berskrip ditolak; ekstensi/Content-Type penyamar ditolak", async () => {
    const owner = await member("unverified");
    const pdf = await postFile(t.app, owner.token, "payment_proof", {
      data: testPdf(),
      filename: "bukti.pdf",
      contentType: "application/pdf",
    });
    expect(expectOperation("post", "/files", pdf)).toMatchObject({ mime: "application/pdf", width: null });

    const pdfAvatar = await postFile(t.app, owner.token, "avatar", {
      data: testPdf(),
      filename: "foto.pdf",
      contentType: "application/pdf",
    });
    expect(pdfAvatar.statusCode).toBe(415);
    expect(expectOperation("post", "/files", pdfAvatar)).toMatchObject({ code: "FILE_INVALID" });

    const active = await postFile(t.app, owner.token, "payment_proof", {
      data: testPdf({ active: true }),
      filename: "bukti.pdf",
      contentType: "application/pdf",
    });
    expect(active.statusCode).toBe(422);
    expect(active.json().code).toBe("FILE_INVALID");
    // Skrip yang disembunyikan di object stream terkompresi dan stream "bom" ikut ditolak; stream biasa diterima.
    for (const variant of [{ hiddenActive: true }, { inflateBomb: true }]) {
      const res = await postFile(t.app, owner.token, "payment_proof", {
        data: testPdf(variant),
        filename: "bukti.pdf",
        contentType: "application/pdf",
      });
      expect(res.statusCode, JSON.stringify(variant)).toBe(422);
    }
    const compressed = await postFile(t.app, owner.token, "payment_proof", {
      data: testPdf({ compressedContent: true }),
      filename: "bukti.pdf",
      contentType: "application/pdf",
    });
    expect(compressed.statusCode).toBe(201);

    const png = await testPng();
    const wrongExtension = await postFile(t.app, owner.token, "payment_proof", {
      data: png,
      filename: "bukti.jpg",
      contentType: "application/octet-stream",
    });
    expect(wrongExtension.statusCode).toBe(415);
    const wrongType = await postFile(t.app, owner.token, "payment_proof", {
      data: png,
      filename: "bukti",
      contentType: "image/jpeg",
    });
    expect(wrongType.statusCode).toBe(415);
    const script = await postFile(t.app, owner.token, "payment_proof", {
      data: Buffer.from("<script>alert(1)</script>"),
      filename: "bukti.png",
      contentType: "image/png",
    });
    expect(script.statusCode).toBe(415);
  });

  it("PRD 2.5: decompression bomb dan gambar rusak ditolak 422 sebelum dekode", async () => {
    const owner = await member();
    const bomb = await postFile(t.app, owner.token, "avatar", {
      data: testPngBomb(),
      filename: "bom.png",
      contentType: "image/png",
    });
    expect(bomb.statusCode).toBe(422);
    expect(expectOperation("post", "/files", bomb)).toMatchObject({ code: "FILE_INVALID" });

    const jpeg = await testJpeg();
    const broken = await postFile(t.app, owner.token, "avatar", { data: jpeg.subarray(0, 200) });
    expect(broken.statusCode).toBe(422);
  });

  it("N-10: batas ukuran per purpose (gambar 5 MB, PDF 10 MB) → 413 FILE_INVALID", async () => {
    const owner = await member();
    const png = await testPng();
    const big = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]);
    const avatar = await postFile(t.app, owner.token, "avatar", {
      data: big,
      filename: "a.png",
      contentType: "image/png",
    });
    expect(avatar.statusCode).toBe(413);
    expect(expectOperation("post", "/files", avatar)).toMatchObject({ code: "FILE_INVALID" });
    // payment_proof membaca sampai 10 MB, tetapi gambar tetap dibatasi 5 MB setelah tipe dideteksi.
    const proofImage = await postFile(t.app, owner.token, "payment_proof", {
      data: big,
      filename: "b.png",
      contentType: "image/png",
    });
    expect(proofImage.statusCode).toBe(413);
    expect(proofImage.json().message).toContain("5 MB");
    const huge = Buffer.concat([testPdf(), Buffer.alloc(10 * 1024 * 1024)]);
    const proofPdf = await postFile(t.app, owner.token, "payment_proof", {
      data: huge,
      filename: "b.pdf",
      contentType: "application/pdf",
    });
    expect(proofPdf.statusCode).toBe(413);
  });

  it("N-10: maksimal 10 unggahan berhasil per purpose per 24 jam bergulir (Clock), purpose lain terpisah", async () => {
    const owner = await member();
    const image = await testJpeg();
    for (let i = 0; i < 10; i++) {
      t.clock.advance(60_000);
      await uploadTestFile(t, owner.token, "avatar", { data: image });
    }
    const limited = await postFile(t.app, owner.token, "avatar", { data: image });
    expect(limited.statusCode).toBe(429);
    const body = expectOperation("post", "/files", limited) as { code: string; retry_after_seconds: number };
    expect(body.code).toBe("RATE_LIMITED");
    // Unggahan tertua 9 menit lalu → tersedia lagi tepat 24 jam setelahnya.
    expect(body.retry_after_seconds).toBe(24 * 3600 - 540);
    expect(limited.headers["retry-after"]).toBe(String(body.retry_after_seconds));
    await uploadTestFile(t, owner.token, "payment_proof", { data: image });
    t.clock.advance(body.retry_after_seconds * 1000);
    // Access token 15 menit sudah habis; sesi baru, kuota dihitung dari waktu Clock.
    const later = await signInAlumni(t, owner);
    await uploadTestFile(t, later.accessToken, "avatar", { data: image });
  });

  it("unggahan yang gagal disimpan tercatat failed, 500 tanpa detail, dan tidak menghabiskan kuota", async () => {
    const owner = await member();
    t.storage.failNext("put");
    const res = await postFile(t.app, owner.token, "avatar");
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe("INTERNAL_ERROR");
    const rows = await t.db.select().from(files).where(eq(files.ownerUserId, owner.userId));
    expect(rows.map((r) => r.status)).toEqual(["failed"]);
  });

  it("PRD 2.3: hak unggah per purpose dan audience; status anggota diperiksa", async () => {
    const verified = await member();
    const unverified = await member("unverified");
    const suspended = await member("suspended");
    const content = await admin(["content.manage"]);
    const finance = await admin(["payments.read"]);

    const treasurer = await admin(["payments.read", "payments.decide"]);

    // Gambar publik konten bukan purpose unggahan umum (kontrak C4/C5: endpoint domain) → 400 untuk siapa pun.
    for (const [who, purpose] of [
      [verified, "post_cover"],
      [content, "post_cover"],
      [content, "banner_image"],
      [await admin(["events.manage"]), "event_cover"],
    ] as const) {
      const res = await postFile(t.app, who.token, purpose);
      expect(res.statusCode, purpose).toBe(400);
      expect(expectOperation("post", "/files", res)).toMatchObject({
        code: "VALIDATION_ERROR",
        field_errors: { purpose: expect.any(Array) },
      });
    }
    const adminAvatar = await postFile(t.app, content.token, "avatar");
    expect(adminAvatar.statusCode).toBe(403);
    expect(expectOperation("post", "/files", adminAvatar)).toMatchObject({ code: "FORBIDDEN" });
    expect((await postFile(t.app, finance.token, "adjustment_evidence")).statusCode).toBe(403);
    expect((await postFile(t.app, verified.token, "adjustment_evidence")).statusCode).toBe(403);
    // D13 (adminRecordPayment): bukti verifikasi diunggah pengurus payments.decide; payments.read saja → 403.
    expect((await postFile(t.app, finance.token, "payment_proof")).statusCode).toBe(403);
    const adminProof = await postFile(t.app, treasurer.token, "payment_proof");
    expect(adminProof.statusCode).toBe(201);
    expect(expectOperation("post", "/files", adminProof)).toMatchObject({
      purpose: "payment_proof",
      visibility: "private",
    });
    expect((await fileRow(adminProof.json().id)).ownerUserId).toBe(treasurer.userId);
    expect((await postFile(t.app, treasurer.token, "adjustment_evidence")).statusCode).toBe(201);

    // chat_image hanya verified/expiring (PRD 2.2).
    const chat = await postFile(t.app, unverified.token, "chat_image");
    expect(chat.statusCode).toBe(403);
    expect(chat.json().code).toBe("MEMBERSHIP_REQUIRED");
    expect((await postFile(t.app, verified.token, "chat_image")).statusCode).toBe(201);
    const restricted = await postFile(t.app, suspended.token, "avatar");
    expect(restricted.statusCode).toBe(403);
    expect(restricted.json().code).toBe("ACCOUNT_SUSPENDED");

    expect((await postFile(t.app, null, "avatar")).statusCode).toBe(401);
    // Endpoint domain (FilesService) tetap memeriksa izin area: content.manage untuk post_cover.
    const cover = await uploadDomainFile(t, content, "post_cover");
    expect(cover.visibility).toBe("public");
    await expect(uploadDomainFile(t, finance, "post_cover")).rejects.toMatchObject({ status: 403 });
  });

  it("kontrak FileUploadPurpose = purpose unggahan umum server (GENERAL_UPLOAD_PURPOSES)", () => {
    const schema = ajv.getSchema("kapdh#/components/schemas/FileUploadPurpose")!.schema as { enum: string[] };
    expect([...schema.enum].sort()).toEqual([...GENERAL_UPLOAD_PURPOSES].sort());
  });

  it("validasi: purpose wajib, sah, bukan buatan sistem, dikirim sebelum berkas; satu berkas; bukan JSON", async () => {
    const owner = await member();
    const image = await testJpeg();
    const send = (parts: Parameters<typeof multipartBody>[0]) => {
      const body = multipartBody(parts);
      return t.app.inject({
        method: "POST",
        url: "/api/v1/files",
        payload: body.payload,
        headers: { ...body.headers, authorization: `Bearer ${owner.token}` },
      });
    };
    const file = { name: "file", filename: "a.jpg", contentType: "image/jpeg", data: image };

    const missingPurpose = await send([file]);
    expect(missingPurpose.statusCode).toBe(400);
    expect(expectOperation("post", "/files", missingPurpose)).toMatchObject({
      code: "VALIDATION_ERROR",
      field_errors: { purpose: expect.any(Array) },
    });
    for (const purpose of ["dokumen", "audit_export", ""]) {
      const res = await send([{ name: "purpose", value: purpose }, file]);
      expect(res.statusCode, purpose).toBe(400);
      expect(res.json().field_errors.purpose).toBeDefined();
    }
    const missingFile = await send([{ name: "purpose", value: "avatar" }]);
    expect(missingFile.statusCode).toBe(400);
    expect(missingFile.json().field_errors.file).toBeDefined();
    const twoFiles = await send([{ name: "purpose", value: "avatar" }, file, file]);
    expect(twoFiles.statusCode).toBe(413);
    expect(twoFiles.json().code).toBe("FILE_INVALID");

    const json = await httpClient(t.app).post("/files", { purpose: "avatar" }, { token: owner.token });
    expect(json.statusCode).toBe(415);
    expect(json.json().code).toBe("FILE_INVALID");
  });
});

describe("GET /files/{fileId}/access dan /files/content/{token} (PRD 5.4)", () => {
  it("pemilik mendapat URL <= 10 menit; isi dilayani private no-store; pihak lain 404 (N-09)", async () => {
    const owner = await member();
    const other = await member();
    const ref = await uploadTestFile(t, owner.token, "avatar");
    const api = httpClient(t.app);

    const res = await api.get(`/files/${ref.id}/access`, { token: owner.token });
    const access = expectOperation("get", "/files/{fileId}/access", res) as {
      url: string;
      expires_at: string;
      mime: string;
    };
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(access.mime).toBe("image/jpeg");
    expect(access.url).toContain("/api/v1/files/content/");
    expect(new Date(access.expires_at).getTime() - t.clock.now().getTime()).toBeLessThanOrEqual(
      FILE_URL_MAX_TTL_SECONDS * 1000,
    );

    const content = await t.app.inject({ method: "GET", url: pathOf(access.url) });
    expectOperation("get", "/files/content/{token}", content);
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("image/jpeg");
    expect(content.headers["cache-control"]).toBe("private, no-store");
    expect(content.headers["content-disposition"]).toBe("inline");
    expect(content.headers["x-content-type-options"]).toBe("nosniff");
    expect(content.rawPayload.equals(t.storage.contents((await fileRow(ref.id)).objectKey)!)).toBe(true);

    const denied = await api.get(`/files/${ref.id}/access`, { token: other.token });
    expect(denied.statusCode).toBe(404);
    expectOperation("get", "/files/{fileId}/access", denied);
    expect((await api.get(`/files/bukan-uuid/access`, { token: owner.token })).statusCode).toBe(404);
    expect((await api.get(`/files/${ref.id}/access`)).statusCode).toBe(401);
  });

  it("PRD 2.3: pengurus berizin membuka bukti bayar; tanpa izin 404; PDF diunduh sebagai lampiran", async () => {
    const owner = await member("unverified");
    const reader = await admin(["payments.read"]);
    const outsider = await admin(["content.manage"]);
    const ref = await uploadTestFile(t, owner.token, "payment_proof", {
      data: testPdf(),
      filename: "bukti.pdf",
      contentType: "application/pdf",
    });
    const api = httpClient(t.app);
    expect((await api.get(`/files/${ref.id}/access`, { token: outsider.token })).statusCode).toBe(404);
    const res = await api.get(`/files/${ref.id}/access`, { token: reader.token });
    const { url } = expectOperation("get", "/files/{fileId}/access", res) as { url: string };
    const content = await t.app.inject({ method: "GET", url: pathOf(url) });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("application/pdf");
    expect(content.headers["content-disposition"]).toBe(`attachment; filename="payment_proof-${ref.id}.pdf"`);
    expect(content.headers["content-security-policy"]).toContain("sandbox");
  });

  it("PRD 5.4: token diubah, kedaluwarsa, sesi logout, atau logout semua perangkat → 404", async () => {
    const owner = await member();
    const ref = await uploadTestFile(t, owner.token, "avatar");
    const api = httpClient(t.app);
    const urlFor = async (token: string) =>
      pathOf(((await api.get(`/files/${ref.id}/access`, { token })).json() as { url: string }).url);

    const url = await urlFor(owner.token);
    const tampered = url.slice(0, -3) + (url.endsWith("AAA") ? "BBB" : "AAA");
    const bad = await t.app.inject({ method: "GET", url: tampered });
    expect(bad.statusCode).toBe(404);
    expectOperation("get", "/files/content/{token}", bad);
    expect(
      (await t.app.inject({ method: "GET", url: "/api/v1/files/content/bukan.token.sah" })).statusCode,
    ).toBe(404);

    t.clock.advance(FILE_URL_MAX_TTL_SECONDS * 1000 + 1000);
    expect((await t.app.inject({ method: "GET", url })).statusCode).toBe(404);

    // Rotasi refresh (AC F02-3) bukan pencabutan: URL keluarga sesi yang sama tetap berlaku sampai TTL.
    const second = await signInAlumni(t, owner);
    const sessionUrl = await urlFor(second.accessToken);
    expect((await t.app.inject({ method: "GET", url: sessionUrl })).statusCode).toBe(200);
    const rotated = await api.post("/auth/refresh", { refresh_token: second.refreshToken });
    expect(rotated.statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: sessionUrl })).statusCode).toBe(200);
    // Logout (dengan token hasil rotasi) mencabut keluarga sesi dan mematikan URL yang masih berlaku.
    const rotatedToken = (rotated.json() as { access_token: string }).access_token;
    expect((await api.post("/auth/logout", {}, { token: rotatedToken })).statusCode).toBe(204);
    expect((await t.app.inject({ method: "GET", url: sessionUrl })).statusCode).toBe(404);

    // Logout semua perangkat (session_version naik) mematikan URL sesi lain juga.
    const third = await signInAlumni(t, owner);
    const fourth = await signInAlumni(t, owner);
    const thirdUrl = await urlFor(third.accessToken);
    expect((await api.post("/auth/logout-all", {}, { token: fourth.accessToken })).statusCode).toBe(204);
    expect((await t.app.inject({ method: "GET", url: thirdUrl })).statusCode).toBe(404);
  });

  it("PRD 5.4: TTL tidak menggantikan otorisasi — izin dicabut, admin dinonaktifkan, atau anggota disuspend mematikan URL", async () => {
    const owner = await member("unverified");
    const ref = await uploadTestFile(t, owner.token, "payment_proof");
    const api = httpClient(t.app);
    const reader = await admin(["payments.read"]);
    const urlFor = async (token: string) =>
      pathOf(((await api.get(`/files/${ref.id}/access`, { token })).json() as { url: string }).url);

    const adminUrl = await urlFor(reader.token);
    expect((await t.app.inject({ method: "GET", url: adminUrl })).statusCode).toBe(200);
    await t.db.delete(adminPermissions).where(eq(adminPermissions.adminId, reader.adminId));
    expect((await t.app.inject({ method: "GET", url: adminUrl })).statusCode).toBe(404);

    const other = await admin(["payments.read"]);
    const otherUrl = await urlFor(other.token);
    await t.db
      .update(admins)
      .set({ status: "disabled", disabledAt: t.clock.now() })
      .where(eq(admins.id, other.adminId));
    expect((await t.app.inject({ method: "GET", url: otherUrl })).statusCode).toBe(404);

    const ownerUrl = await urlFor(owner.token);
    expect((await t.app.inject({ method: "GET", url: ownerUrl })).statusCode).toBe(200);
    await t.db.update(alumni).set({ suspendedAt: t.clock.now() }).where(eq(alumni.userId, owner.userId));
    expect((await t.app.inject({ method: "GET", url: ownerUrl })).statusCode).toBe(404);
  });

  it("modul dapat mendaftarkan kebijakan akses per purpose (mis. anggota room untuk chat_image)", async () => {
    const owner = await member();
    const friend = await member();
    const stranger = await member();
    const ref = await uploadTestFile(t, owner.token, "chat_image");
    service.registerAccessPolicy(
      "chat_image",
      FilePolicies.allOf(
        ({ viewer }) => viewer.userId === friend.userId,
        ({ file }) => file.id === ref.id,
      ),
    );
    const api = httpClient(t.app);
    expect((await api.get(`/files/${ref.id}/access`, { token: friend.token })).statusCode).toBe(200);
    expect((await api.get(`/files/${ref.id}/access`, { token: stranger.token })).statusCode).toBe(404);
  });
});

describe("GET /files/public/{fileId} (PRD 5.4)", () => {
  it("berkas publik dengan cache publik + ETag/304; berkas privat tidak pernah dilayani di sini", async () => {
    const editor = await admin(["content.manage"]);
    const cover = service.toFileRef(
      await uploadDomainFile(t, editor, "post_cover", {
        data: await testPng(),
        filename: "sampul.png",
        contentType: "image/png",
      }),
    );
    expect(cover.public_url).toBe(`${t.env.API_PUBLIC_URL}/api/v1/files/public/${cover.id}`);
    const res = await t.app.inject({ method: "GET", url: pathOf(cover.public_url!) });
    expectOperation("get", "/files/public/{fileId}", res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("public, max-age=86400");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    const etag = String(res.headers.etag);
    expect(etag).toBe(`"${(await fileRow(cover.id)).sha256}"`);

    const cached = await t.app.inject({
      method: "GET",
      url: pathOf(cover.public_url!),
      headers: { "if-none-match": `W/${etag}` },
    });
    expect(cached.statusCode).toBe(304);
    expectOperation("get", "/files/public/{fileId}", cached);
    expect(cached.body).toBe("");

    // Akses lewat endpoint access: URL publik tetap, tanpa kedaluwarsa.
    const access = await httpClient(t.app).get(`/files/${cover.id}/access`, { token: editor.token });
    expect(expectOperation("get", "/files/{fileId}/access", access)).toEqual({
      url: cover.public_url,
      expires_at: null,
      mime: "image/png",
    });

    const owner = await member();
    const avatar = await uploadTestFile(t, owner.token, "avatar");
    const hidden = await t.app.inject({ method: "GET", url: `/api/v1/files/public/${avatar.id}` });
    expect(hidden.statusCode).toBe(404);
    expectOperation("get", "/files/public/{fileId}", hidden);
    expect((await t.app.inject({ method: "GET", url: "/api/v1/files/public/xyz" })).statusCode).toBe(404);
  });

  it("PRD 5.4: avatar dapat dijadikan publik sesuai kebijakan visibilitas; bukti bayar tidak pernah publik", async () => {
    const owner = await member();
    const avatar = await uploadTestFile(t, owner.token, "avatar");
    await service.setVisibility(t.db, avatar.id, "public");
    expect((await t.app.inject({ method: "GET", url: `/api/v1/files/public/${avatar.id}` })).statusCode).toBe(
      200,
    );
    await service.setVisibility(t.db, avatar.id, "private");
    expect((await t.app.inject({ method: "GET", url: `/api/v1/files/public/${avatar.id}` })).statusCode).toBe(
      404,
    );

    const proof = await uploadTestFile(t, owner.token, "payment_proof");
    await expect(service.setVisibility(t.db, proof.id, "public")).rejects.toThrow(/tidak boleh publik/);
  });

  it("etagMatches: daftar, wildcard, dan ETag lemah", () => {
    expect(etagMatches('"a", "b"', '"b"')).toBe(true);
    expect(etagMatches("*", '"b"')).toBe(true);
    expect(etagMatches('W/"b"', '"b"')).toBe(true);
    expect(etagMatches('"c"', '"b"')).toBe(false);
    expect(etagMatches(undefined, '"b"')).toBe(false);
  });
});

describe("FilesService.attach dan job files.cleanup-temp (PRD 2.5, ARCHITECTURE §4.8)", () => {
  it("attach hanya untuk pemilik, purpose sama, ready, dan sekali; berkas terlampir tidak dibersihkan", async () => {
    const owner = await member();
    const other = await member();
    const kept = await uploadTestFile(t, owner.token, "payment_proof");
    const temp = await uploadTestFile(t, owner.token, "payment_proof");

    await expect(
      withTx(t.db, (tx) => service.attach(tx, kept.id, other.userId, "payment_proof")),
    ).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      extra: { fieldErrors: { file_id: expect.any(Array) } },
    });
    await expect(
      withTx(t.db, (tx) => service.attach(tx, kept.id, owner.userId, "avatar", { field: "proof_file_id" })),
    ).rejects.toMatchObject({ extra: { fieldErrors: { proof_file_id: expect.any(Array) } } });
    const attached = await withTx(t.db, (tx) => service.attach(tx, kept.id, owner.userId, "payment_proof"));
    expect(attached.attachedAt).toEqual(t.clock.now());
    await expect(
      withTx(t.db, (tx) => service.attach(tx, kept.id, owner.userId, "payment_proof")),
    ).rejects.toMatchObject({ status: 400 });

    const tempKey = (await fileRow(temp.id)).objectKey;
    t.clock.advance(24 * 3600_000 - 60_000);
    await t.jobs.runScheduled("files.cleanup-temp");
    expect((await fileRow(temp.id)).status).toBe("ready");

    t.clock.advance(2 * 60_000);
    await t.jobs.runScheduled("files.cleanup-temp");
    const cleaned = await fileRow(temp.id);
    expect(cleaned).toMatchObject({ status: "deleted", deletedAt: t.clock.now() });
    expect(t.storage.contents(tempKey)).toBeUndefined();
    expect((await fileRow(kept.id)).status).toBe("ready");
    expect(t.storage.contents((await fileRow(kept.id)).objectKey)).toBeDefined();
    // Berkas terhapus tidak dapat dilampirkan maupun dibuka.
    await expect(
      withTx(t.db, (tx) => service.attach(tx, temp.id, owner.userId, "payment_proof")),
    ).rejects.toMatchObject({ status: 400 });
    const fresh = await signInAlumni(t, owner);
    expect(
      (await httpClient(t.app).get(`/files/${temp.id}/access`, { token: fresh.accessToken })).statusCode,
    ).toBe(404);
  });

  it("kegagalan hapus objek saat cleanup membuat job gagal (diulang) tanpa menandai baris deleted", async () => {
    const owner = await member();
    const temp = await uploadTestFile(t, owner.token, "avatar");
    t.clock.advance(25 * 3600_000);
    t.storage.failNext("delete", 1);
    await expect(t.jobs.runScheduled("files.cleanup-temp")).rejects.toThrow(/gagal dibersihkan/);
    expect((await fileRow(temp.id)).status).toBe("ready");
    await t.jobs.runScheduled("files.cleanup-temp");
    expect((await fileRow(temp.id)).status).toBe("deleted");
  });

  it("discard menandai deleted dalam transaksi dan menghapus objek hanya setelah commit", async () => {
    const owner = await member();
    const ref = await uploadTestFile(t, owner.token, "avatar");
    const key = (await fileRow(ref.id)).objectKey;
    await expect(
      withTx(t.db, async (tx) => {
        await service.discard(tx, ref.id);
        throw new Error("batal");
      }),
    ).rejects.toThrow("batal");
    expect(t.storage.contents(key)).toBeDefined();
    expect((await fileRow(ref.id)).status).toBe("ready");
    await withTx(t.db, (tx) => service.discard(tx, ref.id));
    expect((await fileRow(ref.id)).status).toBe("deleted");
    expect(t.storage.contents(key)).toBeUndefined();
  });

  it("kontrak C7: ekspor audit hanya untuk audit.read + audit.export yang juga pemohon atau Super Admin", async () => {
    const requester = await admin(["audit.read", "audit.export"]);
    const exportOnly = await admin(["audit.export"]);
    const colleague = await admin(["audit.read", "audit.export"]);
    const superAdmin = await createAdmin(t, { role: "super_admin" });
    const superToken = (await signInAdmin(t, superAdmin)).accessToken;
    const row = await service.storeGenerated({
      ownerUserId: requester.userId,
      purpose: "audit_export",
      mime: "text/csv",
      body: Buffer.from("waktu,aksi\n"),
      expiresAt: new Date(t.clock.now().getTime() + 3600_000),
    });
    // Berkas audit_export hanya dilayani bila tercatat pada entri `audit.export.completed` (ditulis worker dalam
    // transaksi yang sama dengan INSERT files; kontrak C7). Setiap akses lalu diaudit oleh kait akses modul admin.
    await writeAudit(t.db, {
      effectiveRole: "system",
      action: "audit.export.completed",
      entityType: "audit_export",
      entityId: uuidv7(),
      requestId: `uji-${row.id}`,
      after: { file_id: row.id, row_count: 0 },
    });
    const api = httpClient(t.app);
    const access = await api.get(`/files/${row.id}/access`, { token: requester.token });
    expect(access.statusCode).toBe(200);
    expect(expectOperation("get", "/files/{fileId}/access", access)).toMatchObject({ mime: "text/csv" });
    expect((await api.get(`/files/${row.id}/access`, { token: superToken })).statusCode).toBe(200);
    for (const other of [exportOnly, colleague])
      expect((await api.get(`/files/${row.id}/access`, { token: other.token })).statusCode).toBe(404);
    // Pemohon yang kehilangan audit.read tidak dapat lagi membuka ekspornya.
    await t.db.delete(adminPermissions).where(eq(adminPermissions.adminId, requester.adminId));
    await t.db
      .insert(adminPermissions)
      .values({ adminId: requester.adminId, permission: "audit.export", createdAt: t.clock.now() });
    expect((await api.get(`/files/${row.id}/access`, { token: requester.token })).statusCode).toBe(404);
  });

  it("storeGenerated: ekspor sistem privat, terlampir, kedaluwarsa dibersihkan job", async () => {
    const exporter = await createAdmin(t, { permissions: ["audit.export"] });
    const row = await service.storeGenerated({
      ownerUserId: exporter.userId,
      purpose: "audit_export",
      mime: "text/csv",
      body: Buffer.from("waktu,aksi\n"),
      expiresAt: new Date(t.clock.now().getTime() + 3600_000),
    });
    expect(row).toMatchObject({ status: "ready", visibility: "private" });
    expect(row.attachedAt).not.toBeNull();
    await expect(
      service.storeGenerated({
        ownerUserId: null,
        purpose: "avatar",
        mime: "image/png",
        body: Buffer.alloc(1),
      }),
    ).rejects.toThrow(/bukan berkas buatan sistem/);
    t.clock.advance(3600_000 + 1000);
    await t.jobs.runScheduled("files.cleanup-temp");
    expect((await fileRow(row.id)).status).toBe("deleted");
  });
});
