#!/usr/bin/env node
// Gerbang kerentanan dependensi Flutter/Dart (N-16: "tidak ada kerentanan kritis yang belum ditangani").
// Membaca keluaran `osv-scanner scan source --format json -L kapdh-mobile/pubspec.lock` dan:
//   - GAGAL (exit 1) bila ada kelompok kerentanan dengan max_severity CVSS >= ambang (bawaan 9.0 = kritis),
//   - memberi peringatan untuk CVSS >= 7.0 (tinggi) dan untuk kerentanan tanpa skor (perlu ditinjau manual).
// Ringkasan Markdown ditulis ke GITHUB_STEP_SUMMARY bila tersedia.
//
//   node infra/ci/osv-gate.mjs <osv.json> [--fail-at 9.0] [--warn-at 7.0]
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Meratakan hasil osv-scanner v2 menjadi daftar {package, version, ecosystem, ids, severity}. */
export function findings(report) {
  const out = [];
  for (const result of report?.results ?? []) {
    for (const pkg of result.packages ?? []) {
      const groups = pkg.groups?.length
        ? pkg.groups
        : (pkg.vulnerabilities ?? []).map((v) => ({
            ids: [v.id],
            aliases: v.aliases ?? [],
            max_severity: "",
          }));
      for (const g of groups) {
        const score = Number.parseFloat(g.max_severity);
        out.push({
          package: pkg.package?.name ?? "?",
          version: pkg.package?.version ?? "?",
          ecosystem: pkg.package?.ecosystem ?? "?",
          ids: [...(g.ids ?? []), ...(g.aliases ?? [])].filter((v, i, a) => a.indexOf(v) === i),
          severity: Number.isFinite(score) ? score : null,
          source: result.source?.path ?? "",
        });
      }
    }
  }
  return out;
}

export function evaluate(list, { failAt = 9.0, warnAt = 7.0 } = {}) {
  const blocking = list.filter((f) => f.severity !== null && f.severity >= failAt);
  const warnings = list.filter((f) => f.severity === null || (f.severity >= warnAt && f.severity < failAt));
  return { ok: blocking.length === 0, blocking, warnings };
}

function row(f) {
  return `| ${f.ecosystem} | ${f.package} ${f.version} | ${f.ids.join(", ")} | ${f.severity ?? "tanpa skor"} |`;
}

export function summary(list, verdict, { failAt, warnAt }) {
  const lines = [
    "### Pemindaian OSV dependensi Flutter (N-16)",
    "",
    `${list.length} kelompok kerentanan; ambang gagal CVSS >= ${failAt}, peringatan >= ${warnAt}.`,
    "",
  ];
  if (list.length > 0) {
    lines.push("| Ekosistem | Paket | ID | CVSS maks |", "| --- | --- | --- | --- |");
    for (const f of [...list].sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0))) lines.push(row(f));
  }
  lines.push(
    "",
    verdict.ok ? "Hasil: lulus (tidak ada kerentanan kritis)." : "Hasil: GAGAL (ada kerentanan kritis).",
  );
  return lines.join("\n");
}

function numberArg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const file = argv.find((a, i) => !a.startsWith("--") && !["--fail-at", "--warn-at"].includes(argv[i - 1]));
  if (!file) throw new Error("Pemakaian: osv-gate.mjs <osv.json> [--fail-at 9.0] [--warn-at 7.0]");
  const failAt = numberArg(argv, "--fail-at", 9.0);
  const warnAt = numberArg(argv, "--warn-at", 7.0);
  const text = readFileSync(file, "utf8").trim();
  const report = text === "" ? { results: [] } : JSON.parse(text);
  const list = findings(report);
  const verdict = evaluate(list, { failAt, warnAt });
  for (const f of verdict.blocking)
    console.log(
      `::error title=Kerentanan kritis ${f.package}::${f.ids.join(", ")} CVSS ${f.severity} (${f.version})`,
    );
  for (const f of verdict.warnings)
    console.log(
      `::warning title=Kerentanan ${f.package}::${f.ids.join(", ")} CVSS ${f.severity ?? "tanpa skor"} (${f.version})`,
    );
  const md = summary(list, verdict, { failAt, warnAt });
  console.log(md);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${md}\n`);
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`::error title=osv-gate::${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
