// Uji pemeriksaan statis workflow (PRD 7.1 pin versi, secrets tidak bocor; N-16 rantai pasok).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { checkAll } from "../check-workflows.mjs";

const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
const ACTION = `name: Siapkan
description: uji
inputs:
  node-version:
    default: "24.19.0"
runs:
  using: composite
  steps:
    - shell: bash
      run: echo ok
`;

const roots = [];
function fixture(workflows, { dockerfile = "FROM node:24.19.0-alpine3.24@sha256:abc\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kapdh-cw-"));
  roots.push(root);
  const write = (p, text) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  };
  write(".github/actions/setup-platform/action.yml", ACTION);
  write("kapdh-platform/infra/Dockerfile.api", dockerfile);
  for (const [name, text] of Object.entries(workflows)) write(`.github/workflows/${name}`, text);
  return root;
}
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const good = `name: Uji
on: push
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - uses: ${CHECKOUT}
        with:
          persist-credentials: false
      - uses: ./.github/actions/setup-platform
      - env:
          SHA: \${{ github.sha }}
        run: echo "$SHA"
`;

const errorsOf = (workflows, opts) => checkAll({ repoRoot: fixture(workflows, opts) }).errors.join("\n");

describe("check-workflows", () => {
  it("repo nyata lulus", () => {
    const { errors } = checkAll();
    assert.deepEqual(errors, []);
  });

  it("workflow yang benar lulus", () => {
    assert.equal(errorsOf({ "ok.yml": good }), "");
  });

  it("action tidak dipin SHA atau tanpa komentar versi ditolak", () => {
    const text = good.replace(CHECKOUT, "actions/checkout@v7");
    assert.match(errorsOf({ "a.yml": text }), /wajib dipin ke SHA commit/);
    const noComment = good.replace(CHECKOUT, "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    assert.match(errorsOf({ "b.yml": noComment }), /komentar versi/);
  });

  it("injeksi skrip: ekspresi di blok run ditolak", () => {
    const text = good.replace('run: echo "$SHA"', "run: echo ${{ github.event.pull_request.title }}");
    assert.match(errorsOf({ "c.yml": text }), /blok run memuat/);
  });

  it("permissions, timeout, runner -latest, checkout tanpa persist-credentials dan needs asing ditolak", () => {
    const text = good
      .replace("permissions:\n  contents: read\n", "")
      .replace("    timeout-minutes: 5\n", "    needs: [hilang]\n")
      .replace("ubuntu-24.04", "ubuntu-latest")
      .replace("        with:\n          persist-credentials: false\n", "");
    const out = errorsOf({ "d.yml": text });
    for (const re of [
      /permissions tingkat atas/,
      /timeout-minutes/,
      /ubuntu-latest/,
      /persist-credentials/,
      /tidak dikenal hilang/,
    ])
      assert.match(out, re);
  });

  it("YAML dengan kunci ganda dan SHA berbeda untuk action yang sama ditolak", () => {
    assert.match(errorsOf({ "e.yml": `${good}permissions: {}\n` }), /YAML tidak valid/);
    const other = good.replace(
      "3d3c42e5aac5ba805825da76410c181273ba90b1",
      "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
    );
    assert.match(errorsOf({ "f.yml": good, "g.yml": other }), /dipin 9c091bb21b7c/);
  });

  it("versi node Dockerfile berbeda dengan Node CI ditolak; tanpa versi patch hanya peringatan", () => {
    assert.match(
      errorsOf({ "h.yml": good }, { dockerfile: "FROM node:24.21.0-alpine\n" }),
      /node 24\.21\.0 berbeda dengan Node CI 24\.19\.0/,
    );
    const r = checkAll({ repoRoot: fixture({ "i.yml": good }, { dockerfile: "FROM node:24-alpine\n" }) });
    assert.deepEqual(r.errors, []);
    assert.match(r.warnings.join("\n"), /belum dipin versi patch/);
  });
});
