// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountKtaPage } from "./kta-page";
import { API, apiError, fakeFetch, flush, json, networkError, type Handler } from "./testing";

const TOKEN = "eyJhbGciOiJIUzI1NiIsImtpZCI6IjEifQ.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
const CHECKED = "2026-10-13T03:15:00Z";
const MEMBER = {
  full_name: "Ahmad Islam",
  cohort_code: "KAPDH 25",
  member_number: "25.01.01.7",
  expires_at: "2027-05-20T00:00:00Z",
  avatar_url: "https://api.kapdh.or.id/api/v1/files/content/abc",
};

let root: HTMLElement;
let retry: HTMLButtonElement;

beforeEach(() => {
  document.body.innerHTML =
    '<div id="kta-result" role="status" aria-live="polite"></div><button id="kta-retry" hidden disabled>Coba lagi</button>';
  root = document.getElementById("kta-result")!;
  retry = document.getElementById("kta-retry") as HTMLButtonElement;
});

afterEach(() => {
  vi.useRealTimers();
});

function mount(
  handler: Handler | Handler[],
  location = { pathname: "/kta/25.01.01.7", hash: `#t=${TOKEN}` },
) {
  const f = fakeFetch({ "POST /public/kta/verify": handler });
  const page = mountKtaPage({
    doc: document,
    root,
    retryButton: retry,
    apiBase: API,
    getLocation: () => location,
    fetcher: f.fetcher,
  });
  return { page, f };
}

const resultKind = () => root.querySelector("[data-kta-result]")?.getAttribute("data-kta-result");

describe("shell /kta/{nomor} (F-06)", () => {
  it("audit: keadaan loading tidak menampilkan tombol coba lagi", async () => {
    let release: (r: Response) => void = () => {};
    const { page } = mount(() => new Promise<Response>((resolve) => (release = resolve)));
    const run = page.run();
    expect(resultKind()).toBe("loading");
    expect(root.getAttribute("aria-busy")).toBe("true");
    expect(retry.hidden).toBe(true);
    expect(retry.disabled).toBe(true);
    release(json(200, { result: "active", checked_at: CHECKED, expiring: false, member: MEMBER }));
    await run;
    expect(resultKind()).toBe("active");
    expect(root.getAttribute("aria-busy")).toBe("false");
    expect(retry.hidden).toBe(true);
  });

  it("AC F06-1: Aktif menampilkan nama, angkatan, nomor, masa berlaku, foto dan waktu periksa", async () => {
    const { page } = mount(() =>
      json(200, { result: "active", checked_at: CHECKED, expiring: false, member: MEMBER }),
    );
    await page.run();
    expect(root.textContent).toContain("Aktif");
    expect(root.textContent).toContain("Ahmad Islam");
    expect(root.textContent).toContain("KAPDH 25");
    expect(root.textContent).toContain("20 Mei 2027");
    expect(root.textContent).toContain("Diperiksa 13 Okt 2026, 10.15 WIB");
    const img = root.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(MEMBER.avatar_url);
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    // Status tidak hanya warna: lencana memuat ikon dan label teks (PRD 4.5).
    expect(root.querySelector("[data-kta-result] svg")).not.toBeNull();
  });

  it("AC F06-2: Tidak aktif dan Tidak ditemukan tetap menampilkan checked_at tanpa alasan privat", async () => {
    for (const result of ["inactive", "not_found"] as const) {
      const { page } = mount(() => json(200, { result, checked_at: CHECKED, expiring: false, member: null }));
      await page.run();
      expect(resultKind()).toBe(result);
      expect(root.textContent).toContain("Diperiksa 13 Okt 2026, 10.15 WIB");
      expect(root.querySelector("img")).toBeNull();
      expect(retry.hidden).toBe(true);
    }
  });

  it("AC F06-3: tautan rusak (percent-encoding salah) langsung QR tidak valid tanpa memanggil API", async () => {
    const { page, f } = mount(() => json(200, {}), { pathname: "/kta/%E0%A4%A", hash: `#t=${TOKEN}` });
    await page.run();
    expect(resultKind()).toBe("invalid");
    expect(root.textContent).toContain("QR tidak valid atau perlu diperbarui");
    expect(f.calls).toHaveLength(0);
    expect(retry.hidden).toBe(true);
  });

  it("AC F06-4: jaringan putus -> Tidak dapat memverifikasi + coba lagi; coba lagi memanggil ulang API", async () => {
    const { page, f } = mount([
      networkError,
      () => json(200, { result: "not_found", checked_at: CHECKED, expiring: false, member: null }),
    ]);
    await page.run();
    expect(resultKind()).toBe("unreachable");
    expect(root.textContent).toContain("Tidak dapat memverifikasi");
    expect(root.textContent).not.toContain("Tidak ditemukan");
    expect(retry.hidden).toBe(false);
    expect(retry.disabled).toBe(false);
    retry.click();
    await flush();
    expect(f.calls).toHaveLength(2);
    expect(resultKind()).toBe("not_found");
    expect(retry.hidden).toBe(true);
  });

  it("AC F06-4: 429 menahan coba lagi sampai retry_after_seconds habis", async () => {
    vi.useFakeTimers();
    const { page } = mount(() => apiError(429, "RATE_LIMITED", "Terlalu sering", { retry_after_seconds: 3 }));
    await page.run();
    expect(resultKind()).toBe("unreachable");
    expect(retry.hidden).toBe(false);
    expect(retry.disabled).toBe(true);
    expect(retry.textContent).toBe("Coba lagi (0:03)");
    await vi.advanceTimersByTimeAsync(2000);
    expect(retry.textContent).toBe("Coba lagi (0:01)");
    await vi.advanceTimersByTimeAsync(1000);
    expect(retry.disabled).toBe(false);
    expect(retry.textContent).toBe("Coba lagi");
  });

  it("menekan coba lagi berkali-kali tidak mengirim request paralel", async () => {
    let release: (r: Response) => void = () => {};
    const { page, f } = mount(() => new Promise<Response>((resolve) => (release = resolve)));
    const first = page.run();
    void page.run();
    void page.run();
    expect(f.calls).toHaveLength(1);
    release(json(200, { result: "inactive", checked_at: CHECKED, expiring: false, member: null }));
    await first;
  });

  it("/kta tanpa QR menampilkan petunjuk pindai tanpa memanggil API", async () => {
    const { page, f } = mount(() => json(200, {}), { pathname: "/kta/", hash: "" });
    await page.run();
    expect(resultKind()).toBe("missing");
    expect(root.textContent).toContain("Pindai QR pada KTA");
    expect(f.calls).toHaveLength(0);
  });

  it("nama anggota dirender sebagai teks, bukan HTML", async () => {
    const { page } = mount(() =>
      json(200, {
        result: "active",
        checked_at: CHECKED,
        expiring: false,
        member: { ...MEMBER, full_name: "<img src=x onerror=alert(1)>" },
      }),
    );
    await page.run();
    expect(root.querySelectorAll("img")).toHaveLength(1);
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
