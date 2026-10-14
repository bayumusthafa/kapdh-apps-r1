#!/usr/bin/env node
// Pemeriksaan statis workflow GitHub Actions KAPDH (PRD 7.1 "secrets tidak masuk repo", pin versi; N-16 rantai pasok).
// Melengkapi actionlint (job `workflows` di CI) dengan aturan proyek, dan dapat dijalankan lokal tanpa Docker/Go:
//   node infra/ci/check-workflows.mjs            (dari kapdh-platform, setelah pnpm install)
// Aturan:
//   1. YAML valid tanpa kunci ganda: .github/workflows/*.yml, .github/actions/*/action.yml, .github/dependabot.yml.
//   2. Workflow: name, on, jobs dan `permissions` tingkat atas (least privilege) wajib ada.
//   3. Job: runs-on dengan image runner terpin (bukan *-latest) dan timeout-minutes; atau `uses` reusable lokal yang
//      ada, input wajibnya diisi dan tidak ada input asing. Setiap step tepat satu dari `uses`/`run`.
//   4. needs merujuk job yang ada, tanpa siklus.
//   5. Action pihak ketiga dipin ke SHA commit 40 heksadesimal dengan komentar versi (`# vX.Y.Z`), SHA yang sama
//      untuk action yang sama di semua berkas; docker:// wajib @sha256; action lokal harus ada.
//   6. actions/checkout menyatakan persist-credentials; `true` hanya untuk job dengan contents: write.
//   7. Blok `run` tidak memuat ekspresi `${{ }}` (nilai lewat env: mencegah injeksi skrip); `if` tidak merujuk secrets.
//   8. Ekspresi `${{ }}` seimbang; step `run` di composite action menyatakan `shell`.
//   9. Base image infra/Dockerfile.* dipin versi patch DAN digest (`nama:x.y.z-...@sha256:<64 hex>`, PRD 7.1), tag yang
//      sama memakai digest yang sama di semua Dockerfile, dan versi node sama dengan Node CI (setup-platform).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM_ROOT = resolve(HERE, "../..");
export const REPO_ROOT = resolve(PLATFORM_ROOT, "..");
// Paket `yaml` dipasang sebagai devDependency @kapdh/contracts (root kapdh-platform tidak mengeksposnya).
const { parseDocument } = createRequire(join(PLATFORM_ROOT, "packages/contracts/package.json"))("yaml");

const SHA_PIN = /^[^@\s]+@[0-9a-f]{40}$/;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function parseYamlFile(file, errors) {
  const doc = parseDocument(readFileSync(file, "utf8"), { uniqueKeys: true, prettyErrors: true });
  for (const e of doc.errors) errors.push(`${rel(file)}: YAML tidak valid: ${e.message.split("\n")[0]}`);
  return doc.errors.length === 0 ? doc.toJS() : null;
}

/** Akar repo yang diperiksa (dapat diganti uji lewat checkAll({repoRoot})). */
let ROOT = REPO_ROOT;
const rel = (p) => relative(ROOT, p).split("\\").join("/");

function walkStrings(node, visit, path = "") {
  if (typeof node === "string") visit(node, path);
  else if (Array.isArray(node)) node.forEach((v, i) => walkStrings(v, visit, `${path}[${i}]`));
  else if (isObject(node))
    for (const [k, v] of Object.entries(node)) walkStrings(v, visit, path ? `${path}.${k}` : k);
}

function checkExpressions(file, doc, errors) {
  walkStrings(doc, (s, path) => {
    const open = s.split("${{").length - 1;
    const close = s.split("}}").length - 1;
    if (open !== close) errors.push(`${rel(file)}: ${path}: ekspresi \${{ }} tidak seimbang`);
  });
}

/** Mengembalikan baris `uses:` mentah beserta komentar versinya. */
function rawUses(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)["']?\s*(?:#\s*(\S+))?/.exec(line);
    if (m) out.push({ ref: m[1], comment: m[2] ?? null });
  }
  return out;
}

function checkUses(file, text, pins, errors) {
  for (const { ref, comment } of rawUses(text)) {
    if (ref.startsWith("./")) {
      const target = join(ROOT, ref);
      const ok =
        ref.endsWith(".yml") || ref.endsWith(".yaml")
          ? existsSync(target)
          : existsSync(join(target, "action.yml"));
      if (!ok) errors.push(`${rel(file)}: action/workflow lokal ${ref} tidak ditemukan`);
      continue;
    }
    if (ref.startsWith("docker://")) {
      if (!/@sha256:[0-9a-f]{64}$/.test(ref))
        errors.push(`${rel(file)}: ${ref} wajib dipin @sha256:<digest>`);
      continue;
    }
    if (!SHA_PIN.test(ref)) {
      errors.push(`${rel(file)}: ${ref} wajib dipin ke SHA commit 40 heksadesimal (PRD 7.1)`);
      continue;
    }
    if (!comment || !/^v\d+(\.\d+){0,2}$/.test(comment))
      errors.push(`${rel(file)}: ${ref} wajib diberi komentar versi, mis. "# v1.2.3"`);
    const [name, sha] = ref.split("@");
    const seen = pins.get(name);
    if (seen && seen.sha !== sha)
      errors.push(
        `${rel(file)}: ${name} dipin ${sha.slice(0, 12)} sedangkan ${seen.file} memakai ${seen.sha.slice(0, 12)}`,
      );
    else if (!seen) pins.set(name, { sha, file: rel(file) });
  }
}

