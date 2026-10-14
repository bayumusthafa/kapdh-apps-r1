#!/usr/bin/env node
// Bukti bahwa sebuah commit sudah lulus pipeline staging (PRD 5.5: tag rilis hanya mempromosikan image yang lulus
// staging; PRD 9.3 gerbang rilis). Dipakai release.yml sebelum tag image vX.Y.Z dibuat.
//
// Status commit `kapdh/staging` TIDAK dipakai sebagai bukti: status bebas teks dapat ditulis token mana pun dengan
// statuses: write. Bukti yang diterima hanya run workflow `.github/workflows/deploy-staging.yml` yang:
//   - berjalan dari branch main (berkas workflow versi main, bukan salinan di branch lain),
//   - dipicu workflow_run (CI sukses di main) atau workflow_dispatch,
//   - berjudul tepat "Deploy staging <sha>" (run-name workflow itu),
//   - conclusion success, dan job "Deploy staging / ..." (migrasi, rollout Coolify, uji asap commit) success.
//
//   GH_TOKEN=... node infra/ci/staging-evidence.mjs --repo <owner/repo> --sha <40 hex>
// Keluar 0 bila bukti ada (mencetak URL run), 1 bila tidak ada, 2 galat masukan/API.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKFLOW_FILE = ".github/workflows/deploy-staging.yml";
export const RUN_TITLE_PREFIX = "Deploy staging ";
export const DEPLOY_JOB_PREFIX = "Deploy staging / ";
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_PAGES = 5;

export class EvidenceError extends Error {}

/** Run deploy-staging yang memenuhi syarat untuk sha (tanpa memeriksa job). */
export function qualifyingRuns(runs, sha) {
  return runs.filter(
    (r) =>
      r.display_title === `${RUN_TITLE_PREFIX}${sha}` &&
      r.head_branch === "main" &&
      typeof r.path === "string" &&
      r.path.split("@")[0] === WORKFLOW_FILE &&
      (r.event === "workflow_run" || r.event === "workflow_dispatch") &&
      r.status === "completed" &&
      r.conclusion === "success",
  );
}

/** Job deploy staging (reusable _deploy.yml dipanggil job "Deploy staging") sukses. */
export function deployJobSucceeded(jobs) {
  return jobs.some(
    (j) => typeof j.name === "string" && j.name.startsWith(DEPLOY_JOB_PREFIX) && j.conclusion === "success",
  );
}

export async function findEvidence({
  repo,
  sha,
  token,
  fetchImpl = fetch,
  apiUrl = "https://api.github.com",
}) {
  if (!REPO_RE.test(repo ?? "")) throw new EvidenceError("--repo wajib owner/repo");
  if (!SHA_RE.test(sha ?? "")) throw new EvidenceError("--sha wajib 40 heksadesimal");
  if (!token) throw new EvidenceError("GH_TOKEN kosong");
  const get = async (path) => {
    const res = await fetchImpl(`${apiUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new EvidenceError(`GitHub API ${path.split("?")[0]}: HTTP ${res.status}`);
    return res.json();
  };
  const workflow = encodeURIComponent(WORKFLOW_FILE.split("/").pop());
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await get(
      `/repos/${repo}/actions/workflows/${workflow}/runs?branch=main&status=success&per_page=100&page=${page}`,
    );
    const runs = body?.workflow_runs ?? [];
    for (const run of qualifyingRuns(runs, sha)) {
      const jobs = await get(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
      if (deployJobSucceeded(jobs?.jobs ?? [])) return run;
    }
    if (runs.length < 100) break;
  }
  return null;
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = fetch) {
  const sha = arg(argv, "--sha");
  const run = await findEvidence({
    repo: arg(argv, "--repo"),
    sha,
    token: env.GH_TOKEN,
    fetchImpl,
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
  });
  if (!run) {
    console.log(
      `::error title=Belum lulus staging::tidak ada run ${WORKFLOW_FILE} sukses dari main untuk ${sha} ` +
        "(migrasi, rollout dan uji asap commit). Deploy staging dulu (PRD 5.5).",
    );
    return 1;
  }
  console.log(`Bukti staging untuk ${sha}: run ${run.id} (${run.event}) ${run.html_url ?? ""}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(`::error title=staging-evidence::${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = e instanceof EvidenceError ? 2 : 1;
    },
  );
}
