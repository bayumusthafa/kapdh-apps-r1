// Memuat katalog @kapdh/shared (ERROR_UI, routeForStatus, MEMBERSHIP_LABEL, ...) langsung dari sumber
// TypeScript-nya agar SDK Dart memakai satu sumber kebenaran yang sama dengan web (PRD 5.2: satu katalog galat).
//
// @kapdh/shared bergantung pada tipe @kapdh/contracts, sehingga contracts tidak boleh bergantung balik pada paket
// shared (siklus turbo). Karena itu sumber shared ditranspilasi di sini (impor tipe terhapus) ke direktori sementara
// lalu diimpor. Turbo memasukkan packages/shared/src/** sebagai input build contracts (turbo.json).
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { PATHS } from "./fs.mjs";

/**
 * @returns {Promise<{
 *   ERROR_UI: Record<string, {action: string, fallbackMessage: string}>,
 *   ERROR_UI_ACTIONS: readonly string[],
 *   CLIENT_ERROR_UI: Record<string, {action: string, fallbackMessage: string}>,
 *   MEMBER_ROUTES: readonly string[],
 *   MEMBER_ROUTE_PATH: Record<string, string>,
 *   MEMBERSHIP_LABEL: Record<string, string>,
 *   MEMBERSHIP_LABEL_UNKNOWN: string,
 *   routeForStatus: (status: string) => string,
 *   PASSWORD_MIN_BYTES: number,
 *   PASSWORD_MAX_BYTES: number,
 * }>}
 */
export async function loadSharedCatalog(srcDir = PATHS.sharedSrc) {
  const out = mkdtempSync(join(tmpdir(), "kapdh-shared-"));
  try {
    for (const file of readdirSync(srcDir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.endsWith(".d.ts")) continue;
      const source = readFileSync(join(srcDir, file), "utf8");
      const result = ts.transpileModule(source, {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          verbatimModuleSyntax: false,
          isolatedModules: true,
        },
      });
      if (result.diagnostics?.length) {
        const msg = result.diagnostics
          .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
          .join("\n");
        throw new Error(`packages/shared/src/${file}: gagal ditranspilasi\n${msg}`);
      }
      writeFileSync(join(out, file.replace(/\.ts$/, ".js")), result.outputText);
    }
    // package.json bertipe module agar Node memperlakukan berkas .js sebagai ESM.
    writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module" }));
    try {
      return await import(pathToFileURL(join(out, "index.js")).href);
    } catch (error) {
      throw new Error(
        "packages/shared/src tidak dapat dimuat tanpa dependensi runtime (hanya impor tipe yang diizinkan): " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
