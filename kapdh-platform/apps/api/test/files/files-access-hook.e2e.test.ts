/**
 * Kait akses berkas privat FilesService.registerAccessHook (core, ditambahkan slice api-admin untuk audit
 * `audit.export.downloaded` pada SETIAP akses ekspor audit, PRD 3.17 / AC F17-2): kait dijalankan hanya setelah
 * kebijakan akses mengizinkan dan sebelum URL bertanda tangan diterbitkan; galat kait menggagalkan akses (tanpa URL).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notFound } from "../../src/core/errors/app-exception.js";
import { type FileAccessHook, FilesService } from "../../src/core/files/files.service.js";
import { createAlumni, signInAlumni } from "../support/factories.js";
import { uploadTestFile } from "../support/files.js";
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

async function member() {
  const fixture = await createAlumni(t, { status: "verified" });
  const session = await signInAlumni(t, fixture);
  return { ...fixture, token: session.accessToken };
}

describe("FilesService.registerAccessHook (AC F17-2, PRD 3.17)", () => {
  it("AC F17-2: kait berjalan sekali per akses yang diizinkan, tidak untuk akses yang ditolak; galat kait = tanpa URL", async () => {
    const owner = await member();
    const stranger = await member();
    const ref = await uploadTestFile(t, owner.token, "chat_image");
    const calls: { fileId: string; userId: string }[] = [];
    let fail = false;
    const hook: FileAccessHook = async ({ file, viewer }) => {
      if (file.id !== ref.id) return;
      calls.push({ fileId: file.id, userId: viewer.userId });
      if (fail) throw notFound("Berkas tidak ditemukan.");
    };
    service.registerAccessHook("chat_image", hook);
    const api = httpClient(t.app);

    // Ditolak kebijakan (bukan pemilik): 404 dan kait tidak dijalankan.
    expect((await api.get(`/files/${ref.id}/access`, { token: stranger.token })).statusCode).toBe(404);
    expect(calls).toEqual([]);

    // Diizinkan: kait berjalan sebelum URL diterbitkan, sekali per akses.
    const granted = await api.get(`/files/${ref.id}/access`, { token: owner.token });
    expect(granted.statusCode).toBe(200);
    expect((granted.json() as { url: string }).url).toContain("/files/");
    expect(calls).toEqual([{ fileId: ref.id, userId: owner.userId }]);

    // Kait gagal: akses gagal, URL tidak diberikan.
    fail = true;
    const blocked = await api.get(`/files/${ref.id}/access`, { token: owner.token });
    expect(blocked.statusCode).toBe(404);
    expect(blocked.json()).not.toHaveProperty("url");
    expect(calls).toHaveLength(2);
  });

  it("purpose yang tidak dikenal ditolak saat pendaftaran", () => {
    expect(() => service.registerAccessHook("bukan_purpose" as never, async () => undefined)).toThrow(
      /Purpose tidak dikenal/,
    );
  });
});
