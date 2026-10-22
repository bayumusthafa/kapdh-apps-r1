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

/** Entri `map $uri $<nama>` (kunci -> nilai berkutip) dalam urutan kemunculan. */
function uriMap(name: string): Map<string, string> {
  const m = new RegExp(`map \\$uri \\$${name} \\{([^}]*)\\}`).exec(conf);
  if (!m) throw new Error(`map $uri $${name} tidak ada`);
  return new Map(
    [...m[1]!.matchAll(/^\s*(\S+)\s+("[^"]*");$/gm)].map((e) => [e[1]!, e[2]!] as [string, string]),
  );
}

interface Location {
  modifier: "" | "=" | "~" | "~*" | "^~";
  pattern: string;
  /** Direktif di dalam blok, satu per baris tanpa indentasi. */
  body: string[];
  index: number;
}

/** Blok location tingkat server dalam urutan kemunculan. */
function locations(): Location[] {
  return [...conf.matchAll(/^ {4}location\s+(?:(=|~\*?|\^~)\s+)?(\S+)\s*\{\n([\s\S]*?)\n {4}\}/gm)].map(
    (m) => ({
      modifier: (m[1] ?? "") as Location["modifier"],
      pattern: m[2]!,
      body: m[3]!
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
      index: m.index,
    }),
  );
}

/**
 * Pemilihan location nginx: `=` persis, lalu awalan terpanjang (berhenti bila `^~`), lalu regex pertama yang cocok
 * dalam urutan berkas, selain itu awalan terpanjang.
 */
function resolveLocation(uri: string): Location {
  const all = locations();
  const exact = all.find((l) => l.modifier === "=" && l.pattern === uri);
  if (exact) return exact;
  const prefix = all
    .filter((l) => (l.modifier === "" || l.modifier === "^~") && uri.startsWith(l.pattern))
    .sort((a, b) => b.pattern.length - a.pattern.length)[0];
  if (prefix?.modifier === "^~") return prefix;
  const regex = all.find(
    (l) => l.modifier.startsWith("~") && new RegExp(l.pattern, l.modifier === "~*" ? "i" : "").test(uri),
  );
  const chosen = regex ?? prefix;
  if (!chosen) throw new Error(`tidak ada location untuk ${uri}`);
  return chosen;
}

const DOT_DENY = "/\\.";
const APP_REGEX = "^/app(/.*)?$";
const WELL_KNOWN = ["/.well-known/assetlinks.json", "/.well-known/apple-app-site-association"];

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

  it("berkas tersembunyi tetap ditolak; hanya dua berkas asosiasi tautan aplikasi persis yang dikecualikan", () => {
    expect(conf).toMatch(/\n {4}location ~ \/\\\. \{\n {8}return 404;\n {4}\}\n/);
    const dotDeny = locations().find((l) => l.modifier === "~" && l.pattern === DOT_DENY);
    expect(dotDeny?.body).toEqual(["return 404;"]);

    const wellKnown = locations().filter((l) => l.pattern.includes(".well-known"));
    expect(wellKnown.map((l) => `${l.modifier} ${l.pattern}`)).toEqual(WELL_KNOWN.map((path) => `= ${path}`));
    for (const location of wellKnown) {
      expect(location.body).toEqual(["types { }", "default_type application/json;", "try_files $uri =404;"]);
      expect(location.index).toBeLessThan(dotDeny!.index);
    }
    expect(conf).not.toMatch(/location\s+(\^~\s+)?\/\.well-known/);
    expect(conf).not.toMatch(/location\s+~\*?\s+[^\n{]*well-known/);
  });

  it("pemilihan location: dot path 404, berkas asosiasi dan /app dilayani, /apply tidak", () => {
    const expected: [string, string][] = [
      ["/.well-known/assetlinks.json", "/.well-known/assetlinks.json"],
      ["/.well-known/apple-app-site-association", "/.well-known/apple-app-site-association"],
      ["/.well-known/", DOT_DENY],
      ["/.well-known/acme-challenge/x", DOT_DENY],
      ["/.well-known/assetlinks.json/", DOT_DENY],
      ["/.well-known/security.txt", DOT_DENY],
      ["/.env", DOT_DENY],
      ["/.git/config", DOT_DENY],
      ["/app/.env", DOT_DENY],
      ["/app", APP_REGEX],
      ["/app/", APP_REGEX],
      ["/app/payments/x", APP_REGEX],
      ["/apply", "/"],
      ["/apps", "/"],
      ["/kta/25.01.01.1", "^/kta/[^/]+/?$"],
      ["/_astro/a.js", "/_astro/"],
    ];
    for (const [uri, pattern] of expected) expect(resolveLocation(uri).pattern, uri).toBe(pattern);
  });

  it("/app: shell /app/index.html, regex setelah penolakan dot path dan tidak cocok dengan /apply atau /apps", () => {
    const all = locations();
    const app = all.find((l) => l.pattern === APP_REGEX);
    expect(app?.modifier).toBe("~");
    expect(app?.body).toEqual(["try_files /app/index.html =404;"]);
    const dotDeny = all.find((l) => l.pattern === DOT_DENY)!;
    expect(app!.index).toBeGreaterThan(dotDeny.index);

    const re = new RegExp(app!.pattern);
    for (const uri of ["/app", "/app/", "/app/payments/x", "/app/forgot/otp"])
      expect(re.test(uri), uri).toBe(true);
    for (const uri of ["/apply", "/apps", "/application", "/app.json", "/xapp", "/kta/app"]) {
      expect(re.test(uri), uri).toBe(false);
    }
  });

  it("cache dan robots: berkas asosiasi 1 jam, /app no-store dan noindex (bukan /apply)", () => {
    const cache = uriMap("kapdh_cache_control");
    for (const path of WELL_KNOWN) expect(cache.get(path)).toBe('"public, max-age=3600"');
    const appKey = "~^/app(/|$)";
    expect(cache.get(appKey)).toBe('"no-store"');
    expect(uriMap("kapdh_robots").get(appKey)).toBe('"noindex, nofollow"');
    // $uri setelah try_files = /app/index.html, tetap tercakup.
    const re = new RegExp(appKey.slice(1));
    for (const uri of ["/app", "/app/index.html", "/app/payments/x"]) expect(re.test(uri), uri).toBe(true);
    for (const uri of ["/apply", "/apps", "/app.json"]) expect(re.test(uri), uri).toBe(false);
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
