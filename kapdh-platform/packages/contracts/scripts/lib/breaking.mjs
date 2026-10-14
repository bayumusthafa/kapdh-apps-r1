// Kebijakan kompatibilitas kontrak (N-13: "perubahan kontrak gagal CI bila memutus versi klien yang masih
// didukung"; PRD 5.2, U-13; temuan audit D2-12). Murni (tanpa I/O) agar dapat diuji; CLI di scripts/check-breaking.mjs.
//
// Masukan: daftar perubahan `oasdiff breaking <rilis terakhir> <kepala> --format json` (level 3 = ERR, 2 = WARN,
// 1 = INFO) serta metadata kontrak kedua sisi (`info.version` dan `info.x-kapdh-min-app-version`).
// Aturan:
//   - Tanpa perubahan ERR: kompatibel (aditif). WARN dilaporkan sebagai peringatan, tidak memblokir: SDK Dart
//     memperlakukan nilai enum baru dan event realtime tak dikenal secara aman (diuji di dart/kapdh_api).
//   - Ada perubahan ERR: hanya diterima bila versi MAYOR `info.version` naik (di bawah 1.0.0 versi minor berperan
//     sebagai mayor, aturan semver) DAN `x-kapdh-min-app-version` naik bersamaan, yaitu versi aplikasi lama yang
//     terputus resmi tidak didukung lagi dan akan menerima 426 UPGRADE_REQUIRED setelah app_settings.min_app_version
//     dinaikkan (PRD 4.5, 8.4).
//   - Versi kontrak tidak boleh turun.

export const MIN_APP_VERSION_KEY = "x-kapdh-min-app-version";

export const LEVEL = Object.freeze({ ERR: 3, WARN: 2, INFO: 1 });

/** Level numerik perubahan oasdiff; menerima angka (format json) maupun teks ("error", "warning", "info"). */
export function levelOf(change) {
  const raw = change?.level;
  if (typeof raw === "number") return raw;
  const text = String(raw ?? "").toLowerCase();
  if (text.startsWith("err")) return LEVEL.ERR;
  if (text.startsWith("warn")) return LEVEL.WARN;
  if (text.startsWith("info")) return LEVEL.INFO;
  return 0;
}

/** Menerima keluaran json oasdiff: array polos atau objek {changes: [...]}. */
export function normalizeChanges(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.changes)) return json.changes;
  throw new Error("keluaran oasdiff bukan daftar perubahan JSON");
}

const SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(value) {
  const m = SEMVER_RE.exec(String(value ?? "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

/** Bandingkan semver (-1, 0, 1). Prarilis lebih rendah dari rilis dengan angka sama. */
export function compareSemver(a, b) {
  const x = typeof a === "string" ? parseSemver(a) : a;
  const y = typeof b === "string" ? parseSemver(b) : b;
  if (!x || !y) throw new Error(`bukan semver: ${!x ? a : b}`);
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Kenaikan versi mayor; di bawah 1.0.0 kenaikan minor setara mayor (semver §4). */
export function isMajorBump(base, head) {
  const x = parseSemver(base);
  const y = parseSemver(head);
  if (!x || !y) return false;
  if (y.major !== x.major) return y.major > x.major;
  return x.major === 0 && y.minor > x.minor;
}

/** Metadata kontrak yang dinilai gerbang. */
export function contractMeta(doc) {
  const info = doc?.info ?? {};
  const min = info[MIN_APP_VERSION_KEY];
  return { version: info.version ?? null, minAppVersion: typeof min === "string" ? min : null };
}

/** Versi kontrak, package.json @kapdh/contracts dan pubspec kapdh_api wajib sama (tag rilis contracts-vX.Y.Z). */
export function versionConsistency({ infoVersion, packageVersion, pubspecVersion }) {
  const problems = [];
  if (!parseSemver(infoVersion)) problems.push(`info.version kontrak bukan semver: ${infoVersion}`);
  if (infoVersion !== packageVersion)
    problems.push(
      `info.version (${infoVersion}) berbeda dengan package.json @kapdh/contracts (${packageVersion})`,
    );
  if (infoVersion !== pubspecVersion)
    problems.push(`info.version (${infoVersion}) berbeda dengan pubspec kapdh_api (${pubspecVersion})`);
  return problems;
}

/**
 * Menilai perubahan terhadap kebijakan N-13.
 * @returns {{ok: boolean, verdict: "compatible"|"breaking-approved"|"breaking-blocked",
 *            breaking: object[], warnings: object[], problems: string[]}}
 */
export function evaluateCompatibility({ changes, base, head }) {
  const list = normalizeChanges(changes);
  const breaking = list.filter((c) => levelOf(c) >= LEVEL.ERR);
  const warnings = list.filter((c) => levelOf(c) === LEVEL.WARN);
  const problems = [];

  if (!parseSemver(head.version)) problems.push(`info.version kepala bukan semver: ${head.version}`);
  else if (parseSemver(base.version) && compareSemver(head.version, base.version) < 0)
    problems.push(`info.version turun dari ${base.version} ke ${head.version}`);
  if (head.minAppVersion !== null && !parseSemver(head.minAppVersion))
    problems.push(`${MIN_APP_VERSION_KEY} bukan semver: ${head.minAppVersion}`);

  if (breaking.length > 0) {
    if (!isMajorBump(base.version, head.version))
      problems.push(
        `${breaking.length} perubahan memutus memerlukan kenaikan versi mayor info.version ` +
          `(di bawah 1.0.0: minor); sekarang ${base.version} -> ${head.version}`,
      );
    if (head.minAppVersion === null)
      problems.push(`perubahan memutus memerlukan info.${MIN_APP_VERSION_KEY}`);
    else if (
      base.minAppVersion !== null &&
      parseSemver(base.minAppVersion) &&
      parseSemver(head.minAppVersion) &&
      compareSemver(head.minAppVersion, base.minAppVersion) <= 0
    )
      problems.push(
        `perubahan memutus memerlukan kenaikan ${MIN_APP_VERSION_KEY} bersama versi mayor ` +
          `(sekarang ${base.minAppVersion} -> ${head.minAppVersion}); versi aplikasi lama tidak lagi didukung`,
      );
  }

  const ok = problems.length === 0;
  const verdict = breaking.length === 0 ? "compatible" : ok ? "breaking-approved" : "breaking-blocked";
  return { ok, verdict, breaking, warnings, problems };
}

const cell = (s) =>
  String(s ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");

/** Laporan Markdown untuk GITHUB_STEP_SUMMARY dan artefak CI. */
export function renderReport({ baseRef, base, head, result }) {
  const title = {
    compatible: "Kompatibel: tidak ada perubahan yang memutus klien yang didukung",
    "breaking-approved": "Perubahan memutus DITERIMA: versi mayor dan versi aplikasi minimum naik bersama",
    "breaking-blocked": "GAGAL: perubahan memutus klien yang masih didukung",
  }[result.verdict];
  const lines = [
    `### Gerbang kontrak N-13: ${title}`,
    "",
    `Pembanding: \`${baseRef}\` (versi ${base.version}, aplikasi minimum ${base.minAppVersion ?? "-"}) -> kepala ` +
      `(versi ${head.version}, aplikasi minimum ${head.minAppVersion ?? "-"}).`,
    "",
    `Perubahan memutus (ERR): ${result.breaking.length}; peringatan (WARN): ${result.warnings.length}.`,
  ];
  if (result.problems.length > 0) {
    lines.push("", "Masalah:");
    for (const p of result.problems) lines.push(`- ${p}`);
  }
  const table = (heading, rows) => {
    if (rows.length === 0) return;
    lines.push("", heading, "", "| ID | Operasi | Rincian |", "| --- | --- | --- |");
    for (const c of rows)
      lines.push(
        `| ${cell(c.id)} | ${cell([c.operation, c.path].filter(Boolean).join(" ") || c.section)} | ${cell(c.text)} |`,
      );
  };
  table("Perubahan memutus:", result.breaking);
  table("Peringatan (tidak memblokir):", result.warnings);
  if (result.verdict === "breaking-approved")
    lines.push(
      "",
      "Tindak lanjut wajib: catat di packages/contracts/CHANGELOG.md dengan penanda **[memutus]**, rilis aplikasi " +
        `>= ${head.minAppVersion} ke toko, lalu naikkan app_settings.min_app_version setelah versi itu dapat diunduh ` +
        "(PRD 8.4; runbook docs/runbooks/ci-cd.md).",
    );
  return lines.join("\n");
}
