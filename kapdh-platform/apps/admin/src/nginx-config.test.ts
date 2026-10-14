import { describe, expect, it } from "vitest";
import conf from "../../../infra/nginx-admin.conf?raw";
import editorSource from "./components/ui/RichTextEditorImpl.tsx?raw";

/**
 * Regresi infra/nginx-admin.conf (N-07): CSP admin tanpa 'unsafe-inline' untuk skrip maupun gaya. Editor TipTap tidak
 * boleh menyisipkan <style> saat runtime (injectCSS: false; gaya dasar di tiptap-base.css), karena CSP ini akan
 * menolaknya dan editor kehilangan white-space ProseMirror.
 */
function csp(): Map<string, string[]> {
  const m = /add_header Content-Security-Policy "([^"]*)" always;/.exec(conf);
  if (!m) throw new Error("CSP tidak ada");
  return new Map(
    m[1]!
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map((parts) => [parts[0]!, parts.slice(1)]),
  );
}

describe("CSP web admin (infra/nginx-admin.conf, N-07)", () => {
  it("skrip dan gaya hanya dari origin sendiri, tanpa unsafe-inline/unsafe-eval", () => {
    const d = csp();
    expect(d.get("default-src")).toEqual(["'none'"]);
    expect(d.get("script-src")).toEqual(["'self'"]);
    expect(d.get("style-src")).toEqual(["'self'"]);
    const sources = [...d.values()].flat();
    expect(sources).not.toContain("'unsafe-inline'");
    expect(sources).not.toContain("'unsafe-eval'");
    expect(d.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("editor TipTap tidak menyisipkan <style> runtime; gaya dasar ProseMirror dibundel sebagai CSS", () => {
    expect(editorSource).toMatch(/injectCSS: false/);
    expect(editorSource).toMatch(/import "\.\/tiptap-base\.css";/);
  });

  it("nginx mendengar port 8080 (proses non-root, infra/nginx-main.conf)", () => {
    expect(conf).toMatch(/^\s*listen 8080;$/m);
  });
});
