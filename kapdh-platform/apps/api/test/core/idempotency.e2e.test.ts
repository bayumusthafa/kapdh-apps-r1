import { idempotencyKeys } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IDEMPOTENCY_STALE_MS, IDEMPOTENCY_TTL_MS, IdempotencyService } from "../../src/core/idempotency/idempotency.service.js";
import { createAlumni, signInAlumni } from "../support/factories.js";
import { type HttpClient, httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { ProbeModule, probeState } from "./probe.js";

let t: TestApp;
let api: HttpClient;
let token: string;
let member: Awaited<ReturnType<typeof createAlumni>>;

beforeAll(async () => {
  t = await createTestApp({ extraModules: [ProbeModule] });
  api = httpClient(t.app);
  member = await createAlumni(t, { status: "verified" });
  token = (await signInAlumni(t, member)).accessToken;
});
beforeEach(() => {
  probeState.idempotentCalls = 0;
  probeState.failNext = false;
  probeState.delayMs = 0;
});
afterAll(async () => {
  await t.app.close();
});

const idem = (key: string, body: unknown, accessToken = token) =>
  api.post("/__probe/idem", body, { token: accessToken, headers: { "idempotency-key": key } });

describe("PRD 4.3: Idempotency-Key", () => {
  it("tanpa header, setiap permintaan diproses", async () => {
    await api.post("/__probe/idem", { a: 1 }, { token });
    await api.post("/__probe/idem", { a: 1 }, { token });
    expect(probeState.idempotentCalls).toBe(2);
  });

  it("key + payload sama memutar ulang status dan body pertama tanpa mengeksekusi ulang", async () => {
    const key = uuidv7();
    const first = await idem(key, { a: 1, b: [1, 2] });
    expect(first.statusCode).toBe(201);
    // Urutan field berbeda tetap dianggap payload yang sama (JSON kanonik).
    const second = await idem(key, { b: [1, 2], a: 1 });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(probeState.idempotentCalls).toBe(1);
    const [row] = await t.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    expect(row).toMatchObject({ status: "completed", responseStatus: 201, endpoint: "POST /api/v1/__probe/idem" });
  });

  it("key sama dengan payload berbeda → 409 IDEMPOTENCY_CONFLICT", async () => {
    const key = uuidv7();
    await idem(key, { a: 1 });
    const res = await idem(key, { a: 2 });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("IDEMPOTENCY_CONFLICT");
    expect(probeState.idempotentCalls).toBe(1);
  });

  it("scope per pengguna: key yang sama dari pengguna lain diproses terpisah", async () => {
    const key = uuidv7();
    const other = (await signInAlumni(t, await createAlumni(t, { status: "verified" }))).accessToken;
    const a = await idem(key, { a: 1 });
    const b = await idem(key, { a: 1 }, other);
    expect(a.json().user_id).not.toBe(b.json().user_id);
    expect(probeState.idempotentCalls).toBe(2);
  });

  it("permintaan sama yang masih diproses → 409 IDEMPOTENCY_CONFLICT dengan Retry-After", async () => {
    probeState.delayMs = 50;
    const key = uuidv7();
    const [a, b] = await Promise.all([idem(key, { a: 1 }), idem(key, { a: 1 })]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const conflict = a.statusCode === 409 ? a : b;
    expect(conflict.json().code).toBe("IDEMPOTENCY_CONFLICT");
    expect(conflict.headers["retry-after"]).toBe("2");
    expect(probeState.idempotentCalls).toBe(1);
  });

  it("galat melepas key sehingga percobaan ulang dengan key sama diproses", async () => {
    probeState.failNext = true;
    const key = uuidv7();
    expect((await idem(key, { a: 1 })).statusCode).toBe(422);
    expect(await t.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key))).toHaveLength(0);
    const retry = await idem(key, { a: 1 });
    expect(retry.statusCode).toBe(201);
    expect(probeState.idempotentCalls).toBe(2);
  });

  it("key kedaluwarsa setelah 24 jam diproses sebagai permintaan baru", async () => {
    const key = uuidv7();
    await idem(key, { a: 1 });
    t.clock.advance(IDEMPOTENCY_TTL_MS + 1000);
    // Access token 15 menit sudah habis; pengguna yang sama masuk ulang (scope sama).
    token = (await signInAlumni(t, member)).accessToken;
    const again = await idem(key, { a: 1 });
    expect(again.statusCode).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBeUndefined();
  });

  it("key in_progress terbengkalai (proses mati) dapat diambil alih setelah batas basi", async () => {
    const service = t.app.get(IdempotencyService);
    const key = uuidv7();
    const scope = { scope: "anon", endpoint: "POST /api/v1/__probe/idem-public", key, payloadHash: "x" };
    const first = await service.begin(scope);
    expect(first.kind).toBe("proceed");
    await expect(service.begin(scope)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    t.clock.advance(IDEMPOTENCY_STALE_MS + 1000);
    const takeover = await service.begin(scope);
    expect(takeover).toEqual(first);
  });

  it("endpoint publik memakai scope anon; format key bukan UUID → 400", async () => {
    const key = uuidv7();
    const a = await api.post("/__probe/idem-public", { x: 1 }, { headers: { "idempotency-key": key } });
    const b = await api.post("/__probe/idem-public", { x: 1 }, { headers: { "idempotency-key": key } });
    expect(b.json()).toEqual(a.json());
    const [row] = await t.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    expect(row!.scope).toBe("anon");
    const bad = await api.post("/__probe/idem-public", { x: 1 }, { headers: { "idempotency-key": "123" } });
    expect(bad.statusCode).toBe(400);
  });

  it("purgeExpired menghapus key kedaluwarsa (job maintenance.cleanup)", async () => {
    const key = uuidv7();
    await idem(key, { a: 1 });
    t.clock.advance(IDEMPOTENCY_TTL_MS + 1);
    expect(await t.app.get(IdempotencyService).purgeExpired()).toBeGreaterThan(0);
    expect(await t.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key))).toHaveLength(0);
  });
});
