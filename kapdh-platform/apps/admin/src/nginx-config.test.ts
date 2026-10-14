import { describe, expect, it } from "vitest";
import template from "../../../infra/nginx-admin.conf?raw";
import editorSource from "./components/ui/RichTextEditorImpl.tsx?raw";

/**
 * Regresi infra/nginx-admin.conf (N-07, PRD 5.2; temuan audit D3-07) terhadap kebutuhan web admin: CSP ketat yang
 * tetap mengizinkan apa yang dipakai aplikasi (API, QR data:, pratinjau blob:, kamera pemindai), tidak dapat
 * dibingkai, tanpa Referer untuk /invite#t=, dan cache index.html no-store. Hasil build diperiksa terpisah oleh
 * infra/scripts/admin-csp.mjs (Dockerfile.admin dan CI). Editor TipTap tidak boleh menyisipkan <style> saat runtime
 * (injectCSS: false; gaya dasar di tiptap-base.css), karena CSP ini akan menolaknya dan editor kehilangan
 * white-space ProseMirror.
 */
const API = "https://api.kapdh.or.id";
const conf = template.split("__KAPDH_API_ORIGIN__").join(API);

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

describe("infra/nginx-admin.conf", () => {
  const csp = directives(header("Content-Security-Policy"));

  it("templat memuat placeholder origin API yang diganti saat build image", () => {
    expect(template).toContain("__KAPDH_API_ORIGIN__");
    expect(conf).not.toContain("__KAPDH_API_ORIGIN__");
  });

  it("N-07: CSP tanpa unsafe-*, skrip/gaya hanya origin sendiri, tidak boleh dibingkai (clickjacking)", () => {
    expect(csp.get("default-src")).toEqual(["'none'"]);
    expect(csp.get("script-src")).toEqual(["'self'"]);
    expect(csp.get("style-src")).toEqual(["'self'"]);
    expect(csp.get("font-src")).toEqual(["'self'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'none'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(header("Content-Security-Policy")).not.toMatch(/unsafe-|\*|https:(\s|;|$)/);
    expect(header("X-Frame-Options")).toBe("DENY");
  });

  it("editor TipTap tidak menyisipkan <style> runtime; gaya dasar ProseMirror dibundel sebagai CSS", () => {
    expect(editorSource).toMatch(/injectCSS: false/);
    expect(editorSource).toMatch(/import "\.\/tiptap-base\.css";/);
  });

  it("CSP mengizinkan API (fetch, gambar berkas), QR data:, pratinjau unggahan blob: dan video pemindai", () => {
    expect(csp.get("connect-src")).toEqual(["'self'", API]);
    expect(csp.get("img-src")).toEqual(["'self'", "data:", "blob:", API]);
    expect(csp.get("media-src")).toEqual(["'self'", "blob:"]);
  });

  it("Permissions-Policy: kamera hanya origin sendiri (check-in QR); mikrofon, lokasi, pembayaran dimatikan", () => {
    const pp = header("Permissions-Policy");
    expect(pp).toContain("camera=(self)");
    for (const feature of ["microphone", "geolocation", "payment", "usb", "display-capture"])
      expect(pp).toContain(`${feature}=()`);
  });

  it("kontrak admin-auth: Referrer-Policy no-referrer untuk /invite#t=<token>; nosniff; COOP; noindex", () => {
    expect(header("Referrer-Policy")).toBe("no-referrer");
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(header("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("cache: index.html dan rute SPA no-store, /assets immutable; fallback SPA tidak menelan aset hilang", () => {
    expect(conf).toMatch(/default\s+"no-store";/);
    expect(conf).toMatch(/~\^\/assets\/\s+"public, max-age=31536000, immutable";/);
    expect(conf).toContain("try_files $uri /index.html;");
    expect(conf).toMatch(/location \^~ \/assets\/ \{\s+access_log off;\s+try_files \$uri =404;/);
  });

  it("cache: nilai immutable hanya untuk respons sukses; 404 aset saat rolling deploy selalu no-store", () => {
    const m = /map \$status \$kapdh_admin_cache_control \{([^}]*)\}/.exec(conf);
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
        ["200", "$kapdh_admin_cache"],
        ["206", "$kapdh_admin_cache"],
        ["304", "$kapdh_admin_cache"],
      ]),
    );
    expect(conf).toContain("add_header Cache-Control $kapdh_admin_cache_control always;");
    expect(conf).not.toContain("add_header Cache-Control $kapdh_admin_cache always;");
  });

  it("add_header hanya di tingkat server; hanya GET/HEAD; non-root port 8080", () => {
    const locations = conf.split(/\n\s*location\s/).slice(1);
    for (const block of locations) expect(block.split("\n    }")[0]).not.toContain("add_header");
    expect(conf).toContain("if ($request_method !~ ^(GET|HEAD)$)");
    expect(conf).toContain("listen 8080;");
    expect(conf).toContain("server_tokens off;");
  });
});
