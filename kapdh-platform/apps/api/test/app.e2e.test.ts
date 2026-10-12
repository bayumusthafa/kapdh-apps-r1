import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support/test-app.js";

describe("API dasar", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /api/v1/health", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("GET /api/v1/public/config sesuai kontrak", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/public/config" });
    expect(res.statusCode).toBe(200);
    expect(res.json().min_app_version.android).toBe("1.0.0");
  });

  it("rute tidak dikenal memakai format galat baku", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tidak-ada",
      headers: { "x-request-id": "test-req-12345" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      code: "NOT_FOUND",
      message: "Data tidak ditemukan.",
      request_id: "test-req-12345",
    });
  });

  it("CORS hanya untuk origin web admin dan situs publik", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/health",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
