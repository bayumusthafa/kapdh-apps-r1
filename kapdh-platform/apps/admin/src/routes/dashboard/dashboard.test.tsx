import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { mockAuth, paymentRequests } from "../../api/mocks";
import { dashboardRequests, mockDashboard } from "../../api/mocks/dashboard";
import { MOCK_EVENT_IDS, mockEvents } from "../../api/mocks/events";
import { moderationCounts } from "../../api/mocks/moderation";
import { notificationJobCounts } from "../../api/mocks/notifications";
import { formatRupiah } from "../../lib/format";
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

/** Jumlah Money desimal lewat BigInt sen, tanpa floating point (ARCHITECTURE §2 butir 5). */
function sumMoney(values: string[]): string {
  const cents = values.reduce((acc, v) => {
    const [whole = "0", frac = "00"] = v.split(".");
    return acc + BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0").slice(0, 2));
  }, 0n);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

/**
 * Nilai kartu "Total Transaksi" yang diharapkan = bruto seluruh payment paid sebelum penyesuaian/refund (kontrak
 * DashboardPayments). Di server tiruan "seluruh payment paid" = payment paid area pembayaran (GET /admin/payments
 * status=paid) ditambah riwayat contoh lama dasbor. Total dihitung dari kedua sumber itu, bukan disalin dari nominal
 * fixture, sehingga perubahan fixture area pembayaran tidak mematahkan uji dasbor.
 */
async function paidGross(): Promise<string> {
  const paid = await api.GET("/admin/payments", { params: { query: { status: "paid", limit: 100 } } });
  expect(paid.data!.next_cursor).toBeNull();
  expect(paid.data!.items.length).toBeGreaterThan(0);
  expect(paid.data!.items.every((p) => p.status === "paid")).toBe(true);
  return sumMoney([
    ...paid.data!.items.map((p) => p.amount),
    ...mockDashboard.historicalTransactions().map((t) => t.amount),
  ]);
}

async function expectedPaidTotal(): Promise<string> {
  return formatRupiah(await paidGross());
}

/** Kartu "Tiket Terjual" yang diharapkan = tiket paid di semua event menurut area Event (paid_quantity). */
async function expectedTicketsSold(): Promise<string> {
  const list = await api.GET("/admin/events", { params: { query: { limit: 100 } } });
  expect(list.data!.next_cursor).toBeNull();
  return String(list.data!.items.reduce((n, e) => n + e.paid_quantity, 0));
}

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
    expect(statValue("Total Transaksi")).toBe(await expectedPaidTotal());
    expect(statValue("Tiket Terjual")).toBe(await expectedTicketsSold());

    // Antrean pembayaran sama dengan ringkasan pembayaran (sumber pill menu).
    const summary = await api.GET("/admin/payments/summary");
    expect(await queueValue("Pembayaran", "Bukti menunggu verifikasi")).toBe(
      String(summary.data!.awaiting_review_count),
    );
    expect(await queueValue("Pembayaran", "Lewat batas review")).toBe(String(summary.data!.overdue_count));
    // Moderasi memakai aturan visibilitas yang sama dengan antrean (laporan terhadap akun tertaut tidak dihitung).
    const mod = moderationCounts();
    // open_count = open + in_review, berlabel jelas agar sama dengan Terbuka + Sedang ditinjau di halaman Moderasi.
    expect(await queueValue("Moderasi", "Laporan aktif (terbuka + ditinjau)")).toBe(
      String(mod.open + mod.in_review),
    );
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
    const seminar = mockEvents.event(MOCK_EVENT_IDS.seminar)!;
    expect(within(upcoming).getByRole("link", { name: seminar.title })).toBeInTheDocument();
    // Event dibatalkan tidak termasuk event mendatang.
    const pramuka = mockEvents.event(MOCK_EVENT_IDS.pramuka)!;
    expect(within(upcoming).queryByText(pramuka.title)).toBeNull();

    const users = await section("Pengguna");
    const usersTable = within(users).getByRole("table", { name: "Pengguna terbaru" });
    const fikri = within(usersTable).getByText("Fikri Ramadhan").closest("tr")!;
    expect(within(fikri).getByText("Admin")).toBeInTheDocument();
    expect(within(fikri).getByText("09.02.01.91")).toBeInTheDocument();
    // Penjualan Tiket memuat event selain draft (termasuk yang dibatalkan), tanpa event draft.
    const tickets = await section("Penjualan Tiket");
    expect(within(tickets).getByRole("link", { name: pramuka.title })).toBeInTheDocument();
    const draft = mockEvents.event(MOCK_EVENT_IDS.mancing)!;
    expect(draft.status).toBe("draft");
    expect(within(tickets).queryByText(draft.title)).toBeNull();
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
    expect(statValue("Total Transaksi")).toBe(await expectedPaidTotal());
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
      await within(nav).findByRole("link", { name: badgeLink("Moderasi", reports, "laporan aktif") }),
    ).toBeVisible();
    expect(
      within(nav).getByRole("link", { name: badgeLink("Notifikasi", failed, "job gagal") }),
    ).toBeVisible();
    expect(dashboardRequests.find((r) => r.path === "/admin/dashboard/badges")?.background).toBe(false);
  });

  it("F-15: setiap tautan event di dasbor menunjuk event yang dikenal area Event dan membuka detailnya", async () => {
    const user = userEvent.setup();
    const { router } = await openPage(user, "/", "Dashboard");
    const links = [
      ...within(await section("Event mendatang")).getAllByRole("link"),
      ...within(await section("Penjualan Tiket")).getAllByRole("link"),
    ].filter((a) => /^\/events\/[0-9a-f-]{36}$/.test(a.getAttribute("href") ?? ""));
    expect(links.length).toBeGreaterThan(0);
    // Satu sumber event di dev:mock: id dan judul setiap baris dasbor sama dengan tiruan area Event.
    for (const a of links) {
      const id = a.getAttribute("href")!.slice("/events/".length);
      expect(mockEvents.event(id)?.title, `${a.textContent} (${id})`).toBe(a.textContent);
    }
    const first = links[0]!;
    await user.click(first);
    expect(
      await screen.findByRole("heading", { level: 1, name: first.textContent! }, { timeout: 5_000 }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(first.getAttribute("href"));
  });

  it("admin dengan izin check-in saja melihat event mendatang dan tautan check-in tanpa tautan kelola event", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["events.checkin"] });
    const user = userEvent.setup();
    await openPage(user, "/", "Dashboard");
    const upcoming = await section("Event mendatang");
    const seminar = mockEvents.event(MOCK_EVENT_IDS.seminar)!.title;
    expect(within(upcoming).getByText(seminar)).toBeInTheDocument();
    expect(within(upcoming).queryByRole("link", { name: seminar })).toBeNull();
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
    // Satu pembayaran di antrean disetujui sehingga menjadi transaksi lunas terbaru. Versi bukti dan versi pembayaran
    // dibaca dari server tiruan (fixture Siti memuat bukti pengganti versi 2, AC F03-3), bukan diasumsikan 1.
    const paymentId = "0199e000-0000-7000-8000-0000000000a1";
    const pending = await api.GET("/admin/payments/{paymentId}", { params: { path: { paymentId } } });
    expect(pending.data?.status).toBe("pending");
    const grossBefore = await paidGross();
    const approved = await api.POST("/admin/payments/{paymentId}/decision", {
      params: { path: { paymentId } },
      body: {
        decision: "approve",
        expected_proof_version: pending.data!.proof_version,
        expected_version: pending.data!.version,
        funds_verified: true,
      },
    });
    expect(approved.response.status).toBe(200);
    const user = userEvent.setup();
    renderApp("/");
    await screen.findByRole("heading", { level: 1, name: "Dashboard" }, { timeout: 5_000 });
    const card = await section("Riwayat Transaksi");
    const rows = within(card).getAllByRole("row");
    expect(within(rows[1]!).getByText("Siti Rahmawati")).toBeInTheDocument();
    // Persetujuan menambah bruto sebesar nominal pembayaran yang disetujui.
    const grossAfter = await paidGross();
    expect(grossAfter).toBe(sumMoney([grossBefore, pending.data!.amount]));
    expect(statValue("Total Transaksi")).toBe(formatRupiah(grossAfter));

    paymentRequests.length = 0;
    await user.type(within(card).getByLabelText("Cari transaksi"), "ridho");
    expect(await within(card).findByText("Tidak ada transaksi yang cocok")).toBeInTheDocument();
    await waitFor(() =>
      expect(paymentRequests.at(-1)?.query).toMatchObject({
        status: "paid",
        q: "ridho",
        sort: "decided_at_desc",
        limit: "10",
      }),
    );
    await user.clear(within(card).getByLabelText("Cari transaksi"));
    await user.type(within(card).getByLabelText("Cari transaksi"), "27.02");
    expect(await within(card).findByText("Siti Rahmawati")).toBeInTheDocument();
    expect(within(card).queryByText("ridho")).toBeNull();
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

  it("PRD 4.5: polling yang gagal mempertahankan data terakhir dan kata kunci pencarian, dengan pemberitahuan data usang", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openPage(user, "/", "Dashboard");
    await screen.findByRole("region", { name: "Statistik" });
    const card = await section("Riwayat Transaksi");
    await user.type(within(card).getByLabelText("Cari transaksi"), "ridho");
    expect(await within(card).findByText("Tidak ada transaksi yang cocok")).toBeInTheDocument();

    mockDashboard.setFailing(true);
    const before = dashboardCalls().length;
    await act(async () => {
      vi.advanceTimersByTime(DASHBOARD_POLL_MS + 500);
    });
    await waitFor(() => expect(dashboardCalls().length).toBeGreaterThan(before));
    expect(await screen.findByText(/Gagal memperbarui dasbor/)).toBeInTheDocument();
    expect(screen.getByText(/Gagal memperbarui dasbor/).closest('[role="status"]')).not.toBeNull();
    // Konten tetap: statistik, antrean dan pencarian Riwayat Transaksi tidak hilang.
    expect(screen.queryByText("Dasbor gagal dimuat")).toBeNull();
    expect(screen.getByRole("region", { name: "Statistik" })).toBeInTheDocument();
    expect(await section("Pembayaran")).toBeInTheDocument();
    expect(within(await section("Riwayat Transaksi")).getByLabelText("Cari transaksi")).toHaveValue("ridho");

    mockDashboard.setFailing(false);
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    await waitFor(() => expect(screen.queryByText(/Gagal memperbarui dasbor/)).toBeNull());
    expect(dashboardCalls().at(-1)?.background).toBe(false);
  });

  it("PRD 4.5: pemuatan pertama yang gagal (belum ada data) menampilkan keadaan galat dengan Coba lagi", async () => {
    mockDashboard.setFailing(true);
    const user = userEvent.setup();
    await openPage(user, "/", "Dashboard");
    expect(await screen.findByText("Dasbor gagal dimuat")).toBeInTheDocument();
    mockDashboard.setFailing(false);
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByRole("region", { name: "Statistik" })).toBeInTheDocument();
  });

  it("N-11, WCAG 1.3.1: kartu antrean memakai dl > div > dt + dd yang sah dan judul h3 di bawah h2 Perlu tindakan", async () => {
    const user = userEvent.setup();
    await openPage(user, "/", "Dashboard");
    const queues = (await screen.findByRole("heading", { level: 2, name: "Perlu tindakan" })).closest(
      "section",
    )!;
    const terms = queues.querySelectorAll("dt, dd");
    expect(terms.length).toBeGreaterThan(0);
    for (const el of terms) {
      const parent = el.parentElement!;
      const valid =
        parent.tagName === "DL" || (parent.tagName === "DIV" && parent.parentElement?.tagName === "DL");
      expect(valid, `${el.tagName} "${el.textContent}" di dalam ${parent.tagName}`).toBe(true);
    }
    for (const name of ["Pembayaran", "Moderasi", "Job gagal", "Event mendatang"])
      expect(within(queues).getByRole("heading", { level: 3, name })).toBeInTheDocument();
    expect(within(queues).queryAllByRole("heading", { level: 2 })).toHaveLength(1);
    // Grid antrean berukuran rem (auto-fit) sehingga kolom berkurang saat teks diperbesar 200% (WCAG 1.4.4).
    const grid = within(queues).getByRole("region", { name: "Pembayaran" }).parentElement!;
    expect(grid.className).toMatch(/auto-fit,minmax\(min\(100%,\d+rem\)/);
  });

  it("F-15: tautan antrean pembayaran membuka tab verifikasi tempat baris lewat batas ditandai", async () => {
    const user = userEvent.setup();
    await openPage(user, "/", "Dashboard");
    const payments = await section("Pembayaran");
    expect(within(payments).getByRole("link", { name: "Buka antrean verifikasi" })).toHaveAttribute(
      "href",
      "/payments?tab=verify",
    );
  });

  it("F-15, AC F15-1: 'Lihat yang lewat batas' membuka /payments?stage=awaiting_review&overdue=true dengan jumlah yang sama dengan kartu", async () => {
    const user = userEvent.setup();
    const { router } = await openPage(user, "/", "Dashboard");
    const payments = await section("Pembayaran");
    const overdue = Number(await queueValue("Pembayaran", "Lewat batas review"));
    expect(overdue).toBeGreaterThan(0);
    const link = within(payments).getByRole("link", { name: "Lihat yang lewat batas" });
    expect(link).toHaveAttribute("href", "/payments?stage=awaiting_review&overdue=true");

    paymentRequests.length = 0;
    await user.click(link);
    await screen.findByRole("heading", { level: 1, name: "Verifikasi Pembayaran" }, { timeout: 5_000 });
    expect(router.state.location.search).toMatchObject({ stage: "awaiting_review", overdue: true });
    expect(await screen.findByText(`Menampilkan ${overdue} dari ${overdue}`)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Batas review" })).toHaveValue("overdue");
    const lists = paymentRequests.filter((r) => r.method === "GET" && r.path === "/admin/payments");
    expect(lists.at(-1)?.query).toMatchObject({ stage: "awaiting_review", overdue: "true" });
  });
});
