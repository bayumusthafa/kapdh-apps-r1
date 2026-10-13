import { files } from "@kapdh/database";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTx } from "../../src/core/db/tx.js";
import { FilesService } from "../../src/core/files/files.service.js";
import { expectOperation } from "../support/contract.js";
import { multipartBody, testJpeg, testPngBomb } from "../support/files.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { adminSession, memberSession, postContentMedia } from "./support.js";

/**
 * POST /admin/content/media (N-10, PRD 2.5, 3.8): unggah cover berita dan gambar banner oleh pengurus content.manage;
 * gambar diperiksa dan diproses server, bervisibilitas publik, kuota per purpose, kebijakan akses content.manage.
 */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

describe("N-10: unggah gambar konten", () => {
  it("N-10: post_cover dan banner_image diterima, EXIF dibuang, publik dan dapat dibuka lewat URL publik", async () => {
    const admin = await adminSession(t, ["content.manage"]);
    for (const purpose of ["post_cover", "banner_image"] as const) {
      const res = await postContentMedia(t, admin.token, purpose, {
        data: await testJpeg({ width: 120, height: 60, withPrivateExif: true }),
      });
      expect(res.statusCode, res.body).toBe(201);
      const media = expectOperation("post", "/admin/content/media", res) as {
        file_id: string;
        url: string;
        purpose: string;
        width: number;
        height: number;
        mime: string;
      };
      expect(media).toMatchObject({ purpose, width: 120, height: 60, mime: "image/jpeg" });
      expect(media.url).toBe(`${t.env.API_PUBLIC_URL}/api/v1/files/public/${media.file_id}`);
      const [row] = await t.db.select().from(files).where(eq(files.id, media.file_id));
      expect(row).toMatchObject({ visibility: "public", status: "ready", ownerUserId: admin.userId, attachedAt: null });
      const served = await t.app.inject({ method: "GET", url: `/api/v1/files/public/${media.file_id}` });
      expect(served.statusCode).toBe(200);
      const metadata = await sharp(served.rawPayload).metadata();
      expect(metadata.exif).toBeUndefined();
    }
  });

  it("PRD 2.5: purpose selain gambar konten, tanpa purpose/berkas, berkas bukan gambar dan bom dekompresi ditolak", async () => {
    const admin = await adminSession(t, ["content.manage"]);
    const avatar = await postContentMedia(t, admin.token, "avatar");
    expect(avatar.statusCode).toBe(400);
    expect(avatar.json().field_errors.purpose).toBeDefined();
    expectOperation("post", "/admin/content/media", avatar);
    const eventCover = await postContentMedia(t, admin.token, "event_cover");
    expect(eventCover.statusCode).toBe(400);

    const text = await postContentMedia(t, admin.token, "post_cover", {
      data: Buffer.from("bukan gambar"),
      filename: "x.jpg",
    });
    expect([415, 422]).toContain(text.statusCode);
    expect(text.json().code).toBe("FILE_INVALID");
    expectOperation("post", "/admin/content/media", text);
    const bomb = await postContentMedia(t, admin.token, "post_cover", {
      data: testPngBomb(),
      filename: "bom.png",
      contentType: "image/png",
    });
    expect(bomb.statusCode).toBe(422);

    const onlyPurpose = multipartBody([{ name: "purpose", value: "post_cover" }]);
    const noFile = await t.app.inject({
      method: "POST",
      url: "/api/v1/admin/content/media",
      payload: onlyPurpose.payload,
      headers: { ...onlyPurpose.headers, authorization: `Bearer ${admin.token}` },
    });
    expect(noFile.statusCode).toBe(400);
    expect(noFile.json().field_errors.file).toBeDefined();

    const json = await httpClient(t.app).post("/admin/content/media", { purpose: "post_cover" }, { token: admin.token });
    expect(json.statusCode).toBe(415);
    expectOperation("post", "/admin/content/media", json);
  });

  it("N-10: maksimal 10 unggahan berhasil per purpose per admin per 24 jam -> 429", async () => {
    const admin = await adminSession(t, ["content.manage"]);
    for (let i = 0; i < 10; i++) expect((await postContentMedia(t, admin.token, "banner_image")).statusCode).toBe(201);
    const limited = await postContentMedia(t, admin.token, "banner_image");
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe("RATE_LIMITED");
    expectOperation("post", "/admin/content/media", limited);
    expect((await postContentMedia(t, admin.token, "post_cover")).statusCode).toBe(201);
  });

  it("PRD 2.3: kebijakan akses berkas konten privat = pengurus content.manage (anggota/pengurus lain 404)", async () => {
    const admin = await adminSession(t, ["content.manage"]);
    const res = await postContentMedia(t, admin.token, "post_cover");
    const fileId = res.json().file_id as string;
    const service = t.app.get(FilesService);
    await withTx(t.db, (tx) => service.setVisibility(tx, fileId, "private"));
    const api = httpClient(t.app);
    const other = await adminSession(t, ["content.manage"]);
    const granted = await api.get(`/files/${fileId}/access`, { token: other.token });
    expect(granted.statusCode).toBe(200);
    expect(granted.json().url).toContain("/api/v1/files/content/");
    const finance = await adminSession(t, ["payments.read"]);
    expect((await api.get(`/files/${fileId}/access`, { token: finance.token })).statusCode).toBe(404);
    const member = await memberSession(t);
    expect((await api.get(`/files/${fileId}/access`, { token: member.token })).statusCode).toBe(404);
  });
});
