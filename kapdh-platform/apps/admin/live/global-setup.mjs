/**
 * globalSetup jalur `test:live` (temuan audit D2-14): menjalankan API KAPDH nyata (live/api-server.mjs) di proses
 * anak pada port bebas, menunggu baris siap `{"kapdhLive": ...}`, lalu menyediakan alamat dan fixture-nya ke uji
 * lewat `inject("kapdhLive")`. Proses anak dihentikan saat teardown; bila induk mati, stdin anak tertutup dan anak
 * ikut berhenti.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const READY_TIMEOUT_MS = 180_000;

function freePort() {
  return new Promise((done, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? done(address.port) : reject(new Error("port")),
      );
    });
  });
}

/** @param {import("vitest/node").TestProject} project */
export default async function setup(project) {
  const port = Number(process.env.KAPDH_LIVE_PORT) || (await freePort());
  const child = spawn(
    process.execPath,
    ["--experimental-import-meta-resolve", "--no-warnings", resolve(here, "api-server.mjs")],
    {
      cwd: resolve(here, "../../api"),
      env: { ...process.env, NODE_ENV: "test", KAPDH_LIVE_PORT: String(port) },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const info = await new Promise((done, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`API live tidak siap dalam ${READY_TIMEOUT_MS / 1000} detik.\n${stderr}`));
    }, READY_TIMEOUT_MS);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (parsed && parsed.kapdhLive) {
        clearTimeout(timer);
        done(parsed.kapdhLive);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `API live berhenti sebelum siap (kode ${code}). Jalankan \`pnpm build\` lebih dulu.\n${stderr}`,
        ),
      );
    });
  });

  project.provide("kapdhLive", info);

  return async () => {
    if (child.exitCode !== null) return;
    child.stdin.end();
    child.kill();
    await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 10_000))]);
  };
}
