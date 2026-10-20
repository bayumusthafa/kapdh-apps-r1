/**
 * Titik impor worker untuk apps/worker (ARCHITECTURE §1: "apps/worker thin runtime ... (uses @kapdh/api/worker)"):
 * package.json @kapdh/api mengekspor `./worker` beserta deklarasi tipe hasil build, sehingga pemilik worker tidak
 * perlu menyunting konfigurasi build core.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (file: string) =>
  JSON.parse(readFileSync(join(apiRoot, file), "utf8")) as Record<string, unknown>;

describe("@kapdh/api/worker (ARCHITECTURE §1, §4.8)", () => {
  it("package.json mengekspor ./worker (types + default) dan build menghasilkan deklarasi", () => {
    const pkg = read("package.json");
    expect(pkg.exports).toMatchObject({
      "./worker": { types: "./dist/worker.d.ts", default: "./dist/worker.js" },
    });
    const build = read("tsconfig.build.json") as { compilerOptions?: { declaration?: boolean } };
    expect(build.compilerOptions?.declaration).toBe(true);
  });

  // Hasil `pnpm build` (turbo menjalankan build sebelum uji pada alur verifikasi); dilewati bila dist belum ada.
  const built =
    existsSync(join(apiRoot, "dist", "worker.js")) && existsSync(join(apiRoot, "dist", "worker.d.ts"));
  it.skipIf(!built)("konsumen workspace dapat mengimpor `@kapdh/api/worker` (resolusi exports Node)", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const m = await import('@kapdh/api/worker'); " +
          "console.log(JSON.stringify(['createWorkerContext','createWorkerDeps','JobRegistry','JobRunner']" +
          ".map((k) => typeof m[k])));",
      ],
      { cwd: apiRoot, encoding: "utf8", timeout: 60_000 },
    );
    expect(JSON.parse(output.trim().split("\n").pop()!)).toEqual([
      "function",
      "function",
      "function",
      "function",
    ]);
    const declarations = readFileSync(join(apiRoot, "dist", "worker.d.ts"), "utf8");
    expect(declarations).toContain("export declare function createWorkerContext");
    expect(declarations).toContain("export declare function createWorkerDeps");
  });
});