function checkSteps(file, where, steps, { composite, jobPermissions }, errors) {
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push(`${rel(file)}: ${where}: steps wajib berisi minimal satu step`);
    return;
  }
  steps.forEach((step, i) => {
    const at = `${where}.steps[${i}]${step?.name ? ` (${step.name})` : ""}`;
    const hasUses = typeof step?.uses === "string";
    const hasRun = typeof step?.run === "string";
    if (hasUses === hasRun) errors.push(`${rel(file)}: ${at}: wajib tepat satu dari uses atau run`);
    if (hasRun && step.run.includes("${{"))
      errors.push(`${rel(file)}: ${at}: blok run memuat \${{ }}; teruskan nilai lewat env (injeksi skrip)`);
    if (hasRun && composite && !step.shell)
      errors.push(`${rel(file)}: ${at}: step run composite wajib menyatakan shell`);
    if (typeof step?.if === "string" && /\bsecrets\./.test(step.if))
      errors.push(`${rel(file)}: ${at}: kondisi if tidak boleh merujuk secrets (petakan ke env dulu)`);
    if (hasUses && step.uses.startsWith("actions/checkout@")) {
      const persist = step.with?.["persist-credentials"];
      if (persist === undefined)
        errors.push(`${rel(file)}: ${at}: actions/checkout wajib menyatakan persist-credentials`);
      else if (String(persist) === "true" && jobPermissions?.contents !== "write")
        errors.push(`${rel(file)}: ${at}: persist-credentials true hanya untuk job dengan contents: write`);
    }
  });
}

function checkNeeds(file, jobs, errors) {
  const ids = new Set(Object.keys(jobs));
  const graph = new Map();
  for (const [id, job] of Object.entries(jobs)) {
    const needs = job?.needs === undefined ? [] : [job.needs].flat();
    for (const n of needs)
      if (!ids.has(n)) errors.push(`${rel(file)}: job ${id} membutuhkan job tidak dikenal ${n}`);
    graph.set(
      id,
      needs.filter((n) => ids.has(n)),
    );
  }
  const state = new Map();
  const visit = (id, stack) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "active") {
      errors.push(`${rel(file)}: siklus needs: ${[...stack, id].join(" -> ")}`);
      return;
    }
    state.set(id, "active");
    for (const n of graph.get(id)) visit(n, [...stack, id]);
    state.set(id, "done");
  };
  for (const id of ids) visit(id, []);
}

function checkReusableCall(file, id, job, errors) {
  if (!job.uses.startsWith("./")) {
    if (!SHA_PIN.test(job.uses))
      errors.push(`${rel(file)}: job ${id}: workflow reusable eksternal wajib dipin SHA`);
    return;
  }
  const target = join(ROOT, job.uses);
  if (!existsSync(target)) return; // dilaporkan checkUses
  const callee = parseDocument(readFileSync(target, "utf8")).toJS();
  const declared = callee?.on?.workflow_call?.inputs ?? {};
  const given = job.with ?? {};
  for (const [name, spec] of Object.entries(declared))
    if (spec?.required && !(name in given))
      errors.push(`${rel(file)}: job ${id}: input wajib ${name} untuk ${job.uses} kosong`);
  for (const name of Object.keys(given))
    if (!(name in declared))
      errors.push(`${rel(file)}: job ${id}: input ${name} tidak dideklarasikan ${job.uses}`);
}

function checkWorkflow(file, doc, errors) {
  for (const key of ["name", "on", "jobs"])
    if (!(key in doc)) errors.push(`${rel(file)}: kunci ${key} wajib ada`);
  if (!("permissions" in doc))
    errors.push(`${rel(file)}: permissions tingkat atas wajib ada (least privilege)`);
  const jobs = isObject(doc.jobs) ? doc.jobs : {};
  for (const [id, job] of Object.entries(jobs)) {
    if (!isObject(job)) {
      errors.push(`${rel(file)}: job ${id} tidak valid`);
      continue;
    }
    if (typeof job.uses === "string") {
      checkReusableCall(file, id, job, errors);
      continue;
    }
    if (job["runs-on"] === undefined) errors.push(`${rel(file)}: job ${id}: runs-on wajib ada`);
    if (typeof job["runs-on"] === "string" && /-latest$/.test(job["runs-on"]))
      errors.push(`${rel(file)}: job ${id}: pin image runner (mis. ubuntu-24.04), bukan ${job["runs-on"]}`);
    if (job["timeout-minutes"] === undefined)
      errors.push(`${rel(file)}: job ${id}: timeout-minutes wajib ada`);
    if (typeof job.if === "string" && /\bsecrets\./.test(job.if))
      errors.push(`${rel(file)}: job ${id}: kondisi if tidak boleh merujuk secrets`);
    const jobPermissions = isObject(job.permissions)
      ? job.permissions
      : isObject(doc.permissions)
        ? doc.permissions
        : {};
    checkSteps(file, `job ${id}`, job.steps, { composite: false, jobPermissions }, errors);
  }
  checkNeeds(file, jobs, errors);
}

