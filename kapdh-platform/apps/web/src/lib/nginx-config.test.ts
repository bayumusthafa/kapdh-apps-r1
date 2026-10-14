import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROD_API_URL } from "./site";

/**
 * Regresi infra/nginx-web.conf (N-07) terhadap kebutuhan situs: CSP harus mengizinkan semua yang dipakai halaman
 * (API publik, foto anggota) dan tidak lebih; cache dipisah antara aset immutable dan shell dinamis.
 */
const conf = readFileSync(
  fileURLToPath(new URL("../../../../infra/nginx-web.conf", import.meta.url)),
  "utf8",
);

function header(name: string): string {
  const m = new RegExp(`add_header ${name} "([^"]*)" always;`).exec(conf);
  if (!m) throw new Error(`header ${name} tidak ada`);
  return m[1]!;
}

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map((parts) => [parts[0]!, parts.slice(1)]),
  );
}

/** Pencocokan host-source CSP sederhana ('self', skema+host, wildcard subdomain). */
function allows(sources: string[], origin: string, self = "https://kapdh.or.id"): boolean {
  const url = new URL(origin);
  return sources.some((s) => {
    if (s === "'self'") return url.origin === self;
    const m = /^(https?):\/\/(\*\.)?([^/:]+)$/.exec(s);
    if (!m || `${m[1]}:` !== url.protocol) return false;
    return m[2] ? url.hostname.endsWith(`.${m[3]}`) : url.hostname === m[3];
  });
}

describe("infra/nginx-web.conf", () => {
  const csp = directives(header("Content-Security-Policy"));

  it("N-07: CSP tanpa unsafe-inline/eval, tidak boleh dibingkai, default none", () => {
    expect(csp.get("default-src")).toEqual(["'none'"]);
    expect(csp.get("script-src")).toEqual(["'self'"]);
    expect(csp.get("style-src")).toEqual(["'self'"]);
    expect(csp.get("font-src")).toEqual(["'self'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'none'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(header("Content-Security-Policy")).not.toMatch(/unsafe-inline|unsafe-eval|\*;|\s\*\s/);
    expect(header("X-Frame-Options")).toBe("DENY");
  });

  it("CSP mengizinkan API produksi dan staging (subdomain kapdh.or.id) tetapi tidak origin lain", () => {
    const api = new URL(PROD_API_URL).origin;
    expect(allows(csp.get("connect-src")!, api)).toBe(true);
    expect(allows(csp.get("connect-src")!, "https://api.staging.kapdh.or.id")).toBe(true);
    expect(allows(csp.get("img-src")!, api)).toBe(true);
    expect(allows(csp.get("connect-src")!, "https://evil.example")).toBe(false);
    expect(allows(csp.get("connect-src")!, "http://api.kapdh.or.id")).toBe(false);
    expect(allows(csp.get("connect-src")!, "https://kapdh.or.id.evil.example")).toBe(false);
  });

  it("Permissions-Policy mematikan kamera, mikrofon, lokasi, pembayaran", () => {
    const pp = header("Permissions-Policy");
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) {
      expect(pp).toContain(`${feature}=()`);
    }
    expect(header("Referrer-Policy")).toBe("no-referrer");
    expect(header("X-Content-Type-Options")).toBe("nosniff");
  });

  it("cache: /_astro immutable, /kta dan /delete-account no-store, HTML lain no-cache", () => {
    expect(conf).toMatch(/~\^\/_astro\/\s+"public, max-age=31536000, immutable";/);
    expect(conf).toMatch(/~\^\/kta\(\/\|\$\)\s+"no-store";/);
    expect(conf).toMatch(/~\^\/delete-account\(\/\|\$\)\s+"no-store";/);
    expect(conf).toMatch(/default\s+"no-cache";/);
  });

  it("cache: nilai per path hanya untuk respons sukses; 404 /_astro/ saat rolling deploy selalu no-store", () => {
    const m = /map \$status \$kapdh_cache_control_final \{([^}]*)\}/.exec(conf);
    expect(m, "map $status tidak ada").not.toBeNull();
    const entries = new Map(
      m![1]!
        .split(";")
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length === 2)
        .map(([key, value]) => [key!, value!]),
    );
    expect(entries).toEqual(
      new Map([
        ["default", '"no-store"'],
        ["200", "$kapdh_cache_control"],
        ["206", "$kapdh_cache_control"],
        ["304", "$kapdh_cache_control"],
      ]),
    );
    expect(conf).toContain("add_header Cache-Control $kapdh_cache_control_final always;");
    expect(conf).not.toContain("add_header Cache-Control $kapdh_cache_control always;");
  });

  it("add_header hanya di tingkat server (tidak hilang karena add_header di location)", () => {
    const locations = conf.split(/\n\s*location\s/).slice(1);
    for (const block of locations) expect(block.split("\n}")[0]).not.toContain("add_header");
  });

  it("shell KTA, 404, gzip dan hanya GET/HEAD", () => {
    expect(conf).toContain("try_files /kta/index.html =404;");
    expect(conf).toContain("error_page 404 /404.html;");
    expect(conf).toMatch(/gzip on;/);
    expect(conf).toMatch(/gzip_types[^;]*application\/javascript/);
    expect(conf).toMatch(/gzip_types[^;]*text\/css/);
    expect(conf).toContain("if ($request_method !~ ^(GET|HEAD)$)");
    expect(conf).toContain("server_tokens off;");
  });
});
