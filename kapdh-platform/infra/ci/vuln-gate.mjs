#!/usr/bin/env node
// Gerbang kerentanan rilis (N-16 "tidak ada kerentanan kritis yang belum ditangani"; PRD 9.3: bug tinggi yang
// memengaruhi identitas/akses admin tidak boleh terbuka saat rilis). Satu aturan untuk tiga pemindai:
//   --source pnpm-audit   `pnpm audit --prod --json` (dependensi produksi kapdh-platform)
//   --source osv          `osv-scanner scan source --format json` (kapdh-mobile/pubspec.lock)
//   --source grype        `grype <image> -o json` (paket OS dan bahasa di image Docker)
// Temuan dengan tingkat >= --fail-on GAGAL kecuali tercatat di allowlist yang ditinjau (infra/ci/vuln-allowlist.json:
// id advisory, pemilik, alasan, kedaluwarsa <= 90 hari). Entri kedaluwarsa tidak berlaku; entri tak terpakai
// dilaporkan agar dihapus. Tingkat di bawah ambang dan tanpa skor menjadi peringatan. Laporan tidak dapat dibaca =
// GAGAL (fail-closed).
//
//   node infra/ci/vuln-gate.mjs --source <pnpm-audit|osv|grype> <laporan.json> [--fail-on high|critical]
//     [--allowlist infra/ci/vuln-allowlist.json] [--label <nama>]
// Keluar 0 lulus, 1 ada temuan yang memblokir, 2 masukan/allowlist tidak valid.
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ALLOWLIST = join(HERE, "vuln-allowlist.json");
export const SOURCES = ["pnpm-audit", "osv", "grype"];
export const LEVELS = ["unknown", "low", "moderate", "high", "critical"];
const RANK = Object.fromEntries(LEVELS.map((l, i) => [l, i]));
const MAX_ALLOW_DAYS = 90;
const DAY_MS = 86_400_000;

export class InputError extends Error {}

/** Skor CVSS (string/angka) -> tingkat. */
export function levelFromCvss(score) {
  const n = Number.parseFloat(score);
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  if (n >= 9) return "critical";
  if (n >= 7) return "high";
  if (n >= 4) return "moderate";
  return "low";
}

/** Tingkat teks pemindai -> tingkat gerbang. */
export function normalizeLevel(text) {
  const t = String(text ?? "")
    .trim()
    .toLowerCase();
  if (t === "critical") return "critical";
  if (t === "high") return "high";
  if (t === "moderate" || t === "medium") return "moderate";
  if (t === "low" || t === "negligible" || t === "info") return "low";
  return "unknown";
}

const uniq = (list) => [...new Set(list.filter(Boolean))];

