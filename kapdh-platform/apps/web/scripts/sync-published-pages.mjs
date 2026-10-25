// Menarik salinan TAYANG halaman informasi/legal dari API (GET /public/pages/{slug}) ke src/published-pages/<slug>.json
// agar dirender statis saat build dan terbaca tanpa JavaScript (aturan di published-pages.mjs). Jalankan setelah setiap
// penerbitan di web admin, tinjau diff, commit, lalu build dan deploy ulang situs publik (docs/legal/README.md).
//
//   pnpm --filter @kapdh/web pages:sync     # tulis ulang salinan dari API production
//   pnpm --filter @kapdh/web pages:check    # gagal bila salinan berbeda dari naskah yang tayang
//   node scripts/sync-published-pages.mjs [--check] [--api <url dasar API>] [slug ...]
//
// Bawaan: API production dan slug semua berkas di src/published-pages/. Respons yang tidak sah atau naskah tayang yang
// memuat penanda belum terbit ([tanggal terbit], kerangka DRAF) tidak pernah ditulis.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  DEFAULT_PAGES_API,
  pickPublishedPage,
  publishedPageProblems,
  serializePublishedPage,
} from "./published-pages.mjs";

const DIR = fileURLToPath(new URL("../src/published-pages/", import.meta.url));

const { values, positionals } = parseArgs({
  options: { check: { type: "boolean", default: false }, api: { type: "string" } },
  allowPositionals: true,
});
const api = (values.api ?? DEFAULT_PAGES_API).replace(/\/+$/, "");
const slugs =
  positionals.length > 0
    ? positionals
    : (await readdir(DIR)).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));

/** @param {string} slug @returns {Promise<{ page: Record<string, unknown> } | { error: string }>} */
async function fetchPage(slug) {
  let response;
  try {
    response = await fetch(`${api}/public/pages/${encodeURIComponent(slug)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { error: `API tidak terjangkau (${error instanceof Error ? error.message : String(error)})` };
  }
  if (response.status !== 200) return { error: `API menjawab ${response.status}` };
  try {
    return { page: pickPublishedPage(await response.json()) };
  } catch {
    return { error: "respons bukan JSON" };
  }
}

/** Versi salinan yang tersimpan, untuk laporan. @param {string | null} content */
function savedVersion(content) {
  if (content === null) return "belum ada salinan";
  try {
    return `salinan versi ${JSON.parse(content).version}`;
  } catch {
    return "salinan bukan JSON";
  }
}

let failed = false;
for (const slug of slugs) {
  const file = join(DIR, `${slug}.json`);
  const fetched = await fetchPage(slug);
  const problems = "error" in fetched ? [fetched.error] : publishedPageProblems(fetched.page, slug);
  if ("error" in fetched || problems.length > 0) {
    failed = true;
    for (const problem of problems) console.error(`GAGAL  ${slug}: ${problem}`);
    continue;
  }
  const next = serializePublishedPage(fetched.page);
  const current = await readFile(file, "utf8").catch(() => null);
  const live = `tayang versi ${fetched.page.version}`;
  if (current === next) {
    console.log(`sama   ${slug}: ${live}`);
  } else if (values.check) {
    failed = true;
    console.error(`BEDA   ${slug}: ${savedVersion(current)}, ${live}`);
  } else {
    await writeFile(file, next);
    console.log(`tulis  ${slug}: ${savedVersion(current)} -> ${live}`);
  }
}
if (failed) {
  console.error(
    values.check
      ? `Salinan naskah di src/published-pages/ tidak sama dengan yang tayang di ${api}: jalankan pages:sync, commit, lalu build dan deploy ulang situs publik.`
      : `Sebagian salinan tidak ditulis (${api}).`,
  );
  process.exit(1);
}
