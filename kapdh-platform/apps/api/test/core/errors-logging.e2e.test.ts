import { Writable } from "node:stream";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAlumni, DEFAULT_PASSWORD } from "../support/factories.js";
import { type HttpClient, httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { ProbeModule, SECRET_MARKER } from "./probe.js";

/** Menampung baris log JSON aplikasi uji. */
class LogSink extends Writable {
  readonly lines: Record<string, unknown>[] = [];
  readonly raw: string[] = [];
  override _write(chunk: Buffer, _encoding: string, callback: () => void) {
    for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
      this.raw.push(line);
      this.lines.push(JSON.parse(line) as Record<string, unknown>);
    }
    callback();
  }
  clear() {
    this.lines.length = 0;
    this.raw.length = 0;
  }
  text() {
    return this.raw.join("\n");
  }
}

let t: TestApp;
let api: HttpClient;
const sink = new LogSink();

beforeAll(async () => {
  t = await createTestApp({ extraModules: [ProbeModule], logDestination: sink, env: { LOG_LEVEL: "debug" } });
  api = httpClient(t.app);
});
beforeEach(() => sink.clear());
afterAll(async () => {
  await t.app.close();
});

describe("PRD 5.2: pemetaan galat ke format baku", () => {
  it("JSON rusak → 400 VALIDATION_ERROR", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/__probe/echo",
      headers: { "content-type": "application/json" },
      payload: "{bukan json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(res.json().message).not.toContain("JSON");
  });

  it("validasi zod → field_errors berkunci path bertitik", async () => {
    const res = await api.post("/__probe/echo", { name: "a", nested: { n: "x" } });
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.json().field_errors).sort()).toEqual(["name", "nested.n"]);
  });

  it("body JSON > 1 MB → 413 VALIDATION_ERROR (bukan FILE_INVALID)", async () => {
    const res = await api.post("/__probe/echo", { name: "x".repeat(1_100_000) });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });

  it("tipe konten tidak didukung → 415 VALIDATION_ERROR; multipart → 415 FILE_INVALID", async () => {
    const text = await t.app.inject({
      method: "POST",
      url: "/api/v1/__probe/echo",
      headers: { "content-type": "text/plain" },
      payload: "halo",
    });
    expect(text.statusCode).toBe(415);
    expect(text.json().code).toBe("VALIDATION_ERROR");
    const multipart = await t.app.inject({
      method: "POST",
      url: "/api/v1/__probe/echo",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: "--x--",
    });
    expect(multipart.statusCode).toBe(415);
    expect(multipart.json().code).toBe("FILE_INVALID");
  });

  it("UuidParam: id bukan UUID → 404 tanpa menyentuh SQL; UUID valid diteruskan", async () => {
    const bad = await api.get("/__probe/item/1%27%20or%201%3D1");
    expect(bad.statusCode).toBe(404);
    expect(bad.json().code).toBe("NOT_FOUND");
    const id = uuidv7();
    expect((await api.get(`/__probe/item/${id.toUpperCase()}`)).json()).toEqual({ id });
  });

  it("pagination: limit di luar 1..100 dan cursor rusak → 400", async () => {
    expect((await api.get("/__probe/page", { query: { limit: "500" } })).statusCode).toBe(400);
    expect((await api.get("/__probe/page")).json()).toEqual({ limit: 30 });
    expect((await api.get("/__probe/page", { query: { limit: "5", cursor: "abc" } })).json()).toEqual({
      cursor: "abc",
      limit: 5,
    });
  });
});

describe("N-14: log JSON tanpa rahasia", () => {
  it("galat database: 500 INTERNAL_ERROR, log hanya tipe + SQLSTATE + constraint (tanpa SQL/parameter)", async () => {
    const res = await api.post("/__probe/db-error", {});
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      code: "INTERNAL_ERROR",
      message: "Terjadi kesalahan. Coba lagi.",
      request_id: res.json().request_id,
    });
    expect(res.body).not.toContain(SECRET_MARKER.toLowerCase());
    const errorLine = sink.lines.find((l) => l.msg === "galat tak tertangani");
    expect(errorLine).toMatchObject({
      level: "error",
      request_id: res.json().request_id,
      error: { type: "DrizzleQueryError", error_code: "23505", constraint: "users_kind_email_key" },
    });
    expect(sink.text().toLowerCase()).not.toContain(SECRET_MARKER.toLowerCase());
    expect(sink.text()).not.toContain("insert into");
  });

  it("satu baris log per request: metode, path tanpa query, status, request_id, client_request_id", async () => {
    await api.get("/__probe/page", {
      query: { limit: "5", cari: "Nama Pribadi" },
      headers: { "x-request-id": "klien-1" },
    });
    const line = sink.lines.find((l) => l.msg === "request selesai");
    expect(line).toMatchObject({
      level: "info",
      service: "kapdh-api",
      client_request_id: "klien-1",
      req: { method: "GET", url: "/api/v1/__probe/page", route: "/api/v1/__probe/page" },
      res: { status_code: 200 },
    });
    expect(typeof line!.request_id).toBe("string");
    expect(sink.text()).not.toContain("Nama Pribadi");
    expect(sink.text()).not.toContain("127.0.0.1");
  });

  it("kunci rahasia di data log disensor pada kedalaman berapa pun", async () => {
    await api.post("/__probe/log-secret", {});
    const line = sink.lines.find((l) => l.msg === "uji redaksi");
    expect(line).toBeDefined();
    expect(sink.text()).not.toContain(SECRET_MARKER);
    expect(line).toMatchObject({
      password: "[REDACTED]",
      body: { refresh_token: "[REDACTED]", nested: { totp_code: "[REDACTED]", ok: "boleh" } },
      headers: { authorization: "[REDACTED]", "set-cookie": "[REDACTED]" },
      module: "ProbeController",
    });
    expect(line!.request_id).toBeTruthy();
  });

  it("login gagal dan header Authorization tidak pernah tercatat", async () => {
    const member = await createAlumni(t, { status: "verified" });
    await api.post(
      "/auth/login",
      { email: member.email, password: `${DEFAULT_PASSWORD}-salah` },
      { token: "token-rahasia-123" },
    );
    expect(sink.text()).not.toContain(DEFAULT_PASSWORD);
    expect(sink.text()).not.toContain("token-rahasia-123");
    expect(sink.text()).not.toContain(member.email);
  });
});
