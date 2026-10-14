import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { findToast, renderApp } from "../test/utils";
import { adminApi, advanceServerClock, live, proofFile, signInLive, totpCode } from "./fixtures";
import { cookieNames, cookieValue, rawFetch } from "./http";

/**
 * Web admin terhadap API hasil merge (temuan audit D2-14; PRD 7.3: mock bukan bukti AC). Halaman React, router,
 * sesi dan klien openapi-fetch yang sama dengan build produksi berbicara HTTP dengan apps/api/dist di port lokal
 * (PGlite + seed dev, live/api-server.mjs). Uji ini membuktikan bahwa klausa UI yang di jalur bawaan hanya diuji
 * terhadap server tiruan (src/api/mocks) juga berlaku terhadap server sungguhan: login dua tahap dan pemulihan sesi
 * (AC F02-1, F02-2), peringatan idle dan "Tetap masuk" serta idle 30 menit (AC F02-5), keputusan bersamaan
 * (AC F04-3), serta pencatatan iuran D13 dan tautan payment dari detail anggota (temuan D6-01, D6-02).
 *
 * Satu API dan satu database untuk seluruh berkas: urutan uji di bawah disengaja (idle terakhir).
 */

describe("web admin x API nyata (D2-14)", () => {
  it("AC F02-1, F02-2: login sandi + TOTP; kode salah ditolak dengan sisa percobaan; sesi pulih dari cookie refresh", async () => {
    const user = userEvent.setup();
    const admin = live().admins.super;
    const first = renderApp("/login");
    await user.type(await screen.findByLabelText(/^Email/), admin.email);
    await user.type(screen.getByLabelText(/^Kata sandi/), admin.password);
    await user.click(screen.getByRole("button", { name: "Masuk" }));
    // Kode salah: galat formulir dari server (400, sisa percobaan), mfa_token tetap berlaku.
    const correct = await totpCode("super");
    await user.type(
      await screen.findByLabelText(/^Kode autentikator/),
      correct === "000000" ? "111111" : "000000",
    );
    await user.click(screen.getByRole("button", { name: "Verifikasi" }));
    expect(await screen.findByText(/Kode salah\. Sisa percobaan \d+\./)).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/^Kode autentikator/));
    await user.type(screen.getByLabelText(/^Kode autentikator/), correct);
    await user.click(screen.getByRole("button", { name: "Verifikasi" }));
    const nav = await screen.findByRole("navigation", { name: "Menu admin" });
    expect(within(nav).getByRole("link", { name: /Verifikasi Pembayaran/ })).toBeInTheDocument();
    expect((await screen.findAllByText(admin.name)).length).toBeGreaterThan(0);
    // Cookie refresh HttpOnly diterbitkan server pada path /api/v1/auth (PRD 5.2), bukan token di localStorage.
    expect(cookieNames()).toContain("kapdh_admin_rt");
    expect(Object.keys(window.localStorage).some((k) => /token/i.test(k))).toBe(false);

    // "Muat ulang": aplikasi baru tanpa access token di memori memulihkan sesi lewat cookie refresh.
    first.unmount();
    const { setAccessToken } = await import("../api/client");
    setAccessToken(null);
    renderApp("/payments");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Verifikasi Pembayaran" }, { timeout: 30_000 }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Kata sandi/)).toBeNull();
  });

  it("AC F04-3: admin lain memutus lebih dulu lewat API → UI menerima 409, memuat status terbaru dan tidak memutus dua kali", async () => {
    const { pending } = live().alumni;
    const user = userEvent.setup();
    renderApp("/payments");
    await signInLive(user);
    await user.click(await screen.findByRole("button", { name: new RegExp(escape(pending.name)) }));
    const panel = await screen.findByRole("article", { name: pending.name });
    expect(await within(panel).findByRole("img", { name: /Bukti transfer/ })).toBeInTheDocument();
    await user.click(within(panel).getByRole("checkbox", { name: /dana Rp60\.000 sudah masuk/ }));

    // Admin Keuangan menyetujui payment yang sama lebih dulu (versi yang sama dengan yang dilihat UI).
    const treasurer = await adminApi("treasurer");
    const seen = await treasurer.GET("/admin/payments/{paymentId}", {
      params: { path: { paymentId: pending.paymentId } },
    });
    expect(seen.data?.stage).toBe("awaiting_review");
    const approved = await treasurer.POST("/admin/payments/{paymentId}/decision", {
      params: { path: { paymentId: pending.paymentId }, header: { "Idempotency-Key": crypto.randomUUID() } },
      body: {
        decision: "approve",
        funds_verified: true,
        expected_proof_version: seen.data!.proof_version,
        expected_version: seen.data!.version,
      },
    });
    expect(approved.response.status).toBe(200);

    await user.click(within(panel).getByRole("button", { name: "Setujui" }));
    expect(
      await findToast(
        "error",
        "Pembayaran ini sudah diputus atau dibatalkan. Muat ulang untuk melihat status terbaru.",
      ),
    ).toBeInTheDocument();
    const refreshed = await screen.findByRole("article", { name: pending.name });
    await waitFor(() =>
      expect(within(refreshed).getByRole("status")).toHaveTextContent(
        "Pembayaran ini sudah diputus admin lain: Disetujui.",
      ),
    );
    expect(within(refreshed).getByText(/oleh Admin Keuangan/)).toBeInTheDocument();
    expect(within(refreshed).queryByRole("button", { name: "Setujui" })).toBeNull();
    // Tepat satu keputusan: histori hanya memuat satu persetujuan, oleh Admin Keuangan.
    const after = await treasurer.GET("/admin/payments/{paymentId}", {
      params: { path: { paymentId: pending.paymentId } },
    });
    expect(after.data?.status).toBe("paid");
    expect(after.data?.events.filter((e) => e.kind === "approved")).toHaveLength(1);
    expect(after.data?.decided_by?.display_name).toBe("Admin Keuangan");
  });

  it("D6-01, D6-02, AC F07-5: Catat iuran (adminRecordPayment) untuk alumni tanpa tagihan → 201, keanggotaan aktif; detail anggota menaut ke payment itu", async () => {
    const { unverified } = live().alumni;
    const method = live().paymentMethod;
    const user = userEvent.setup();
    const { router } = renderApp("/payments");
    await signInLive(user);
    await user.click(await screen.findByRole("button", { name: "Catat iuran" }));
    const dialog = await screen.findByRole("dialog", { name: "Catat iuran di luar aplikasi" });
    await user.type(within(dialog).getByRole("combobox", { name: /^Alumni/ }), "Fauzi");
    await user.click(await screen.findByRole("option", { name: new RegExp(escape(unverified.name)) }));
    const picked = await within(dialog).findByRole("region", { name: "Alumni terpilih" });
    expect(await within(picked).findByText(unverified.name)).toBeInTheDocument();

    // Kelayakan seperti GET /me/fees: belum pernah bayar → hanya pendaftaran, tanpa tagihan terbuka.
    const types = await within(dialog).findByRole("group", { name: /Jenis iuran/ });
    await waitFor(() => expect(within(types).getByRole("radio", { name: /Pendaftaran/ })).toBeChecked());
    expect(within(types).getByRole("radio", { name: /Perpanjangan/ })).toBeDisabled();
    expect(await within(dialog).findByText(/Belum ada tagihan terbuka untuk iuran ini/)).toBeInTheDocument();

    await user.click(await within(dialog).findByRole("radio", { name: new RegExp(escape(method.provider)) }));
    await user.upload(within(dialog).getByTestId("file-input"), await proofFile());
    await within(dialog).findByText("Berkas siap dilampirkan.");
    await user.click(within(dialog).getByLabelText(/^Catatan verifikasi/));
    await user.paste("Dana cocok dengan mutasi rekening organisasi.");
    await user.click(within(dialog).getByRole("checkbox", { name: /Saya sudah mencocokkan dana/ }));
    await user.click(within(dialog).getByRole("button", { name: "Catat iuran" }));

    await findToast("success", `Iuran pendaftaran ${unverified.name} tercatat lunas. Masa aktif sampai `);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Catat iuran di luar aplikasi" })).toBeNull(),
    );
    const panel = await screen.findByRole("article", { name: unverified.name });
    expect(await within(panel).findAllByText("Disetujui")).not.toHaveLength(0);
    const paymentId = router.state.location.search.payment;
    expect(paymentId).toMatch(/^[0-9a-f-]{36}$/);

    // Server: payment baru paid dengan histori pencatatan admin; nominal dari biaya aktif, bukan dari klien.
    const treasurer = await adminApi("treasurer");
    const recorded = await treasurer.GET("/admin/payments/{paymentId}", {
      params: { path: { paymentId: paymentId! } },
    });
    expect(recorded.data).toMatchObject({ type: "registration", status: "paid", method_id: method.id });
    expect(recorded.data?.events.map((e) => e.kind)).toEqual(["created", "proof_submitted", "approved"]);
    expect(recorded.data?.member?.effective_status).toBe("verified");

    // D6-02: detail anggota menautkan baris pembayaran ke payment itu di Verifikasi Pembayaran.
    await act(() => router.navigate({ to: "/members/$userId", params: { userId: unverified.userId } }));
    await screen.findByRole("heading", { level: 1, name: unverified.name });
    const card = screen.getByRole("region", { name: "Pembayaran terbaru" });
    const row = await within(card).findByRole("link", { name: /^Pendaftaran Rp[\d.]+, dibuat / });
    expect(row).toHaveAttribute("href", `/payments?tab=verify&payment=${paymentId}`);
    // Iuran pendaftaran sudah tercatat: Catat iuran tidak lagi ditawarkan untuk anggota ini.
    expect(within(card).queryByRole("link", { name: "Catat iuran" })).toBeNull();
    expect(within(card).getByRole("link", { name: "Semua pembayaran" })).toHaveAttribute(
      "href",
      `/payments?tab=verify&user=${unverified.userId}`,
    );
    await user.click(row);
    expect(await screen.findByRole("article", { name: unverified.name })).toBeInTheDocument();

    // D6-02: "Semua pembayaran" dibatasi ke anggota ini oleh filter user_id API, seluruh status (payment lunas tadi).
    await act(() => router.navigate({ to: "/payments", search: { tab: "verify", user: unverified.userId } }));
    const scope = await screen.findByRole("note", { name: "Cakupan daftar pembayaran" });
    await waitFor(() =>
      expect(scope).toHaveTextContent(`Hanya menampilkan pembayaran milik ${unverified.name}.`),
    );
    const table = await screen.findByRole("table", { name: "Antrean pembayaran" });
    // Data antrean sebelumnya dapat tampil sebentar (keepPreviousData) sampai respons berfilter tiba.
    await waitFor(() => {
      const owners = within(table)
        .getAllByRole("rowheader")
        .map((cell) => cell.textContent ?? "");
      expect(owners.length).toBeGreaterThan(0);
      expect(owners.every((name) => name.includes(unverified.name))).toBe(true);
    });
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("all");
  });

  it("AC F02-5: peringatan 2 menit sebelum idle; 'Tetap masuk' menyentuh API sehingga idle server ikut diperpanjang", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/login");
    await signInLive(user);
    await screen.findByRole("heading", { level: 1, name: "Dashboard" });

    // Jam klien (hanya Date; timer tetap nyata agar fetch dan waitFor berjalan) dan jam server maju bersama tanpa
    // aktivitas pengguna: 28,5 menit sejak masuk, di dalam jendela peringatan 2 menit.
    const quiet = 28.5 * 60_000;
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true, now: Date.now() });
    try {
      vi.setSystemTime(Date.now() + quiet);
      await advanceServerClock(quiet);
      const dialog = await screen.findByRole("alertdialog", { name: "Sesi akan berakhir" });
      await user.click(within(dialog).getByRole("button", { name: "Tetap masuk" }));
      // Dialog baru tertutup setelah GET /admin/me tanpa header latar berhasil di server (AppShell stayActive).
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

      // 3 menit kemudian: 31,5 menit sejak masuk, tetapi hanya 3 menit sejak "Tetap masuk". Refresh dan polling latar
      // tidak memperpanjang idle (AC F02-5, API e2e), sehingga sesi hanya hidup karena sentuhan "Tetap masuk".
      vi.setSystemTime(Date.now() + 3 * 60_000);
      await advanceServerClock(3 * 60_000);
      await act(() => router.navigate({ to: "/members" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Manajemen Users" })).toBeInTheDocument();
      // Daftar termuat dari server (alumni seed dev), bukan galat sesi.
      expect((await screen.findAllByText(/^\[Contoh\] /)).length).toBeGreaterThan(0);
      expect(screen.queryByText("Sesi berakhir. Silakan masuk kembali.")).toBeNull();
      expect(router.state.location.pathname).toBe("/members");
    } finally {
      vi.useRealTimers();
    }
  });

  it("AC F02-5: idle server diukur dari aktivitas; setelah 30 menit tanpa aktivitas permintaan berikutnya mengakhiri sesi UI", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/login");
    await signInLive(user);
    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    const firstRefresh = cookieValue("kapdh_admin_rt");
    expect(firstRefresh).toBeTruthy();

    // 20 menit: access token (15 menit) habis tetapi sesi belum idle → klien menukar cookie refresh dan lanjut.
    await advanceServerClock(20 * 60_000);
    await act(() => router.navigate({ to: "/payments" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Verifikasi Pembayaran" }),
    ).toBeInTheDocument();
    // Antrean termuat dari server (berisi atau kosong, tergantung uji sebelumnya), bukan galat sesi.
    const queue = await screen.findByRole("region", { name: "Antrean pembayaran" });
    expect(await within(queue).findAllByText(/Menampilkan \d|Antrean kosong/)).not.toHaveLength(0);
    expect(screen.queryByLabelText(/^Kata sandi/)).toBeNull();
    // Refresh token diputar setiap penukaran (AC F02-3).
    const rotated = cookieValue("kapdh_admin_rt");
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(firstRefresh);

    // 31 menit tanpa aktivitas: server mencabut keluarga sesi; UI kembali ke halaman masuk dengan pesan.
    await advanceServerClock(31 * 60_000);
    await act(() => router.navigate({ to: "/members" }));
    expect(await screen.findByText("Sesi berakhir. Silakan masuk kembali.")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(screen.queryByRole("navigation", { name: "Menu admin" })).toBeNull();
    // Server benar-benar mencabut keluarga sesi: refresh token terakhir pun ditolak (bukan hanya logout lokal).
    const replay = await rawFetch(`${live().origin}/api/v1/auth/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `kapdh_admin_rt=${rotated}`,
        origin: window.location.origin,
      },
      body: "{}",
    });
    expect(replay.status).toBe(401);
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
