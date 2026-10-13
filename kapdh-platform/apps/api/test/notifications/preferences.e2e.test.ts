import { notificationPreferences } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectOperation } from "../support/contract.js";
import { createAdmin, createAlumni, signInAdmin, signInAlumni } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

/** Preferensi push/email per kategori (F-13, AC F13-2; ARCHITECTURE §4.7). */

let t: TestApp;
const api = () => httpClient(t.app);

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

const ALL_ON = {
  push: { payment: true, membership: true, event: true, news: true, chat: true },
  email: { payment: true, membership: true, event: true },
};

async function member(status: "verified" | "suspended" | "expired" = "verified") {
  const fixture = await createAlumni(t, { status });
  const session = await signInAlumni(t, fixture);
  return { ...fixture, token: session.accessToken };
}

describe("GET/PUT /notifications/preferences", () => {
  it("AC F13-2: tanpa baris = semua aktif; security/account wajib; updated_at null sebelum diubah", async () => {
    const m = await member();
    const res = await api().get("/notifications/preferences", { token: m.token });
    expect(res.statusCode).toBe(200);
    expect(expectOperation("get", "/notifications/preferences", res)).toEqual({
      ...ALL_ON,
      mandatory_categories: ["security", "account"],
      updated_at: null,
    });
  });

  it.each(["verified", "suspended", "expired"] as const)(
    "AC F13-2: anggota %s mengganti seluruh preferensi; nilai tersimpan per kategori/kanal dan dibaca ulang",
    async (status) => {
      const m = await member(status);
      const next = {
        push: { ...ALL_ON.push, news: false, chat: false },
        email: { ...ALL_ON.email, payment: false },
      };
      const res = await api().put("/notifications/preferences", next, { token: m.token });
      expect(res.statusCode).toBe(200);
      const body = expectOperation("put", "/notifications/preferences", res) as Record<string, unknown>;
      expect(body).toEqual({
        ...next,
        mandatory_categories: ["security", "account"],
        updated_at: t.clock.now().toISOString(),
      });
      const again = await api().get("/notifications/preferences", { token: m.token });
      expect(again.json()).toEqual(body);
      const rows = await t.db
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, m.userId));
      expect(rows).toHaveLength(8);
      // Mengaktifkan kembali: nilai baru menggantikan yang lama (penggantian penuh).
      t.clock.advance(60_000);
      const restored = await api().put("/notifications/preferences", ALL_ON, { token: m.token });
      expect(restored.json()).toMatchObject({ ...ALL_ON, updated_at: t.clock.now().toISOString() });
    },
  );

  it("PUT bersamaan: hasil akhir tidak campuran (salah satu penggantian penuh menang)", async () => {
    const m = await member();
    const off = {
      push: { payment: false, membership: false, event: false, news: false, chat: false },
      email: { payment: false, membership: false, event: false },
    };
    await Promise.all([
      api().put("/notifications/preferences", ALL_ON, { token: m.token }),
      api().put("/notifications/preferences", off, { token: m.token }),
    ]);
    const final = (await api().get("/notifications/preferences", { token: m.token })).json() as typeof ALL_ON;
    const values = [...Object.values(final.push), ...Object.values(final.email)];
    expect(new Set(values).size).toBe(1);
  });

  it("validasi: saklar wajib lengkap, boolean, tanpa kategori wajib/asing → 400", async () => {
    const m = await member();
    for (const body of [
      {},
      { push: ALL_ON.push },
      { push: { ...ALL_ON.push, chat: undefined }, email: ALL_ON.email },
      { push: { ...ALL_ON.push, news: "ya" }, email: ALL_ON.email },
      { push: { ...ALL_ON.push, security: false }, email: ALL_ON.email },
      { push: ALL_ON.push, email: { ...ALL_ON.email, news: false } },
      { ...ALL_ON, mandatory_categories: [] },
    ]) {
      const res = await api().put("/notifications/preferences", body, { token: m.token });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(expectOperation("put", "/notifications/preferences", res)).toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }
  });

  it("otorisasi: tanpa sesi 401; token admin 403", async () => {
    for (const [method, call] of [
      ["get", () => api().get("/notifications/preferences")],
      ["put", () => api().put("/notifications/preferences", ALL_ON)],
    ] as const) {
      const res = await call();
      expect(res.statusCode).toBe(401);
      expectOperation(method, "/notifications/preferences", res);
    }
    const admin = await createAdmin(t, { role: "super_admin" });
    const session = await signInAdmin(t, admin);
    const get = await api().get("/notifications/preferences", { token: session.accessToken });
    expect(get.statusCode).toBe(403);
    expectOperation("get", "/notifications/preferences", get);
    const put = await api().put("/notifications/preferences", ALL_ON, { token: session.accessToken });
    expect(put.statusCode).toBe(403);
    expectOperation("put", "/notifications/preferences", put);
  });
});
