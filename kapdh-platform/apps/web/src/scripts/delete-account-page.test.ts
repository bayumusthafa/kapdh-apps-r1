// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimedConfig } from "./config";
import { mountDeleteAccount } from "./delete-account-page";
import {
  CHALLENGE,
  DELETION,
  DISCLOSURE_WITH_WARNINGS,
  T0,
  VERIFIED_DELETABLE,
  VERIFIED_DISABLED,
  VERIFIED_IN_PROGRESS,
  iso,
} from "./fixtures";
import {
  API,
  apiError,
  fakeFetch,
  json,
  networkError,
  PUBLIC_CONFIG,
  response,
  text,
  type Handler,
} from "./testing";

let root: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  document.body.innerHTML = '<div id="del-app"></div>';
  root = document.getElementById("del-app")!;
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

const timed = (overrides: Partial<typeof PUBLIC_CONFIG> = {}, at = T0): Promise<TimedConfig> =>
  Promise.resolve({
    result: {
      ok: true,
      status: 200,
      data: { ...PUBLIC_CONFIG, server_time: new Date(at).toISOString(), ...overrides },
    },
    sentAt: Date.now(),
    receivedAt: Date.now(),
  });

function setup(routes: Record<string, Handler | Handler[]>, config: Promise<TimedConfig> = timed()) {
  const f = fakeFetch(routes);
  let n = 0;
  const app = mountDeleteAccount({
    doc: document,
    root,
    apiBase: API,
    fetcher: f.fetcher,
    newKey: () => `0192f6a0-0000-4000-8000-00000000000${++n}`,
    config,
  });
  return { f, app };
}

