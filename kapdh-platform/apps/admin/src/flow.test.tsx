import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAccessToken } from "./api/client";
import { authRequests, MOCK_CREDENTIALS, mockAuth } from "./api/mocks";
import { LOGOUT_CONFIRM_TIMEOUT_MS } from "./auth/session";
import { IDLE_WARNING_MS } from "./components/layout/AppShell";
import { findToast, renderApp, signIn } from "./test/utils";

afterEach(() => {
  vi.useRealTimers();
});

describe("alur masuk dan sesi admin (server tiruan)", () => {
  it("AC F02-2: login sandi lalu TOTP membuka dashboard dengan nama dan peran", async () => {
    const user = userEvent.setup();
    renderApp("/login");
    const nav = await signIn(user);
    expect(within(nav).getByRole("link", { name: /Dashboard/ })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText(/Masuk sebagai/)).toHaveTextContent("Masuk sebagai Bayu Musthafa (Super Admin)");
  });

  it("backup code dapat dipakai bila autentikator tidak tersedia", async () => {
    const user = userEvent.setup();
    renderApp("/login");
    expect(await signIn(user, { backup: true })).toBeInTheDocument();
  });

  it("menolak sandi salah tanpa membocorkan apakah email terdaftar", async () => {
    const user = userEvent.setup();
    renderApp("/login");
    await user.type(await screen.findByLabelText(/^Email/), MOCK_CREDENTIALS.email);
    await user.type(screen.getByLabelText(/^Kata sandi/), "salah-sekali");
    await user.click(screen.getByRole("button", { name: "Masuk" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Email atau kata sandi salah.");
    expect(screen.getByLabelText(/^Kata sandi/)).toHaveValue("");
  });

  it("validasi klien: email dan sandi wajib dengan pesan tertaut ke isian (N-11)", async () => {
    const user = userEvent.setup();
    renderApp("/login");
    await user.click(await screen.findByRole("button", { name: "Masuk" }));
    const email = screen.getByLabelText(/^Email/);
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAccessibleDescription("Email wajib diisi.");
    expect(screen.getByLabelText(/^Kata sandi/)).toHaveAccessibleDescription("Kata sandi wajib diisi.");
  });

  it("tombol tampilkan sandi mengganti tipe isian dan status aria-pressed", async () => {
    const user = userEvent.setup();
    renderApp("/login");
    const password = await screen.findByLabelText(/^Kata sandi/);
    const toggle = screen.getByRole("button", { name: "Tampilkan sandi" });
    expect(password).toHaveAttribute("type", "password");
    await user.click(toggle);
    expect(password).toHaveAttribute("type", "text");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("F-16: admin undangan yang belum aktif ditolak seperti sandi salah; login tidak membuka pendaftaran TOTP", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/login");
    await user.type(await screen.findByLabelText(/^Email/), MOCK_CREDENTIALS.invitedEmail);
    await user.type(screen.getByLabelText(/^Kata sandi/), MOCK_CREDENTIALS.password);
    await user.click(screen.getByRole("button", { name: "Masuk" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Email atau kata sandi salah.");
    expect(router.state.location.pathname).toBe("/login");
    expect(screen.queryByLabelText(/^Kode autentikator/)).toBeNull();
    expect(screen.getByText(/Minta undangan ulang ke Super Admin/)).toBeInTheDocument();
  });

  it("AC F02-2: kode TOTP salah tampil di isian kode beserta sisa percobaan; kode benar tetap diterima", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/login");
    await user.type(await screen.findByLabelText(/^Email/), MOCK_CREDENTIALS.email);
    await user.type(screen.getByLabelText(/^Kata sandi/), MOCK_CREDENTIALS.password);
    await user.click(screen.getByRole("button", { name: "Masuk" }));
    const code = await screen.findByLabelText(/^Kode autentikator/);
    await user.type(code, "000000");
    await user.click(screen.getByRole("button", { name: "Verifikasi" }));
    await waitFor(() => expect(code).toHaveAccessibleDescription(/salah\. Sisa percobaan 4\./));
    expect(code).toHaveAttribute("aria-invalid", "true");
    expect(code).toHaveValue("");
    expect(router.state.location.pathname).toBe("/login/mfa");
    await user.type(code, MOCK_CREDENTIALS.totp);
    await user.click(screen.getByRole("button", { name: "Verifikasi" }));
    expect(await screen.findByRole("navigation", { name: "Menu admin" })).toBeInTheDocument();
  });

  it("undangan admin memakai /invite#t=<token>: token di fragmen, bukan di path (kontrak admin-auth)", async () => {
    const { router } = renderApp("/invite#t=token-undangan-contoh-1234");
    expect(await screen.findByRole("heading", { name: "Undangan admin" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/invite");
  });

  it("penjaga rute: belum masuk ke /payments diarahkan ke /login dengan path kembali, lalu kembali setelah masuk", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/payments?tab=verify");
    expect(await screen.findByRole("heading", { name: "Selamat Datang Kembali!" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.matches.at(-1)?.search).toMatchObject({ redirect: "/payments?tab=verify" });
    await signIn(user);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Verifikasi Pembayaran" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/payments");
  });

  it("parameter redirect ke situs lain diabaikan (tidak ada open redirect)", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/login?redirect=%2F%2Fevil.example%2Fx");
    await screen.findByRole("heading", { name: "Selamat Datang Kembali!" });
    expect(router.state.matches.at(-1)?.search).not.toHaveProperty("redirect", "//evil.example/x");
    await signIn(user);
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("memulihkan sesi dari cookie refresh setelah halaman dimuat ulang", async () => {
    const user = userEvent.setup();
    const first = renderApp("/login");
    await signIn(user);
    first.unmount();
    setAccessToken(null); // access token di memori hilang saat reload

    renderApp("/payments");
    expect(await screen.findByRole("navigation", { name: "Menu admin" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Kata sandi/)).toBeNull();
  });

  it("keluar mencabut sesi server sehingga reload kembali ke halaman masuk", async () => {
    const user = userEvent.setup();
    const first = renderApp("/login");
    await signIn(user);
    await user.click(screen.getByRole("button", { name: "Keluar" }));
    expect(await screen.findByLabelText(/^Kata sandi/)).toBeInTheDocument();
    // Pencabutan server berjalan di latar setelah UI keluar.
    await waitFor(() => expect(mockAuth.isSessionActive()).toBe(false));
    first.unmount();

    renderApp("/payments");
    expect(await screen.findByLabelText(/^Kata sandi/)).toBeInTheDocument();
  });

  it("keluar tetap mencabut sesi walau access token sudah kedaluwarsa (refresh dulu, lalu logout)", async () => {
    const user = userEvent.setup();
    renderApp("/login");
    await signIn(user);
    mockAuth.expireAccessTokens(); // mis. laptop tertidur: token di memori sudah ditolak server
    await user.click(screen.getByRole("button", { name: "Keluar" }));
    expect(await screen.findByLabelText(/^Kata sandi/)).toBeInTheDocument();
    await waitFor(() => expect(mockAuth.isSessionActive()).toBe(false));
    const logouts = authRequests.filter((r) => r.path === "/auth/logout");
    expect(logouts.length).toBeGreaterThanOrEqual(1);
  });

  it("keluar membersihkan seluruh cache data admin sebelumnya", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderApp("/payments");
    await signIn(user);
    expect(await screen.findByRole("button", { name: /Ahmad Islam/ })).toBeInTheDocument();
    expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Keluar" }));
    await screen.findByLabelText(/^Kata sandi/);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it("sesi dicabut server (refresh ditolak) → kembali ke login dengan pesan sesi berakhir", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/login");
    await signIn(user);
    await user.click(screen.getByRole("link", { name: /Verifikasi Pembayaran/ }));
    await screen.findByRole("heading", { level: 1, name: "Verifikasi Pembayaran" });
    mockAuth.revokeSession();
    await user.click(screen.getByRole("link", { name: /Dashboard/ }));
    // Permintaan berikutnya 401 → refresh ditolak → onSessionExpired.
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByText("Sesi berakhir. Silakan masuk kembali.")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toEqual({ redirect: "/" });
  });

  it("AC F02-5: peringatan idle, 'Tetap masuk' mem-ping server TANPA header latar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp("/login");
    await signIn(user);
    await screen.findByRole("heading", { level: 1, name: "Dashboard" });

    await act(async () => {
      vi.advanceTimersByTime(30 * 60_000 - IDLE_WARNING_MS + 2_000);
    });
    const dialog = await screen.findByRole("alertdialog", { name: "Sesi akan berakhir" });
    // Polling berkala selama idle selalu berlabel latar sehingga tidak memperpanjang idle server.
    const before = authRequests.filter((r) => r.path === "/admin/me");
    expect(before.length).toBeGreaterThan(1);
    expect(before.slice(1).every((r) => r.background)).toBe(true);

    await user.click(within(dialog).getByRole("button", { name: "Tetap masuk" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const pings = authRequests.filter((r) => r.path === "/admin/me").slice(before.length);
    expect(pings).toContainEqual({ method: "GET", path: "/admin/me", background: false });
    expect(mockAuth.isSessionActive()).toBe(true);
  });

  it("AC F02-5: tanpa aktivitas sampai batas, admin dikeluarkan tepat sekali dan sesi server dicabut", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp("/login");
    await signIn(user);
    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    await act(async () => {
      vi.advanceTimersByTime(30 * 60_000 + 5_000);
    });
    expect(await screen.findByText(/tidak ada aktivitas selama 30 menit/)).toBeInTheDocument();
    expect(mockAuth.isSessionActive()).toBe(false);
    expect(authRequests.filter((r) => r.path === "/auth/logout")).toHaveLength(1);
  });

  it("menu seluler: aria-controls hanya saat laci terbuka, laci bernama teks, cincin fokus permukaan terang", async () => {
    const user = userEvent.setup();
    renderApp("/login");
    await signIn(user);
    const toggle = screen.getByRole("button", { name: "Menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");
    // Tombol berada di header putih: tidak di dalam permukaan gelap (cincin emas ~1,5:1 di atas putih).
    expect(toggle.closest('[data-surface="dark"]')).toBeNull();
    await user.click(toggle);
    const drawer = await screen.findByRole("dialog", { name: "Menu navigasi" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", "menu-seluler");
    expect(document.getElementById("menu-seluler")).not.toBeNull();
    // Logo di laci dekoratif (nama aplikasi tertulis di sebelahnya), tidak ikut dibacakan.
    expect(drawer.querySelector("img")).toHaveAttribute("alt", "");
    expect(within(drawer).queryByRole("img", { name: "Logo KAPDH" })).toBeNull();
  });

  it("keluar saat jaringan menggantung: data admin langsung disembunyikan, peringatan setelah batas tunggu", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { queryClient } = renderApp("/payments");
    await signIn(user);
    expect(await screen.findByRole("button", { name: /Ahmad Islam/ })).toBeInTheDocument();
    const release = mockAuth.holdLogout();
    await user.click(screen.getByRole("button", { name: "Keluar" }));
    // UI keluar tanpa menunggu server: halaman masuk tampil, cache data admin sudah kosong.
    expect(await screen.findByLabelText(/^Kata sandi/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ahmad Islam/ })).toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(LOGOUT_CONFIRM_TIMEOUT_MS + 500);
    });
    expect(await findToast("warning", "server belum mengonfirmasi")).toBeInTheDocument();
    // Koneksi pulih: pencabutan yang tertunda tetap diselesaikan.
    release();
    await waitFor(() => expect(mockAuth.isSessionActive()).toBe(false));
  });

  it("keluar: UI langsung keluar; bila server belum mengonfirmasi pencabutan, admin diperingatkan", async () => {
    const user = userEvent.setup();
    renderApp("/login");
    await signIn(user);
    // Access token ditolak dan penukaran cookie gagal 503 (deploy): pencabutan tidak dapat dipastikan.
    mockAuth.expireAccessTokens();
    mockAuth.failRefresh(503);
    await user.click(screen.getByRole("button", { name: "Keluar" }));
    expect(await screen.findByLabelText(/^Kata sandi/)).toBeInTheDocument();
    expect(await findToast("warning", "server belum mengonfirmasi")).toBeInTheDocument();
    expect(mockAuth.isSessionActive()).toBe(true);
  });

  it("URL tidak dikenal menampilkan halaman tidak ditemukan", async () => {
    renderApp("/tidak-ada-halaman");
    expect(await screen.findByText("Data tidak ditemukan")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ke halaman masuk" })).toBeInTheDocument();
  });
});

describe("menu dan rute berizin (AC F15-1, F16-3)", () => {
  it("super admin melihat semua grup menu; admin pembayaran hanya Dashboard dan Verifikasi Pembayaran", async () => {
    const user = userEvent.setup();
    const first = renderApp("/login");
    const nav = await signIn(user);
    for (const label of [
      "Manajemen Konten",
      "Manajemen Event & Tiket",
      "Manajemen Admin",
      "Manajemen Users",
      "Verifikasi Pembayaran",
      "Moderasi",
      "Audit",
      "Notifikasi",
      "Pengaturan",
    ])
      expect(within(nav).getByRole("link", { name: new RegExp(label) })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keluar" }));
    await screen.findByLabelText(/^Kata sandi/);
    first.unmount();

    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read", "payments.decide"] });
    renderApp("/login");
    const limited = await signIn(user);
    const links = within(limited)
      .getAllByRole("link")
      .map((a) => a.textContent?.replace(/\d+ pembayaran menunggu/, "").trim());
    expect(links).toEqual(["Dashboard", "Verifikasi Pembayaran"]);
    expect(screen.getByText(/Masuk sebagai/)).toHaveTextContent("(Admin)");
  });

  it("rute tanpa izin menampilkan Akses ditolak walau URL diketik langsung", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read"] });
    const user = userEvent.setup();
    renderApp("/admins");
    await signIn(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("Akses ditolak");
    expect(screen.queryByRole("heading", { level: 1, name: "Manajemen Admin" })).toBeNull();
  });

  it("admin check-in saja diarahkan grup Event langsung ke Check-in Tiket", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["events.checkin"] });
    const user = userEvent.setup();
    renderApp("/login");
    const nav = await signIn(user);
    await user.click(within(nav).getByRole("link", { name: /Manajemen Event & Tiket/ }));
    // Halaman pemindai (potongan kode lazy area events) lebih berat dari placeholder: beri waktu saat suite paralel.
    expect(
      await screen.findByRole("heading", { level: 1, name: "Check-in Tiket" }, { timeout: 5_000 }),
    ).toBeInTheDocument();
  });

  it("AC F16-3 (UI): izin dicabut Super Admin terlihat setelah muat ulang profil; halaman terkait tertutup", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read", "audit.read"] });
    const user = userEvent.setup();
    renderApp("/payments");
    const nav = await signIn(user);
    await screen.findByRole("heading", { level: 1, name: "Verifikasi Pembayaran" });
    mockAuth.setAdmin({ permissions: ["audit.read"] });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByText(/Izin akun Anda diperbarui/)).toBeInTheDocument();
    await waitFor(() =>
      expect(within(nav).queryByRole("link", { name: /Verifikasi Pembayaran/ })).toBeNull(),
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Akses ditolak" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /Audit/ })).toBeInTheDocument();
  });
});
