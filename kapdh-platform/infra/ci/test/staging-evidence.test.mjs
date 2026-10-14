// Bukti staging untuk promosi rilis (PRD 5.5, 9.3): hanya run deploy-staging.yml dari main yang sukses, bukan status
// commit bebas teks.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deployJobSucceeded, EvidenceError, findEvidence, qualifyingRuns } from "../staging-evidence.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const run = (over = {}) => ({
  id: 11,
  display_title: `Deploy staging ${SHA}`,
  head_branch: "main",
  path: ".github/workflows/deploy-staging.yml",
  event: "workflow_run",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/o/r/actions/runs/11",
  ...over,
});
const jobs = (deploy = "success") => ({
  jobs: [
    { name: "Rencana deploy staging", conclusion: "success" },
    { name: "Deploy staging / Migrasi, rollout dan uji asap (staging)", conclusion: deploy },
  ],
});

function fakeApi(runsPages, jobsById) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization });
    const u = new URL(String(url));
    const m = /\/actions\/runs\/(\d+)\/jobs$/.exec(u.pathname);
    const body = m
      ? jobsById[m[1]]
      : { workflow_runs: runsPages[Number(u.searchParams.get("page")) - 1] ?? [] };
    return { ok: true, status: 200, json: async () => body };
  };
  return { calls, fetchImpl };
}

describe("bukti staging (release.yml)", () => {
  it("hanya run main, judul tepat, workflow deploy-staging, event sah, sukses", () => {
    const runs = [
      run(),
      run({ id: 12, head_branch: "fitur" }),
      run({ id: 13, display_title: `Deploy staging ${SHA.replace("0", "f")}` }),
      run({ id: 14, path: ".github/workflows/lain.yml" }),
      run({ id: 15, event: "push" }),
      run({ id: 16, conclusion: "failure" }),
      run({ id: 17, path: ".github/workflows/deploy-staging.yml@refs/heads/main" }),
    ];
    assert.deepEqual(
      qualifyingRuns(runs, SHA).map((r) => r.id),
      [11, 17],
    );
  });

  it("job deploy (migrasi, rollout, uji asap) wajib sukses", () => {
    assert.equal(deployJobSucceeded(jobs().jobs), true);
    assert.equal(deployJobSucceeded(jobs("skipped").jobs), false);
    assert.equal(deployJobSucceeded([]), false);
  });

  it("mencari lintas halaman dan memeriksa job; token dikirim sebagai Bearer", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      run({ id: 1000 + i, display_title: "Deploy staging x" }),
    );
    const { calls, fetchImpl } = fakeApi([page1, [run({ id: 21 }), run({ id: 22 })]], {
      21: jobs("skipped"),
      22: jobs("success"),
    });
    const found = await findEvidence({ repo: "o/r", sha: SHA, token: "tkn", fetchImpl });
    assert.equal(found.id, 22);
    assert.ok(calls.every((c) => c.auth === "Bearer tkn"));
    assert.match(calls[0].url, /actions\/workflows\/deploy-staging\.yml\/runs\?branch=main&status=success/);
  });

  it("tanpa run yang memenuhi syarat -> null; masukan tidak sah ditolak", async () => {
    const { fetchImpl } = fakeApi([[run({ conclusion: "failure" })]], {});
    assert.equal(await findEvidence({ repo: "o/r", sha: SHA, token: "t", fetchImpl }), null);
    await assert.rejects(findEvidence({ repo: "o/r", sha: "abc", token: "t", fetchImpl }), EvidenceError);
    await assert.rejects(findEvidence({ repo: "o r", sha: SHA, token: "t", fetchImpl }), EvidenceError);
    await assert.rejects(findEvidence({ repo: "o/r", sha: SHA, token: "", fetchImpl }), EvidenceError);
    await assert.rejects(
      findEvidence({
        repo: "o/r",
        sha: SHA,
        token: "t",
        fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
      }),
      /HTTP 403/,
    );
  });
});
