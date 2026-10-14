#!/usr/bin/env node
// Gerbang CSP web admin (N-07, PRD 5.2; temuan audit D3-07). Dipakai infra/Dockerfile.admin dan CI:
//
//   node infra/scripts/admin-csp.mjs render --api-base <VITE_API_BASE_URL> --conf infra/nginx-admin.conf --out <berkas>
//     Mengganti __KAPDH_API_ORIGIN__ dengan origin API. Hanya https://<host>/api/v1 (N-07), kebijakan yang sama dengan
//     pemeriksaan build arg di infra/Dockerfile.admin dan katalog infra/ci/images.json; image admin tidak dibangun untuk
//     API http lokal (pengembangan lokal memakai `pnpm --filter @kapdh/admin dev` dengan proxy Vite).
//   node infra/scripts/admin-csp.mjs check --dist apps/admin/dist --conf <berkas hasil render>
//     Memastikan hasil build kompatibel dengan CSP (tanpa skrip/gaya inline, handler on*, URL javascript:, sumber
//     origin lain) dan konfigurasi nginx memuat header wajib. Aturan HTML sama dengan situs publik
//     (apps/web/scripts/csp-check.mjs). Keluar 1 bila ada pelanggaran.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export const API_ORIGIN_PLACEHOLDER = "__KAPDH_API_ORIGIN__";

/** Origin API dari VITE_API_BASE_URL; hanya https://<host>/api/v1 (N-07, sama dengan Dockerfile.admin). */
export function apiOriginOf(apiBase) {
  let url;
  try {
    url = new URL(apiBase);
  } catch {
    throw new Error(`VITE_API_BASE_URL tidak valid: ${apiBase}`);
  }
  if (url.protocol !== "https:") throw new Error(`VITE_API_BASE_URL wajib https (N-07): ${apiBase}`);
  if (url.username || url.password || url.search || url.hash)
    throw new Error(`VITE_API_BASE_URL tidak boleh memuat kredensial, query, atau fragmen: ${apiBase}`);
  if (url.pathname !== "/api/v1")
    throw new Error(`VITE_API_BASE_URL wajib https://<host>/api/v1: ${apiBase}`);
  return url.origin;
}

/** Konfigurasi nginx admin dengan origin API terisi. */
export function renderAdminConf(template, apiBase) {
  if (!template.includes(API_ORIGIN_PLACEHOLDER))
    throw new Error(`Templat nginx admin tidak memuat ${API_ORIGIN_PLACEHOLDER}.`);
  return template.split(API_ORIGIN_PLACEHOLDER).join(apiOriginOf(apiBase));
}

/** Nilai satu add_header tingkat server, atau null. */
export function headerValue(conf, name) {
  const m = new RegExp(`add_header ${name} "([^"]*)" always;`).exec(conf);
  return m ? m[1] : null;
}

/** Direktif CSP → daftar sumber. */
export function cspDirectives(csp) {
  return new Map(
    csp
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map((parts) => [parts[0], parts.slice(1)]),
  );
}

/** Pelanggaran konfigurasi nginx admin terhadap kebutuhan N-07 dan aplikasi. */
export function confViolations(conf, apiOrigin) {
  const problems = [];
  if (conf.includes(API_ORIGIN_PLACEHOLDER)) problems.push("placeholder origin API belum diganti");
  const csp = headerValue(conf, "Content-Security-Policy");
  if (!csp) return [...problems, "header Content-Security-Policy tidak ada"];
  if (/unsafe-inline|unsafe-eval|unsafe-hashes|strict-dynamic/.test(csp))
    problems.push("CSP memuat unsafe-*/strict-dynamic");
  const d = cspDirectives(csp);
  const expectExact = (name, value) => {
    if (JSON.stringify(d.get(name)) !== JSON.stringify(value))
      problems.push(`CSP ${name} harus ${value.join(" ")} (ditemukan: ${(d.get(name) ?? ["-"]).join(" ")})`);
  };
  expectExact("default-src", ["'none'"]);
  expectExact("script-src", ["'self'"]);
  expectExact("style-src", ["'self'"]);
  expectExact("frame-ancestors", ["'none'"]);
  expectExact("base-uri", ["'none'"]);
  expectExact("object-src", ["'none'"]);
  for (const name of ["connect-src", "img-src"]) {
    const sources = d.get(name) ?? [];
    if (apiOrigin && !sources.includes(apiOrigin))
      problems.push(`CSP ${name} tidak memuat origin API ${apiOrigin}`);
    if (sources.some((s) => s === "*" || s === "https:" || s === "http:"))
      problems.push(`CSP ${name} terlalu lebar (${sources.join(" ")})`);
  }
  const expectHeader = (name, value) => {
    if (headerValue(conf, name) !== value) problems.push(`header ${name} harus "${value}"`);
  };
  expectHeader("X-Frame-Options", "DENY");
  expectHeader("Referrer-Policy", "no-referrer");
  expectHeader("X-Content-Type-Options", "nosniff");
  expectHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (!/default\s+"no-store";/.test(conf)) problems.push("index.html/rute SPA harus Cache-Control no-store");
  if (!/~\^\/assets\/\s+"public, max-age=31536000, immutable";/.test(conf))
    problems.push("aset /assets/ harus immutable");
  if (!conf.includes("try_files $uri /index.html;"))
    problems.push("fallback SPA try_files ke /index.html tidak ada");
  const locations = conf.split(/\n\s*location\s/).slice(1);
  if (locations.some((block) => block.split("\n    }")[0].includes("add_header")))
    problems.push("add_header di dalam location menghapus header keamanan tingkat server");
  return problems;
}

