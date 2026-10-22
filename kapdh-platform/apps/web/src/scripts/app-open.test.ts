// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { APP_SCHEME_ROOT, MAX_APP_LINK_LENGTH, appSchemeHref, mountAppOpen } from "./app-open";

describe("halaman cadangan /app: tujuan tombol Buka di aplikasi KAPDH", () => {
  it("meneruskan path setelah /app dan query ke skema kapdh://app", () => {
    expect(appSchemeHref("/app", "")).toBe("kapdh://app");
    expect(appSchemeHref("/app/", "")).toBe("kapdh://app");
    expect(appSchemeHref("/app/payments/0192a000-0000-7000-8000-000000000102", "")).toBe(
      "kapdh://app/payments/0192a000-0000-7000-8000-000000000102",
    );
    expect(appSchemeHref("/app/payments/x/", "")).toBe("kapdh://app/payments/x");
    expect(appSchemeHref("/app/forgot/otp", "?challenge=0192a000-0000-7000-8000-000000000102")).toBe(
      "kapdh://app/forgot/otp?challenge=0192a000-0000-7000-8000-000000000102",
    );
    expect(appSchemeHref("/app/events", "?q=halal%20bihalal&page=2")).toBe(
      "kapdh://app/events?q=halal%20bihalal&page=2",
    );
    expect(appSchemeHref("/app/events", "?")).toBe("kapdh://app/events");
  });

  it("path atau query yang tidak lolos penyaringan selalu ke kapdh://app", () => {
    const rejected: [string, string][] = [
      ["/apply", ""],
      ["/apps/x", ""],
      ["/kta/25.01.01.1", ""],
      ["/", ""],
      ["/APP/x", ""],
      ["/app//evil.example", ""],
      ["/app/../kta", ""],
      ["/app/./x", ""],
      ["/app/%2e%2e/x", ""],
      ["/app/a b", ""],
      ["/app/x:y", ""],
      ["/app/x", "?a=<script>"],
      ["/app/x", '?a="b"'],
      ["/app/x", "?a=%zz"],
      ["/app/x", "#t=abc"],
      ["/app/x", "?a=1#frag"],
    ];
    for (const [pathname, search] of rejected) {
      expect(appSchemeHref(pathname, search), `${pathname}${search}`).toBe(APP_SCHEME_ROOT);
    }
  });

  it("tautan lebih dari 2048 karakter tidak diteruskan", () => {
    const fits = `/app/${"a".repeat(MAX_APP_LINK_LENGTH - "kapdh://app/".length)}`;
    expect(appSchemeHref(fits, "")).toHaveLength(MAX_APP_LINK_LENGTH);
    expect(appSchemeHref(`${fits}a`, "")).toBe(APP_SCHEME_ROOT);
    expect(appSchemeHref("/app/x", `?q=${"a".repeat(MAX_APP_LINK_LENGTH)}`)).toBe(APP_SCHEME_ROOT);
  });

  it("memasang href tombol lewat properti", () => {
    document.body.innerHTML = '<a id="app-open" href="kapdh://app">Buka di aplikasi KAPDH</a>';
    const anchor = document.querySelector<HTMLAnchorElement>("#app-open")!;
    expect(mountAppOpen(anchor, { pathname: "/app/payments/9", search: "?tab=riwayat" })).toBe(
      "kapdh://app/payments/9?tab=riwayat",
    );
    expect(anchor.getAttribute("href")).toBe("kapdh://app/payments/9?tab=riwayat");
    mountAppOpen(anchor, { pathname: "/app/..%2f", search: "" });
    expect(anchor.getAttribute("href")).toBe(APP_SCHEME_ROOT);
  });
});