function checkAction(file, doc, errors) {
  if (!doc?.name || !doc?.description) errors.push(`${rel(file)}: name dan description wajib ada`);
  if (doc?.runs?.using !== "composite") errors.push(`${rel(file)}: action lokal harus composite`);
  checkSteps(file, "runs", doc?.runs?.steps, { composite: true, jobPermissions: {} }, errors);
}

/** `repositori:tag@sha256:<64 hex>`; repositori boleh memuat namespace (`nginxinc/nginx-unprivileged`). */
const DIGEST_PIN = /^([a-z0-9][a-z0-9._/-]*):([A-Za-z0-9][A-Za-z0-9._-]*)@sha256:[0-9a-f]{64}$/;
const FROM_LINE = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/gim;
const PATCH_VERSION = /^(\d+\.\d+\.\d+)/;

/**
 * Base image Dockerfile infra: versi patch + digest (PRD 7.1, D7), digest konsisten per tag, node = Node CI.
 * Rujukan ke tahap sebelumnya (`FROM build`) dilewati.
 */
export function checkDockerfiles(files, ciNodeVersion, errors) {
  const pinned = new Map();
  for (const { name, text } of files) {
    const stages = new Set();
    for (const m of text.matchAll(FROM_LINE)) {
      const [, ref, alias] = m;
      const isStage = stages.has(ref.toLowerCase());
      if (alias) stages.add(alias.toLowerCase());
      if (isStage) continue;
      const pin = DIGEST_PIN.exec(ref);
      if (!pin) {
        errors.push(`infra/${name}: base image ${ref} wajib dipin nama:versi@sha256:<digest> (PRD 7.1, D7)`);
        continue;
      }
      const [, repo, tag] = pin;
      const version = PATCH_VERSION.exec(tag)?.[1];
      if (!version)
        errors.push(`infra/${name}: base image ${repo}:${tag} wajib berversi patch lengkap (x.y.z)`);
      const key = `${repo}:${tag}`;
      const seen = pinned.get(key);
      if (seen && seen.ref !== ref)
        errors.push(`infra/${name}: ${key} dipin digest berbeda dengan ${seen.file}; samakan`);
      else if (!seen) pinned.set(key, { ref, file: `infra/${name}` });
      if (repo === "node" && version && version !== ciNodeVersion)
        errors.push(
          `infra/${name}: node ${version} berbeda dengan Node CI ${ciNodeVersion} (setup-platform)`,
        );
    }
  }
}

function checkInfraDockerfiles(errors) {
  const action = parseDocument(
    readFileSync(join(ROOT, ".github/actions/setup-platform/action.yml"), "utf8"),
  ).toJS();
  const ci = action?.inputs?.["node-version"]?.default;
  const infra = join(ROOT, "kapdh-platform", "infra");
  const files = readdirSync(infra)
    .filter((f) => f.startsWith("Dockerfile"))
    .map((name) => ({ name, text: readFileSync(join(infra, name), "utf8") }));
  checkDockerfiles(files, ci, errors);
}

export function checkAll({ repoRoot = REPO_ROOT } = {}) {
  ROOT = repoRoot;
  const errors = [];
  const warnings = [];
  const pins = new Map();
  const gh = join(ROOT, ".github");
  const workflowsDir = join(gh, "workflows");
  const workflows = readdirSync(workflowsDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join(workflowsDir, f));
  const actionsDir = join(gh, "actions");
  const actions = existsSync(actionsDir)
    ? readdirSync(actionsDir)
        .map((d) => join(actionsDir, d, "action.yml"))
        .filter((f) => existsSync(f) && statSync(f).isFile())
    : [];
  for (const file of [...workflows, ...actions]) {
    const text = readFileSync(file, "utf8");
    const doc = parseYamlFile(file, errors);
    if (!doc) continue;
    checkExpressions(file, doc, errors);
    checkUses(file, text, pins, errors);
    if (workflows.includes(file)) checkWorkflow(file, doc, errors);
    else checkAction(file, doc, errors);
  }
  const dependabot = join(gh, "dependabot.yml");
  if (existsSync(dependabot)) parseYamlFile(dependabot, errors);
  checkInfraDockerfiles(errors);
  return { errors, warnings, files: workflows.length + actions.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, warnings, files } = checkAll();
  for (const w of warnings) console.log(`::warning title=check-workflows::${w}`);
  for (const e of errors) console.log(`::error title=check-workflows::${e}`);
  console.log(
    errors.length === 0
      ? `check-workflows: ${files} berkas lulus (${warnings.length} peringatan).`
      : `check-workflows: ${errors.length} galat.`,
  );
  process.exitCode = errors.length === 0 ? 0 : 1;
}
