import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAlumni, signInAlumni } from "../support/factories.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

/**
 * Probe monitoring eksternal (PRD 5.5 "monitoring wajib meliputi HTTP, koneksi WS", N-05; docs/runbooks/monitoring.md):
 * infra/monitoring/realtime-probe.mjs dijalankan sebagai proses terpisah terhadap API uji yang benar-benar mendengar
 * (Fastify + gateway Socket.IO /realtime yang sama dengan production).
 */
const PROBE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "infra",
  "monitoring",
  "realtime-probe.mjs",
);

let t: TestApp;
let base: string;

beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen(0, "127.0.0.1");
  const { port } = t.app.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await t.app.close();
});

function probe(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROBE], {
      env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", ...env },
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (code) => resolve({ code, out }));
  });
}

describe("realtime-probe.mjs (PRD 5.5 koneksi WS, N-05)", () => {
  it("tanpa token: gateway hidup dan menolak token tidak sah (CONNECT_ERROR) -> PASS", async () => {
    const result = await probe({ REALTIME_URL: base });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toMatch(/^PASS realtime gateway menolak token tidak sah/m);
  });

  it("dengan access token akun uji: terhubung ke /realtime -> PASS; token tidak pernah dicetak", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const session = await signInAlumni(t, member);
    const result = await probe({ REALTIME_URL: base, REALTIME_PROBE_TOKEN: session.accessToken });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toMatch(/^PASS realtime terhubung ke \/realtime/m);
    expect(result.out).not.toContain(session.accessToken);
  });

  it("API tidak terjangkau atau URL salah -> FAIL dan keluar 1", async () => {
    const down = await probe({ REALTIME_URL: "http://127.0.0.1:9", REALTIME_PROBE_TIMEOUT_MS: "3000" });
    expect(down.code).toBe(1);
    expect(down.out).toMatch(/^FAIL realtime /m);
    const invalid = await probe({ REALTIME_URL: "bukan-url" });
    expect(invalid.code).toBe(1);
  });
});