/** Meratakan laporan pemindai menjadi [{source, package, version, ids, level, title, fix}]. */
export function findings(source, report) {
  if (source === "pnpm-audit") {
    if (!report || typeof report !== "object" || !report.advisories || !report.metadata)
      throw new InputError(
        `laporan pnpm audit tidak valid${report?.error ? `: ${JSON.stringify(report.error).slice(0, 200)}` : ""}`,
      );
    return Object.values(report.advisories).map((a) => ({
      source,
      package: a.module_name ?? "?",
      version: uniq((a.findings ?? []).map((f) => f.version)).join(", ") || "?",
      ids: uniq([a.github_advisory_id, ...(a.cves ?? []), a.id === undefined ? null : `npm:${a.id}`]),
      level: normalizeLevel(a.severity),
      title: a.title ?? "",
      fix: a.patched_versions ?? "",
    }));
  }
  if (source === "osv") {
    if (!report || typeof report !== "object" || !Array.isArray(report.results ?? []))
      throw new InputError("laporan osv-scanner tidak valid");
    const out = [];
    for (const result of report.results ?? []) {
      for (const pkg of result.packages ?? []) {
        const groups = pkg.groups?.length
          ? pkg.groups
          : (pkg.vulnerabilities ?? []).map((v) => ({
              ids: [v.id],
              aliases: v.aliases ?? [],
              max_severity: "",
            }));
        for (const g of groups)
          out.push({
            source,
            package: pkg.package?.name ?? "?",
            version: pkg.package?.version ?? "?",
            ids: uniq([...(g.ids ?? []), ...(g.aliases ?? [])]),
            level: levelFromCvss(g.max_severity),
            title: result.source?.path ?? "",
            fix: "",
          });
      }
    }
    return out;
  }
  if (source === "grype") {
    if (!report || typeof report !== "object" || !Array.isArray(report.matches))
      throw new InputError("laporan grype tidak valid (tanpa matches)");
    return report.matches.map((m) => ({
      source,
      package: m.artifact?.name ?? "?",
      version: m.artifact?.version ?? "?",
      ids: uniq([m.vulnerability?.id, ...(m.relatedVulnerabilities ?? []).map((r) => r.id)]),
      level: normalizeLevel(m.vulnerability?.severity),
      title: m.artifact?.type ?? "",
      fix: (m.vulnerability?.fix?.versions ?? []).join(", "),
    }));
  }
  throw new InputError(`--source harus salah satu dari ${SOURCES.join(", ")}`);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Memvalidasi allowlist; mengembalikan {entries (berlaku), problems (galat), expired}. */
export function validateAllowlist(doc, { today }) {
  const problems = [];
  const entries = [];
  const expired = [];
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.entries))
    return { entries, expired, problems: ['allowlist wajib berbentuk {"entries": [...]}'] };
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  doc.entries.forEach((e, i) => {
    const at = `entri ${i + 1}${e?.id ? ` (${e.id})` : ""}`;
    const issues = [];
    if (typeof e?.id !== "string" || e.id.trim() === "") issues.push("id advisory wajib");
    if (!["*", ...SOURCES].includes(e?.source ?? ""))
      issues.push(`source wajib salah satu dari *, ${SOURCES.join(", ")}`);
    if (typeof e?.owner !== "string" || e.owner.trim().length < 2) issues.push("owner wajib");
    if (typeof e?.reason !== "string" || e.reason.trim().length < 20)
      issues.push("reason wajib (minimal 20 karakter: dampak, mitigasi, rencana perbaikan)");
    const expMs =
      typeof e?.expires === "string" && DATE_RE.test(e.expires) ? Date.parse(`${e.expires}T00:00:00Z`) : NaN;
    if (!Number.isFinite(expMs)) issues.push("expires wajib YYYY-MM-DD");
    else if (expMs - todayMs > MAX_ALLOW_DAYS * DAY_MS)
      issues.push(`expires paling lama ${MAX_ALLOW_DAYS} hari dari hari ini (tinjau ulang berkala)`);
    if (issues.length > 0) {
      problems.push(`${at}: ${issues.join("; ")}`);
      return;
    }
    if (expMs < todayMs) expired.push(e);
    else entries.push(e);
  });
  return { entries, expired, problems };
}

function matches(entry, finding) {
  if (entry.source !== "*" && entry.source !== finding.source) return false;
  if (entry.package && entry.package !== finding.package) return false;
  return finding.ids.includes(entry.id);
}

/** Menerapkan ambang dan allowlist. */
export function evaluate(list, { failOn = "high", allow = { entries: [], expired: [] } } = {}) {
  if (!["high", "critical"].includes(failOn)) throw new InputError("--fail-on harus high atau critical");
  const blocking = [];
  const accepted = [];
  const warnings = [];
  const used = new Set();
  for (const f of list) {
    if (f.level !== "unknown" && RANK[f.level] >= RANK[failOn]) {
      const entry = allow.entries.find((e) => matches(e, f));
      if (entry) {
        used.add(entry);
        accepted.push({ ...f, entry });
      } else {
        const stale = allow.expired.find((e) => matches(e, f));
        blocking.push(stale ? { ...f, expiredEntry: stale } : f);
      }
    } else if (f.level === "unknown" || RANK[f.level] >= RANK.moderate) warnings.push(f);
  }
  const source = list[0]?.source;
  const unused = allow.entries.filter((e) => !used.has(e) && (source === undefined || e.source === source));
  return { ok: blocking.length === 0, blocking, accepted, warnings, unused };
}

const cell = (s) => String(s ?? "").replaceAll("|", "\\|");