const OFF_ORIGIN = /^(?:https?:)?\/\//i;

/** Pelanggaran CSP satu dokumen HTML (aturan sama dengan apps/web/scripts/csp-check.mjs). */
export function htmlViolations(html) {
  const problems = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1] ?? "";
    const body = (m[2] ?? "").trim();
    const src = /\ssrc\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1];
    const type = /\stype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    const isData = type !== undefined && type !== "module" && type.includes("json");
    if (!src && body && !isData) problems.push("skrip inline");
    if (src && OFF_ORIGIN.test(src)) problems.push(`skrip dari origin lain: ${src}`);
  }
  if (/<style\b/i.test(html)) problems.push("blok <style> inline");
  for (const m of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const tag = m[0];
    if (/\sstyle\s*=/i.test(tag)) problems.push("atribut style inline");
    if (/\son[a-z]+\s*=/i.test(tag)) problems.push("atribut event handler inline (on*)");
    if (/=\s*["']?\s*javascript:/i.test(tag)) problems.push("URL javascript:");
    if (/^<link\b/i.test(tag)) {
      const href = /\shref\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1] ?? "";
      if (OFF_ORIGIN.test(href)) problems.push(`sumber <link> dari origin lain: ${href}`);
    }
  }
  return [...new Set(problems)];
}

function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...htmlFiles(path));
    else if (name.endsWith(".html")) out.push(path);
  }
  return out;
}

function arg(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === "render") {
    const apiBase = arg(args, "api-base");
    const confPath = arg(args, "conf");
    const outPath = arg(args, "out");
    if (!apiBase || !confPath || !outPath)
      throw new Error("Pakai: render --api-base <url> --conf <templat> --out <berkas>");
    const rendered = renderAdminConf(readFileSync(confPath, "utf8"), apiBase);
    writeFileSync(outPath, rendered);
    console.log(`Konfigurasi nginx admin untuk API ${apiOriginOf(apiBase)} ditulis ke ${outPath}.`);
    return 0;
  }
  if (command === "check") {
    const dist = arg(args, "dist");
    const confPath = arg(args, "conf");
    const apiBase = arg(args, "api-base");
    if (!dist || !confPath)
      throw new Error("Pakai: check --dist <folder build> --conf <berkas> [--api-base <url>]");
    const problems = confViolations(
      readFileSync(confPath, "utf8"),
      apiBase ? apiOriginOf(apiBase) : null,
    ).map((p) => `${confPath}: ${p}`);
    const pages = htmlFiles(dist);
    if (pages.length === 0) problems.push(`${dist}: tidak ada berkas HTML hasil build`);
    for (const page of pages)
      for (const p of htmlViolations(readFileSync(page, "utf8")))
        problems.push(`${relative(dist, page)}: ${p}`);
    if (problems.length > 0) {
      console.error("Gerbang CSP web admin GAGAL (N-07):");
      for (const p of problems) console.error(`  - ${p}`);
      return 1;
    }
    console.log(`Gerbang CSP web admin lulus untuk ${pages.length} halaman dan ${confPath}.`);
    return 0;
  }
  console.error("Pakai: admin-csp.mjs render|check ...");
  return 2;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`Gerbang CSP web admin: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
  }
}