/** Menjalankan promise dan timer yang jatuh tempo sekarang. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
}

const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
const step = () => q("[data-step]")?.getAttribute("data-step");
const alertText = () => (q("[data-del-alert]")!.hidden ? "" : (q("[data-del-alert]")!.textContent ?? ""));
const primary = () => q<HTMLButtonElement>("[data-step] button[type=submit]")!;

async function submitEmail(email = "ahmad@email.com") {
  q<HTMLInputElement>("#del-email")!.value = email;
  primary().click();
  await settle();
}

async function submitCode(code = "123456") {
  const first = q<HTMLInputElement>("[data-otp-index='0']")!;
  first.value = code;
  first.dispatchEvent(new Event("input", { bubbles: true }));
  primary().click();
  await settle();
}

async function confirmChecked() {
  q<HTMLInputElement>("#del-ack")!.checked = true;
  primary().click();
  await settle();
}

const HAPPY: Record<string, Handler | Handler[]> = {
  "POST /public/deletion/challenge": () => json(202, CHALLENGE),
  "POST /public/deletion/verify": () => json(200, VERIFIED_DELETABLE),
  "POST /public/deletion/confirm": () => json(202, DELETION),
};

describe("/delete-account: alur web penghapusan akun (F-14)", () => {
  it("AC F14-1: email -> OTP -> pengungkapan dan konfirmasi eksplisit -> nomor permintaan tampil", async () => {
    const { f } = setup(HAPPY);
    await settle();
    expect(step()).toBe("email");

    await submitEmail("  ahmad@email.com ");
    expect(f.callsTo("POST /public/deletion/challenge")[0]!.body).toEqual({ email: "ahmad@email.com" });
    expect(step()).toBe("code");
    // Non-enumerasi (PRD 2.5): teks tidak menyatakan email terdaftar.
    expect(q("[data-step='code']")!.textContent).toContain("Bila ahmad@email.com terdaftar");
    expect(q("[data-attempts]")!.textContent).toBe("Sisa percobaan: 5 dari 5");
    expect(q("[data-expiry]")!.textContent).toBe("Kode berlaku 10:00 lagi.");

    await submitCode("123456");
    expect(f.callsTo("POST /public/deletion/verify")[0]!.body).toEqual({
      challenge_id: CHALLENGE.challenge_id,
      code: "123456",
    });
    expect(step()).toBe("confirm");
    const confirmText = q("[data-step='confirm']")!.textContent!;
    expect(confirmText).toContain("Konfirmasi penghapusan akun");
    expect(confirmText).toContain("Email dan sandi untuk masuk.");
    expect(confirmText).toContain("Jumlah, tanggal dan status pembayaran tanpa identitas.");
    expect(confirmText).toContain("Tidak ada periode retensi data pribadi");
    expect(confirmText).toContain("30 hari");
    const privacy = q<HTMLAnchorElement>("[data-step='confirm'] a[href='/kebijakan-privasi']")!;
    expect(privacy.textContent).toBe("Kebijakan Privasi versi 3");

    // Konfirmasi eksplisit wajib: tanpa centang tidak ada request.
    primary().click();
    await settle();
    expect(f.callsTo("POST /public/deletion/confirm")).toHaveLength(0);
    expect(q("#del-ack-error")!.hidden).toBe(false);

    await confirmChecked();
    const confirm = f.callsTo("POST /public/deletion/confirm")[0]!;
    expect(confirm.body).toEqual({
      deletion_token: VERIFIED_DELETABLE.deletion_token,
      confirm: true,
      acknowledged_disclosure_version: "v1-abc",
    });
    expect(confirm.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(step()).toBe("done");
    expect(q("[data-fact='Nomor permintaan']")!.textContent).toBe("DEL-2026-7K3Q9X");
    expect(q("[data-fact='Status']")!.textContent).toBe("Menunggu diproses");
    expect(q("[data-fact='Selesai paling lambat']")!.textContent).toBe("20 Oktober 2026");

    // Token penghapusan dan kode tidak pernah disimpan di storage atau URL.
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(location.href).not.toContain("deletion-token");
    expect(root.innerHTML).not.toContain(VERIFIED_DELETABLE.deletion_token!);
  });

  it("indikator langkah memakai aria-current dan label teks", async () => {
    setup(HAPPY);
    await settle();
    const items = () => Array.from(root.querySelectorAll(".del-step"));
    expect(items().map((i) => i.getAttribute("data-state"))).toEqual(["current", "todo", "todo", "todo"]);
    await submitEmail();
    expect(items().map((i) => i.getAttribute("data-state"))).toEqual(["done", "current", "todo", "todo"]);
    expect(items()[1]!.getAttribute("aria-current")).toBe("step");
    expect(items()[1]!.textContent).toContain("Verifikasi");
  });

  it("N-15/PRD 4.4: peringatan refund, tiket hangus dan pembayaran terbuka tampil sebelum konfirmasi", async () => {
    setup({
      ...HAPPY,
      "POST /public/deletion/verify": () =>
        json(200, { ...VERIFIED_DELETABLE, disclosure: DISCLOSURE_WITH_WARNINGS }),
    });
    await settle();
    await submitEmail();
    await submitCode();
    const warnings = Array.from(root.querySelectorAll("[data-warning]")).map((w) =>
      w.getAttribute("data-warning"),
    );
    expect(warnings).toEqual([
      "Refund belum ditransfer",
      "Tiket aktif akan hangus",
      "Pembayaran terbuka akan dibatalkan",
      "Grup chat yang Anda kelola sendiri",
      "Akun tertaut ke identitas pengurus",
    ]);
    expect(q("[data-warning='Refund belum ditransfer']")!.textContent).toContain("Rp75.000");
    expect(q("[data-warning='Refund belum ditransfer']")!.getAttribute("role")).toBe("note");
  });

  it("pendaftaran pending_otp: teks pembatalan pendaftaran", async () => {
    const { f } = setup({
      ...HAPPY,
      "POST /public/deletion/verify": () => json(200, { ...VERIFIED_DELETABLE, registration_pending: true }),
    });
    await settle();
    await submitEmail();
    await submitCode();
    expect(q("h2")!.textContent).toBe("Batalkan pendaftaran dan hapus data");
    expect(primary().textContent).toBe("Batalkan pendaftaran dan hapus data");
    await confirmChecked();
    expect(f.callsTo("POST /public/deletion/confirm")).toHaveLength(1);
    expect(q("h2")!.textContent).toBe("Pendaftaran dibatalkan");
  });

  it("PRD 2.2: akun deletion_pending -> pemeriksaan status menampilkan nomor dan status permintaan", async () => {
    const { f } = setup({ ...HAPPY, "POST /public/deletion/verify": () => json(200, VERIFIED_IN_PROGRESS) });
    await settle();
    await submitEmail();
    await submitCode();
    expect(step()).toBe("status");
    expect(q("[data-fact='Nomor permintaan']")!.textContent).toBe("DEL-2026-7K3Q9X");
    expect(q("[data-fact='Status']")!.textContent).toBe("Sedang diproses");
    expect(q("[data-fact='Diajukan lewat']")!.textContent).toBe("Aplikasi KAPDH");
    expect(root.querySelector(".del-steps")!.hasAttribute("hidden")).toBe(true);
    expect(root.querySelector("#del-ack")).toBeNull();
    expect(f.callsTo("POST /public/deletion/confirm")).toHaveLength(0);
  });

  it("PRD 2.2: akun disabled diarahkan ke kanal bantuan dari konfigurasi", async () => {
    setup(
      { ...HAPPY, "POST /public/deletion/verify": () => json(200, VERIFIED_DISABLED) },
      timed({ support: { email: "pengurus@kapdh.or.id", whatsapp: "081234567890" } }),
    );
    await settle();
    await submitEmail();
    await submitCode();
    expect(step()).toBe("disabled");
    expect(q<HTMLAnchorElement>("a[data-support-email]")!.href).toBe("mailto:pengurus@kapdh.or.id");
    expect(q<HTMLAnchorElement>("[data-support-whatsapp] a")!.href).toBe("https://wa.me/6281234567890");
  });

  it("validasi email di klien tidak mengirim request", async () => {
    const { f } = setup(HAPPY);
    await settle();
    await submitEmail("bukan-email");
    expect(f.calls).toHaveLength(0);
    expect(q("#del-email-error")!.textContent).toBe("Format email belum benar.");
    expect(q("#del-email")!.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("kode OTP: percobaan, kedaluwarsa, kirim ulang", () => {
  it("kode salah (400): pesan server dengan sisa percobaan, kotak dikosongkan, sisa percobaan berkurang", async () => {
    setup({
      ...HAPPY,
      "POST /public/deletion/verify": () =>
        apiError(400, "VALIDATION_ERROR", "Kode salah", {
          field_errors: { code: ["Kode salah. Sisa percobaan 4."] },
        }),
    });
    await settle();
    await submitEmail();
    await submitCode("000000");
    expect(step()).toBe("code");
    expect(q("#del-code-error")!.textContent).toBe("Kode salah. Sisa percobaan 4.");
    expect(q("[data-attempts]")!.textContent).toBe("Sisa percobaan: 4 dari 5");
    expect(q<HTMLInputElement>("[data-otp-index='0']")!.value).toBe("");
    expect(q("[data-otp-index='0']")!.getAttribute("aria-invalid")).toBe("true");
  });

  it("kirim ulang tertahan cooldown 60 detik lalu mengganti challenge (kode lama batal)", async () => {
    const renewed = {
      ...CHALLENGE,
      challenge_id: "0192f6a0-1111-7000-8000-000000000002",
      expires_at: iso(70_000 + 600_000),
      resend_available_at: iso(130_000),
    };
    const { f } = setup({ ...HAPPY, "POST /auth/otp/resend": () => json(200, renewed) });
    await settle();
    await submitEmail();
    const resend = q<HTMLButtonElement>("[data-resend]")!;
    expect(resend.disabled).toBe(true);
    expect(resend.textContent).toBe("Kirim ulang dalam 1:00");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resend.textContent).toBe("Kirim ulang dalam 0:30");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(resend.disabled).toBe(false);
    resend.click();
    await settle();
    expect(f.callsTo("POST /auth/otp/resend")[0]!.body).toEqual({ challenge_id: CHALLENGE.challenge_id });
    expect(q("[data-del-notice]")!.textContent).toContain("Kode baru sudah dikirim");
    await submitCode("654321");
    expect(f.callsTo("POST /public/deletion/verify")[0]!.body).toEqual({
      challenge_id: renewed.challenge_id,
      code: "654321",
    });
  });

  it("410 OTP_EXPIRED saat verifikasi: minta kode baru; sisa percobaan 0", async () => {
    setup({
      ...HAPPY,
      "POST /public/deletion/verify": () => apiError(410, "OTP_EXPIRED", "Kode tidak berlaku"),
    });
    await settle();
    await submitEmail();
    await submitCode();
    expect(step()).toBe("code");
    expect(q("#del-code-error")!.textContent).toContain("Minta kode baru");
    expect(q("[data-attempts]")!.textContent).toBe("Sisa percobaan: 0 dari 5");
  });

  it("410 saat kirim ulang: kembali ke langkah email dengan email terisi", async () => {
    setup({ ...HAPPY, "POST /auth/otp/resend": () => apiError(410, "OTP_EXPIRED", "x") });
    await settle();
    await submitEmail("ahmad@email.com");
    await vi.advanceTimersByTimeAsync(61_000);
    q<HTMLButtonElement>("[data-resend]")!.click();
    await settle();
    expect(step()).toBe("email");
    expect(q<HTMLInputElement>("#del-email")!.value).toBe("ahmad@email.com");
    expect(alertText()).toContain("Masukkan email Anda lagi");
  });

  it("kode kedaluwarsa setelah 10 menit ditampilkan tanpa mengunci verifikasi (server yang memutuskan)", async () => {
    setup(HAPPY);
    await settle();
    await submitEmail();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(q("[data-expiry]")!.textContent).toBe(
      "Kode sudah kedaluwarsa. Kirim ulang untuk mendapatkan kode baru.",
    );
    expect(primary().disabled).toBe(false);
  });

  it("jam perangkat menyimpang 2 jam tanpa konfigurasi: hitung mundur tetap 10:00 dan 1:00", async () => {
    vi.setSystemTime(T0 + 2 * 3600_000);
    setup(
      { ...HAPPY, "GET /public/config": networkError },
      Promise.resolve({
        result: { ok: false, kind: "network", status: 0, error: null, retryAfterSeconds: null },
        sentAt: 0,
        receivedAt: 0,
      }),
    );
    await settle();
    await submitEmail();
    expect(q("[data-expiry]")!.textContent).toBe("Kode berlaku 10:00 lagi.");
    expect(q<HTMLButtonElement>("[data-resend]")!.textContent).toBe("Kirim ulang dalam 1:00");
  });

  it("Ubah email kembali ke langkah email", async () => {
    setup(HAPPY);
    await settle();
    await submitEmail("ahmad@email.com");
    Array.from(root.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Ubah alamat email"))!
      .click();
    await settle();
    expect(step()).toBe("email");
    expect(q<HTMLInputElement>("#del-email")!.value).toBe("ahmad@email.com");
  });
});

describe("galat jaringan, 429 dan respons non-JSON", () => {
  it("429 pada challenge: hitung mundur retry-after menahan tombol lalu membukanya", async () => {
    const { f } = setup({
      ...HAPPY,
      "POST /public/deletion/challenge": [
        () => apiError(429, "RATE_LIMITED", "Terlalu sering", { retry_after_seconds: 30 }),
        () => json(202, CHALLENGE),
      ],
    });
    await settle();
    await submitEmail();
    expect(step()).toBe("email");
    expect(alertText()).toContain("Coba lagi dalam 0:30");
    expect(primary().disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(primary().disabled).toBe(false);
    expect(alertText()).toBe("Silakan coba lagi sekarang.");
    await submitEmail();
    expect(step()).toBe("code");
    expect(f.callsTo("POST /public/deletion/challenge")).toHaveLength(2);
  });

  it("429 tanpa body JSON memakai header Retry-After, atau 60 detik bila header pun tidak ada", async () => {
    setup({
      ...HAPPY,
      "POST /public/deletion/challenge": [
        () => response(429, "Too Many Requests", { "content-type": "text/plain", "retry-after": "45" }),
        () => text(429, "Too Many Requests", "text/plain"),
      ],
    });
    await settle();
    await submitEmail();
    expect(alertText()).toContain("Coba lagi dalam 0:45");
    await vi.advanceTimersByTimeAsync(45_000);
    await submitEmail();
    expect(alertText()).toContain("Coba lagi dalam 1:00");
  });

  it("502 HTML dari proxy dan jaringan putus: pesan aman, input email tetap tersimpan", async () => {
    setup({
      ...HAPPY,
      "POST /public/deletion/challenge": [() => text(502, "<html>Bad Gateway</html>"), networkError],
    });
    await settle();
    await submitEmail("ahmad@email.com");
    expect(alertText()).toContain("Server KAPDH sedang bermasalah");
    expect(alertText()).not.toContain("<html>");
    await submitEmail("ahmad@email.com");
    expect(alertText()).toContain("Tidak dapat menghubungi server KAPDH");
    expect(q<HTMLInputElement>("#del-email")!.value).toBe("ahmad@email.com");
    expect(primary().disabled).toBe(false);
  });

  it("verify mengembalikan bentuk di luar kontrak -> dianggap gagal, tetap di langkah kode", async () => {
    setup({ ...HAPPY, "POST /public/deletion/verify": () => json(200, { deletable: true }) });
    await settle();
    await submitEmail();
    await submitCode();
    expect(step()).toBe("code");
    expect(alertText()).toContain("Tidak dapat menghubungi server KAPDH");
  });

  it("jaringan putus saat verifikasi: kode tetap terisi dan sisa percobaan tidak berkurang; coba lagi berhasil", async () => {
    const { f } = setup({
      ...HAPPY,
      "POST /public/deletion/verify": [networkError, () => json(200, VERIFIED_DELETABLE)],
    });
    await settle();
    await submitEmail();
    await submitCode("123456");
    expect(step()).toBe("code");
    expect(q<HTMLInputElement>("[data-otp-index='5']")!.value).toBe("6");
    expect(q("[data-attempts]")!.textContent).toBe("Sisa percobaan: 5 dari 5");
    primary().click();
    await settle();
    expect(f.callsTo("POST /public/deletion/verify")).toHaveLength(2);
    expect(step()).toBe("confirm");
  });

  it("tombol dimatikan selama request berjalan dan dinyalakan kembali setelahnya", async () => {
    let release: (r: Response) => void = () => {};
    setup({
      ...HAPPY,
      "POST /public/deletion/verify": () => new Promise<Response>((resolve) => (release = resolve)),
    });
    await settle();
    await submitEmail();
    const change = Array.from(root.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Ubah alamat email"),
    )!;
    const first = q<HTMLInputElement>("[data-otp-index='0']")!;
    first.value = "123456";
    first.dispatchEvent(new Event("input", { bubbles: true }));
    primary().click();
    await settle();
    expect(primary().disabled).toBe(true);
    expect(primary().textContent).toBe("Memverifikasi…");
    expect(change.disabled).toBe(true);
    expect(root.getAttribute("aria-busy")).toBe("true");
    release(
      apiError(400, "VALIDATION_ERROR", "x", { field_errors: { code: ["Kode salah. Sisa percobaan 4."] } }),
    );
    await settle();
    expect(primary().disabled).toBe(false);
    expect(primary().textContent).toBe("Verifikasi");
    expect(change.disabled).toBe(false);
  });
});

describe("konfirmasi: idempotensi, konflik versi, token kedaluwarsa", () => {
  it("jaringan putus saat konfirmasi: coba lagi memakai Idempotency-Key yang sama (tidak membuat dua permintaan)", async () => {
    const { f } = setup({
      ...HAPPY,
      "POST /public/deletion/confirm": [networkError, () => json(202, DELETION)],
    });
    await settle();
    await submitEmail();
    await submitCode();
    await confirmChecked();
    expect(step()).toBe("confirm");
    expect(alertText()).toContain("tidak akan dibuat dua kali");
    primary().click();
    await settle();
    const calls = f.callsTo("POST /public/deletion/confirm");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers["idempotency-key"]).toBe(calls[1]!.headers["idempotency-key"]);
    expect(step()).toBe("done");
  });

  it("409 VERSION_CONFLICT: pengungkapan terbaru ditampilkan, centang direset, versi dan key baru dipakai", async () => {
    const { f } = setup({
      ...HAPPY,
      "POST /public/deletion/confirm": [
        () => apiError(409, "VERSION_CONFLICT", "Berubah", { current: DISCLOSURE_WITH_WARNINGS }),
        () => json(202, DELETION),
      ],
    });
    await settle();
    await submitEmail();
    await submitCode();
    await confirmChecked();
    expect(step()).toBe("confirm");
    expect(alertText()).toContain("Rincian akun Anda berubah");
    expect(root.querySelector("[data-warning='Refund belum ditransfer']")).not.toBeNull();
    expect(q<HTMLInputElement>("#del-ack")!.checked).toBe(false);
    await confirmChecked();
    const calls = f.callsTo("POST /public/deletion/confirm");
    expect(
      (calls[1]!.body as { acknowledged_disclosure_version: string }).acknowledged_disclosure_version,
    ).toBe("v2-warn");
    expect(calls[1]!.headers["idempotency-key"]).not.toBe(calls[0]!.headers["idempotency-key"]);
    expect(step()).toBe("done");
  });

  it("410 saat konfirmasi (token kedaluwarsa/dipakai): kembali verifikasi email", async () => {
    setup({ ...HAPPY, "POST /public/deletion/confirm": () => apiError(410, "OTP_EXPIRED", "x") });
    await settle();
    await submitEmail("ahmad@email.com");
    await submitCode();
    await confirmChecked();
    expect(step()).toBe("email");
    expect(alertText()).toContain("Verifikasi email Anda lagi");
    expect(q<HTMLInputElement>("#del-email")!.value).toBe("ahmad@email.com");
  });

  it("hitung mundur 10 menit token konfirmasi", async () => {
    setup(HAPPY);
    await settle();
    await submitEmail();
    await submitCode();
    expect(q("[data-token-expiry]")!.textContent).toBe(
      "Konfirmasi dalam 10:00 sebelum verifikasi email berakhir.",
    );
    await vi.advanceTimersByTimeAsync(600_000);
    expect(q("[data-token-expiry]")!.textContent).toContain("sudah habis");
  });

  it("Batal: kembali ke awal tanpa request konfirmasi", async () => {
    const { f } = setup(HAPPY);
    await settle();
    await submitEmail();
    await submitCode();
    Array.from(root.querySelectorAll("button"))
      .find((b) => b.textContent === "Batal")!
      .click();
    await settle();
    expect(step()).toBe("email");
    expect(q("[data-del-notice]")!.textContent).toContain("Akun Anda tidak berubah");
    expect(f.callsTo("POST /public/deletion/confirm")).toHaveLength(0);
  });

  it("503 MAINTENANCE saat konfirmasi menampilkan pesan pemeliharaan", async () => {
    setup({
      ...HAPPY,
      "POST /public/deletion/confirm": () => apiError(503, "MAINTENANCE", "Layanan sedang pemeliharaan."),
    });
    await settle();
    await submitEmail();
    await submitCode();
    await confirmChecked();
    expect(step()).toBe("confirm");
    expect(alertText()).toContain("Layanan sedang pemeliharaan.");
  });
});