export function summary({ label, source, failOn, list, verdict }) {
  const lines = [
    `### Gerbang kerentanan: ${label} (${source}, N-16)`,
    "",
    `${list.length} temuan; ambang gagal: ${failOn} ke atas (kecuali allowlist yang ditinjau).`,
  ];
  const table = (heading, rows, extra) => {
    if (rows.length === 0) return;
    lines.push(
      "",
      heading,
      "",
      "| Tingkat | Paket | ID | Perbaikan | Catatan |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const f of rows)
      lines.push(
        `| ${f.level} | ${cell(`${f.package} ${f.version}`)} | ${cell(f.ids.join(", "))} | ${cell(f.fix)} | ${cell(extra(f))} |`,
      );
  };
  table("Memblokir:", verdict.blocking, (f) =>
    f.expiredEntry ? `allowlist kedaluwarsa ${f.expiredEntry.expires}` : f.title,
  );
  table(
    "Diterima allowlist:",
    verdict.accepted,
    (f) => `${f.entry.owner}, s.d. ${f.entry.expires}: ${f.entry.reason}`,
  );
  table("Peringatan (di bawah ambang atau tanpa skor):", verdict.warnings, (f) => f.title);
  if (verdict.unused.length > 0) {
    lines.push("", "Entri allowlist tidak terpakai (hapus):");
    for (const e of verdict.unused) lines.push(`- ${e.id} (${e.source}${e.package ? `, ${e.package}` : ""})`);
  }
  lines.push("", verdict.ok ? "Hasil: lulus." : "Hasil: GAGAL.");
  return lines.join("\n");
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2), env = process.env, { today } = {}) {
  const valued = new Set(["--source", "--fail-on", "--allowlist", "--label", "--today"]);
  const file = argv.find((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1]));
  const source = arg(argv, "--source");
  if (!file || !SOURCES.includes(source ?? ""))
    throw new InputError(
      "Pemakaian: vuln-gate.mjs --source <pnpm-audit|osv|grype> <laporan.json> [--fail-on high|critical] [--allowlist f] [--label n]",
    );
  const failOn = arg(argv, "--fail-on") ?? "high";
  const label = arg(argv, "--label") ?? source;
  const day = today ?? arg(argv, "--today") ?? new Date().toISOString().slice(0, 10);
  const text = readFileSync(file, "utf8").trim();
  let report;
  try {
    report = text === "" && source === "osv" ? { results: [] } : JSON.parse(text);
  } catch {
    throw new InputError(`laporan ${source} bukan JSON (${file})`);
  }
  const list = findings(source, report);
  const allowDoc = JSON.parse(readFileSync(arg(argv, "--allowlist") ?? DEFAULT_ALLOWLIST, "utf8"));
  const allow = validateAllowlist(allowDoc, { today: day });
  for (const p of allow.problems) console.log(`::error title=vuln-allowlist::${p}`);
  if (allow.problems.length > 0) throw new InputError("allowlist kerentanan tidak valid");
  const verdict = evaluate(list, { failOn, allow });
  // Entri tak terpakai hanya dilaporkan untuk sumber yang sama (allowlist dipakai beberapa pemindai).
  verdict.unused = allow.entries.filter(
    (e) => e.source === source && !verdict.accepted.some((a) => a.entry === e),
  );
  for (const f of verdict.blocking)
    console.log(
      `::error title=Kerentanan ${f.level} ${f.package} (${label})::${f.ids.join(", ")} ${f.version}${f.fix ? ` -> ${f.fix}` : ""}${f.expiredEntry ? ` (allowlist kedaluwarsa ${f.expiredEntry.expires})` : ""}`,
    );
  for (const f of verdict.accepted)
    console.log(
      `::notice title=Kerentanan diterima (${label})::${f.ids[0]} ${f.package}: ${f.entry.owner} s.d. ${f.entry.expires}`,
    );
  for (const e of verdict.unused)
    console.log(
      `::warning title=vuln-allowlist::entri ${e.id} (${e.source}) tidak terpakai; hapus dari allowlist`,
    );
  const md = summary({ label, source, failOn, list, verdict });
  console.log(md);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${md}\n`);
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`::error title=vuln-gate::${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = e instanceof InputError || e instanceof SyntaxError ? 2 : 1;
  }
}
