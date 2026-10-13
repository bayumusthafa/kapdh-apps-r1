import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { mockAuth, paymentRequests } from "../../api/mocks";
import { dashboardRequests } from "../../api/mocks/dashboard";
import { moderationCounts } from "../../api/mocks/moderation";
import { notificationJobCounts } from "../../api/mocks/notifications";
import { openPage, section } from "../../test/governance";
import { renderApp, signInViaApi } from "../../test/utils";
import { DASHBOARD_POLL_MS, typeBreakdown } from "./DashboardPage";

afterEach(() => {
  vi.useRealTimers();
});

/** Nilai StatCard berlabel `label` (angka ditulis sebelum label). */
function statValue(label: string): string {
  const region = screen.getByRole("region", { name: "Statistik" });
  return within(region).getByText(label, { selector: "span" }).previousElementSibling?.textContent ?? "";
}

/** Nilai baris antrean (dt/dd) di kartu antrean berlabel `card`. */
async function queueValue(card: string, label: string): Promise<string> {
  const region = await section(card);
  const term = within(region).getByText(label, { selector: "dt" });
  return term.nextElementSibling?.textContent ?? "";
}

const dashboardCalls = () => dashboardRequests.filter((r) => r.path === "/admin/dashboard");

describe("dasbor (F-15, AC F15-1; server tiruan)", () => {
  it("typeBreakdown meringkas jenis pembayaran tanpa jenis bernilai nol", () => {
    expect(typeBreakdown({ registration: 2, renewal: 0, ticket: 1 })).toBe("Pendaftaran 2, Tiket event 1");
    expect(typeBreakdown({ registration: 0, renewal: 0, ticket: 0 })).toBeNull();
  });

  it("AC F15-1: Super Admin melihat statistik, antrean kerja dan tabel guideline hlm. 12", async () => {
    const user = userEvent.setup();
    await openPage(user, "/", "Dashboard");
    await screen.findByRole("region", { name: "Statistik" });
    expect(statValue("Pengguna Aktif")).toBe("4");
    expect(screen.getByText("dari 6 total alumni")).toBeInTheDocument();
    expect(statValue("Total Transaksi")).toBe("Rp295.224");
    expect(statValue("Tiket Terjual")).toBe("333");

    // Antrean pembayaran sama dengan ringkasan pembayaran (sumber pill menu).
    const summary = await api.GET("/admin/payments/summary");
    expect(await queueValue("Pembayaran", "Bukti menunggu verifikasi")).toBe(
      String(summary.data!.awaiting_review_count),
    );
    expect(await queueValue("Pembayaran", "Lewat batas review")).toBe(String(summary.data!.overdue_count));
    // Moderasi memakai aturan visibilitas yang sama dengan antrean (laporan terhadap akun tertaut tidak dihitung).
    const mod = moderationCounts();
    expect(await queueValue("Moderasi", "Laporan terbuka")).toBe(String(mod.open + mod.in_review));
    expect(await queueValue("Moderasi", "Mendesak (target 24 jam)")).toBe(String(mod.urgent));
    expect(await queueValue("Moderasi", "Lewat target penanganan")).toBe(String(mod.overdue));
    const jobs = notificationJobCounts();
    expect(await queueValue("Job gagal", "Pengiriman notifikasi gagal")).toBe(
      String(jobs.failed_delivery_count),
    );
    expect(await queueValue("Job gagal", "Event outbox berhenti")).toBe(String(jobs.dead_outbox_count));
    const failed = within(await section("Job gagal")).getByRole("link", { name: "Lihat pengiriman gagal" });
    expect(failed.getAttribute("href")).toContain("since=");
    const upcoming = await section("Event mendatang");
    expect(within(upcoming).getByRole("link", { name: "Seminar AI untuk Mahasiswa" })).toBeInTheDocument();

    const users = await section("Pengguna");
    const usersTable = within(users).getByRole("table", { name: "Pengguna terbaru" });
    const bayu = within(usersTable).getByText("Bayu Musthafa Arief").closest("tr")!;
    expect(within(bayu).getByText("Admin")).toBeInTheDocument();
    expect(within(bayu).getByText("09.02.01.5")).toBeInTheDocument();
    const tickets = await section("Penjualan Tiket");
    expect(within(tickets).getByRole("link", { name: "Mancing Bareng Alumni" })).toBeInTheDocument();
    const transactions = await section("Riwayat Transaksi");
    expect(within(transactions).getByPlaceholderText("Cari nama atau nomor KTA...")).toBeInTheDocument();
    expect(within(transactions).getByText("Rp15.224")).toBeInTheDocument();
    expect(within(transactions).getByText("Akun dihapus")).toBeInTheDocument();
  });

  it("AC F15-1: admin pembayaran tanpa izin lain hanya menerima dan melihat data pembayaran", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read"] });
    const user = userEvent.setup();
    await openPage(user, "/", "Dashboard");
    await screen.findByRole("region", { name: "Statistik" });
    expect(statValue("Total Transaksi")).toBe("Rp295.224");
    expect(screen.queryByText("Pengguna Aktif")).toBeNull();
    expect(screen.queryByText("Tiket Terjual")).toBeNull();
    expect(await section("Pembayaran")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Moderasi" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Job gagal" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Event mendatang" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Pengguna" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Penjualan Tiket" })).toBeNull();
    expect(await section("Riwayat Transaksi")).toBeInTheDocument();
    // Payload dari server memang tidak memuat bagian lain (bukan sekadar disembunyikan UI).
    const body = (await api.GET("/admin/dashboard")).data!;
    expect(Object.keys(body).sort()).toEqual(["generated_at", "payments"]);
    // Lencana laporan/job tidak diminta tanpa izinnya.
    expect(dashboardRequests.some((r) => r.path === "/admin/dashboard/badges")).toBe(false);
  });

  it("lencana menu Moderasi dan Notifikasi sama dengan hitungan antrean masing-masing", async () => {
    const user = userEvent.setup();
    await openPage(user, "/", "Dashboard");
    const nav = screen.getByRole("navigation", { name: "Menu admin" });
    const mod = moderationCounts();
    const jobs = notificationJobCounts();
    const reports = mod.open + mod.in_review;
    const failed = jobs.failed_delivery_count + jobs.dead_outbox_count;
    // Nama tautan = label grup + angka lencana + teks pembaca layar.
    const badgeLink = (label: string, count: number, what: string) => (_: string, el: Element | null) =>
      el?.tagName === "A" &&
      (el.textContent ?? "").replace(/\s+/g, "") === `${label}${count}${what}`.replace(/\s+/g, "");
    expect(
      await within(nav).findByRole("link", { name: badgeLink("Moderasi", reports, "laporan terbuka") }),
    ).toBeVisible();
    expect(
      within(nav).getByRole("link", { name: badgeLink("Notifikasi", failed, "job gagal") }),
    ).toBeVisible();
    expect(dashboardRequests.find((r) => r.path === "/admin/dashboard/badges")?.background).toBe(false);
  });

  it("admin dengan izin check-in saja melihat event mendatang dan tautan check-in tanpa tautan kelola event", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["events.checkin"] });
    const user = userEvent.setup();
    await openPage(user, "/", "Dashboard");
    const upcoming = await section("Event mendatang");
    expect(within(upcoming).getByText("Seminar AI untuk Mahasiswa")).toBeInTheDocument();
    expect(within(upcoming).queryByRole("link", { name: "Seminar AI untuk Mahasiswa" })).toBeNull();
    expect(within(upcoming).getByRole("link", { name: "Buka check-in tiket" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Statistik" })).toBeNull();
  });

  it("admin tanpa izin bagian mana pun melihat keadaan kosong yang menjelaskan izin", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["audit.read"] });
    const user = userEvent.setup();
    await openPage(user, "/", "Dashboard");
    expect(await screen.findByText("Belum ada ringkasan untuk izin Anda")).toBeInTheDocument();
  });

  it("Riwayat Transaksi: pencarian memakai daftar pembayaran lunas di server (status=paid, decided_at_desc)", async () => {
    await signInViaApi();
    // Satu pembayaran di antrean disetujui sehingga menjadi transaksi lunas terbaru.
    const approved = await api.POST("/admin/payments/{paymentId}/decision", {
      params: { path: { paymentId: "0199e000-0000-7000-8000-0000000000a1" } },
      body: { decision: "approve", expected_proof_version: 1, expected_version: "1", funds_verified: true },
    });
    expect(approved.response.status).toBe(200);
    const user = userEvent.setup();
    renderApp("/");
    await screen.findByRole("heading", { level: 1, name: "Dashboard" }, { timeout: 5_000 });
    const card = await section("Riwayat Transaksi");
    const rows = within(card).getAllByRole("row");
    expect(within(rows[1]!).getByText("Siti Rahmawati")).toBeInTheDocument();
    expect(statValue("Total Transaksi")).toBe("Rp355.224");

    paymentRequests.length = 0;
    await user.type(within(card).getByLabelText("Cari transaksi"), "ridwan");
    expect(await within(card).findByText("Tidak ada transaksi yang cocok")).toBeInTheDocument();
    await waitFor(() =>
      expect(paymentRequests.at(-1)?.query).toMatchObject({
        status: "paid",
        q: "ridwan",
        sort: "decided_at_desc",
        limit: "10",
      }),
    );
    await user.clear(within(card).getByLabelText("Cari transaksi"));
    await user.type(within(card).getByLabelText("Cari transaksi"), "27.02");
    expect(await within(card).findByText("Siti Rahmawati")).toBeInTheDocument();
    expect(within(card).queryByText("ridwan")).toBeNull();
    await user.clear(within(card).getByLabelText("Cari transaksi"));
    expect(await within(card).findByText("Rp15.224")).toBeInTheDocument();
  });

  it("AC F02-5: auto-refresh dasbor berlabel latar; muat ulang oleh pengguna tidak", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openPage(user, "/", "Dashboard");
    await screen.findByRole("region", { name: "Statistik" });
    expect(dashboardCalls()[0]?.background).toBe(false);
    const before = dashboardCalls().length;
    await act(async () => {
      vi.advanceTimersByTime(DASHBOARD_POLL_MS + 500);
    });
    await waitFor(() => expect(dashboardCalls().length).toBeGreaterThan(before));
    expect(
      dashboardCalls()
        .slice(before)
        .every((r) => r.background),
    ).toBe(true);
    const polled = dashboardCalls().length;
    await user.click(screen.getByRole("button", { name: "Muat ulang" }));
    await waitFor(() => expect(dashboardCalls().length).toBeGreaterThan(polled));
    expect(dashboardCalls().at(-1)?.background).toBe(false);
  });
});
