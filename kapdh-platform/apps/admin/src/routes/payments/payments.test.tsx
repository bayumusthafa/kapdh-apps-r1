import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockAuth, mockPayments, paymentRequests } from "../../api/mocks";
import { findToast, renderApp, signIn, type User } from "../../test/utils";
import { PAYMENT_POLL_MS } from "./VerificationTab";

/** Data contoh prototipe screen_8 di server tiruan (src/api/mocks/payments.ts). */
const AHMAD = "0199e000-0000-7000-8000-0000000000a2";
/** Payment berbukti milik akun yang sudah dihapus (AC F14-4). */
const DELETED = "0199e000-0000-7000-8000-0000000000a6";
/** Payment tiket yang event-nya dibatalkan pengurus setelah bukti dikirim (D6). */
const DEWI = "0199e000-0000-7000-8000-0000000000a8";

afterEach(() => {
  vi.useRealTimers();
});

async function openPayments(user: User, title = "Verifikasi Pembayaran") {
  renderApp("/payments");
  await signIn(user);
  await screen.findByRole("heading", { level: 1, name: title });
}

async function selectAhmad(user: User) {
  await user.click(await screen.findByRole("button", { name: /Ahmad Islam/ }));
  return screen.findByRole("article", { name: "Ahmad Islam" });
}

const listRequests = () => paymentRequests.filter((r) => r.method === "GET" && r.path === "/admin/payments");

describe("verifikasi pembayaran (F-04, prototipe screen_8; server tiruan)", () => {
  it("menampilkan antrean dengan kolom prototipe, usia antrean, penanda lewat 1 hari kerja dan jumlah di menu", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    const table = await screen.findByRole("table", { name: "Antrean pembayaran" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(["Dikirim (WIB)", "Alumni", "Jenis", "Nominal", "Usia antrean"]);
    expect(within(table).getByText("Lewat 1 hari kerja")).toBeInTheDocument();
    expect(within(table).getByText("Tiket: Halal bi Halal")).toBeInTheDocument();
    expect(within(table).getAllByText("Rp60.000").length).toBeGreaterThan(0);
    expect(screen.getByText("Menampilkan 20 dari 28")).toBeInTheDocument();
    // "Menunggu" = stage awaiting_review (kontrak C3), bukan status=pending yang ikut memuat instruksi tanpa bukti.
    expect(listRequests()[0]?.query).toMatchObject({ stage: "awaiting_review" });
    expect(listRequests()[0]?.query).not.toHaveProperty("status");
    // Pill emas bersumber dari GET /admin/payments/summary dan sama dengan total "Menunggu".
    const nav = screen.getByRole("navigation", { name: "Menu admin" });
    await waitFor(() =>
      expect(within(nav).getByRole("link", { name: /Verifikasi Pembayaran/ })).toHaveTextContent("28"),
    );
    expect(paymentRequests.some((r) => r.path === "/admin/payments/summary")).toBe(true);
  });

  it("paging kursor server: halaman berikutnya dan sebelumnya", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    await screen.findByText("Menampilkan 20 dari 28");
    await user.click(screen.getByRole("button", { name: "Halaman berikutnya" }));
    expect(await screen.findByText("Menampilkan 21–28 dari 28")).toBeInTheDocument();
    // Halaman terakhir: tombol nonaktif tetapi tetap memegang fokus (aria-disabled, N-11).
    const next = screen.getByRole("button", { name: "Halaman berikutnya" });
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(next).toHaveFocus();
    expect(listRequests().at(-1)?.query.cursor).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Halaman sebelumnya" }));
    expect(await screen.findByText("Menampilkan 20 dari 28")).toBeInTheDocument();
  });

  it("pencarian di-debounce: mengetik cepat hanya mengirim satu permintaan dengan kata kunci akhir", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    await screen.findByText("Menampilkan 20 dari 28");
    const before = listRequests().length;
    await user.type(screen.getByRole("searchbox", { name: "Cari" }), "Siti");
    await screen.findByText("Menampilkan 1 dari 1");
    const sent = listRequests().slice(before);
    expect(sent.map((r) => r.query.q)).toEqual(["Siti"]);
    // Pencarian adalah tindakan admin: bukan permintaan latar (AC F02-5).
    expect(sent.every((r) => !r.background)).toBe(true);
  });

  it("filter jenis tiket dan status Semua menampilkan kolom status", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    await screen.findByText("Menampilkan 20 dari 28");
    await user.selectOptions(screen.getByRole("combobox", { name: "Jenis" }), "ticket");
    await screen.findByText("Menampilkan 2 dari 2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "all");
    const table = await screen.findByRole("table", { name: "Antrean pembayaran" });
    await waitFor(() =>
      expect(within(table).getByRole("columnheader", { name: "Status" })).toBeInTheDocument(),
    );
    expect(listRequests().at(-1)?.query).toMatchObject({ type: "ticket" });
    expect(listRequests().at(-1)?.query).not.toHaveProperty("status");
    expect(listRequests().at(-1)?.query).not.toHaveProperty("stage");
  });

  it("status Semua memuat instruksi tanpa bukti dengan label tahap; histori menampilkan ganti rekening", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    await screen.findByText("Menampilkan 20 dari 28");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "all");
    // Instruksi tanpa bukti berada di akhir urutan (kontrak adminListPayments): halaman kedua.
    await screen.findByText("Menampilkan 20 dari 29");
    await user.click(screen.getByRole("button", { name: "Halaman berikutnya" }));
    const table = await screen.findByRole("table", { name: "Antrean pembayaran" });
    const row = (await within(table).findByRole("button", { name: /Hasan Basri/ })).closest("tr")!;
    expect(within(row).getByText("Menunggu transfer")).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: /Hasan Basri/ }));
    const panel = await screen.findByRole("article", { name: "Hasan Basri" });
    // Belum ada bukti: tidak ada formulir keputusan (actions.can_decide false).
    expect(within(panel).queryByRole("button", { name: "Setujui" })).toBeNull();
    expect(within(panel).getByText("Belum ada berkas")).toBeInTheDocument();
    await user.click(within(panel).getByText(/Riwayat lengkap/));
    expect(within(panel).getByText("Rekening tujuan diganti")).toBeInTheDocument();
  });

  it("AC F02-5: hanya refetch polling yang membawa X-Background-Request", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openPayments(user);
    await screen.findByText("Menampilkan 20 dari 28");
    const first = listRequests();
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((r) => !r.background)).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(PAYMENT_POLL_MS + 1_000);
    });
    await waitFor(() => expect(listRequests().length).toBeGreaterThan(first.length));
    expect(
      listRequests()
        .slice(first.length)
        .every((r) => r.background),
    ).toBe(true);
  });

  it("AC F04-4: Setujui hanya aktif setelah konfirmasi dana; keputusan mengirim versi yang dilihat", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    const panel = await selectAhmad(user);
    expect(within(panel).getByText("29.01.01.7 | Angkatan 29 | Pendaftaran")).toBeInTheDocument();
    expect(
      await within(panel).findByRole("img", { name: /Bukti transfer Ahmad Islam, versi 1/ }),
    ).toBeInTheDocument();
    const approve = within(panel).getByRole("button", { name: "Setujui" });
    expect(approve).toBeDisabled();
    await user.click(within(panel).getByRole("checkbox", { name: /dana Rp60\.000 sudah masuk/ }));
    await user.click(approve);
    expect(await within(panel).findByRole("status")).toHaveTextContent("Pembayaran disetujui.");
    const decision = paymentRequests.find((r) => r.method === "POST");
    expect(decision?.body).toMatchObject({
      decision: "approve",
      funds_verified: true,
      expected_proof_version: 1,
      expected_version: "1",
    });
    expect(decision?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockPayments.get(AHMAD)?.status).toBe("paid");
    // Antrean pending dimuat ulang: Ahmad tidak lagi menunggu.
    await waitFor(() =>
      expect(within(screen.getByRole("table")).queryByRole("button", { name: /Ahmad Islam/ })).toBeNull(),
    );
  });

  it("AC F04-4: bukti diganti saat admin memutus → konflik, data terbaru dimuat, centang dana direset", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    const panel = await selectAhmad(user);
    await user.click(within(panel).getByRole("checkbox", { name: /dana Rp60\.000 sudah masuk/ }));
    mockPayments.replaceProof(AHMAD);
    await user.click(within(panel).getByRole("button", { name: "Setujui" }));

    expect(await findToast("error", "Bukti sudah diganti")).toBeInTheDocument();
    const refreshed = await screen.findByRole("article", { name: "Ahmad Islam" });
    expect(await within(refreshed).findByText(/versi bukti 2/)).toBeInTheDocument();
    const checkbox = within(refreshed).getByRole("checkbox", { name: /dana Rp60\.000 sudah masuk/ });
    expect(checkbox).not.toBeChecked();
    expect(within(refreshed).getByRole("button", { name: "Setujui" })).toBeDisabled();
    expect(mockPayments.get(AHMAD)?.status).toBe("pending");
    // Formulir dipasang ulang (tombol Setujui yang difokus hilang): fokus ke judul panel dan alasan diumumkan.
    expect(within(refreshed).getByRole("status")).toHaveTextContent(
      "Bukti transfer diganti alumni (versi 2). Centang dana dan alasan dikosongkan",
    );
    expect(within(refreshed).getByRole("heading", { name: "Ahmad Islam" })).toHaveFocus();
  });

  it("AC F04-4: polling melihat bukti baru saat admin mengetik alasan → formulir direset, diumumkan, fokus ke judul", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openPayments(user);
    const panel = await selectAhmad(user);
    const reason = within(panel).getByRole("textbox", { name: /Alasan penolakan/ });
    await user.type(reason, "Nominal kurang");
    expect(reason).toHaveFocus();
    mockPayments.replaceProof(AHMAD);
    await act(async () => {
      vi.advanceTimersByTime(PAYMENT_POLL_MS + 1_000);
    });
    const refreshed = await screen.findByRole("article", { name: "Ahmad Islam" });
    expect(await within(refreshed).findByText(/versi bukti 2/)).toBeInTheDocument();
    await waitFor(() =>
      expect(within(refreshed).getByRole("status")).toHaveTextContent(
        "Bukti transfer diganti alumni (versi 2)",
      ),
    );
    expect(within(refreshed).getByRole("textbox", { name: /Alasan penolakan/ })).toHaveValue("");
    expect(within(refreshed).getByRole("heading", { name: "Ahmad Islam" })).toHaveFocus();
  });

  it("PRD 4.5: Tolak wajib alasan dan konfirmasi dua langkah sebelum dikirim", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    const panel = await selectAhmad(user);
    await user.click(within(panel).getByRole("button", { name: "Tolak" }));
    const reason = within(panel).getByRole("textbox", { name: /Alasan penolakan/ });
    expect(reason).toHaveAttribute("aria-invalid", "true");
    expect(reason).toHaveAccessibleDescription(/minimal 3 karakter/);
    expect(reason).toHaveFocus();

    await user.type(reason, "Nominal tidak sesuai");
    await user.click(within(panel).getByRole("button", { name: "Tolak" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Tolak pembayaran\?/ });
    expect(within(dialog).getByText("Nominal tidak sesuai")).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Tolak pembayaran" });
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Batal" })).toHaveFocus();
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(confirm);

    expect(await within(panel).findByRole("status")).toHaveTextContent("Pembayaran ditolak");
    expect(mockPayments.get(AHMAD)?.status).toBe("rejected");
    expect(paymentRequests.find((r) => r.method === "POST")?.body).toMatchObject({
      decision: "reject",
      reason: "Nominal tidak sesuai",
    });
  });

  it("AC F14-4: payment berbukti milik akun terhapus tampil 'Akun dihapus' tanpa berkas dan tetap dapat diputus", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    const table = await screen.findByRole("table", { name: "Antrean pembayaran" });
    await user.click(within(table).getByRole("button", { name: /Akun dihapus/ }));
    const panel = await screen.findByRole("article", { name: "Akun dihapus" });
    expect(within(panel).getByText(/Data pemilik sudah dihapus \| Pendaftaran/)).toBeInTheDocument();
    expect(within(panel).getByRole("note")).toHaveTextContent(
      "berkas bukti dan catatan transfer ikut dihapus",
    );
    expect(within(panel).queryByRole("img")).toBeNull();
    await user.click(within(panel).getByRole("checkbox", { name: /dana Rp60\.000 sudah masuk/ }));
    await user.click(within(panel).getByRole("button", { name: "Setujui" }));
    expect(await within(panel).findByRole("status")).toHaveTextContent("Pembayaran disetujui.");
    expect(mockPayments.get(DELETED)?.status).toBe("paid");
    // Tanpa pemilik: tidak ada periode keanggotaan (PRD 4.4).
    expect(mockPayments.get(DELETED)?.period).toBeNull();
  });

  it("PRD 4.4, D6: event dibatalkan ditandai di antrean; persetujuan mencatat refund penuh tanpa menghidupkan tiket", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    const table = await screen.findByRole("table", { name: "Antrean pembayaran" });
    const row = within(table)
      .getByRole("button", { name: /Dewi Lestari/ })
      .closest("tr")!;
    expect(within(row).getByText("Tiket: Seminar Karier Alumni")).toBeInTheDocument();
    expect(within(row).getByText("Event dibatalkan")).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: /Dewi Lestari/ }));
    const panel = await screen.findByRole("article", { name: "Dewi Lestari" });
    const note = within(panel)
      .getAllByRole("note")
      .find((n) => n.textContent?.includes("Event sudah dibatalkan"));
    expect(note).toHaveTextContent("tiket tidak diaktifkan kembali");
    expect(note).toHaveTextContent("refund penuh Rp50.000");
    await user.click(within(panel).getByRole("checkbox", { name: /dana Rp50\.000 sudah masuk/ }));
    await user.click(within(panel).getByRole("button", { name: "Setujui" }));
    expect(await within(panel).findByRole("status")).toHaveTextContent("Refund penuh tercatat");
    const decided = mockPayments.get(DEWI);
    expect(decided?.status).toBe("paid");
    expect(decided?.ticket?.ticket_status).toBe("cancelled");
    expect(decided?.adjustments).toMatchObject([
      { kind: "refund", amount: "50000.00", status: "pending", created_by: null },
    ]);
  });

  it("admin tanpa payments.decide hanya dapat melihat (tanpa tombol keputusan)", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read"] });
    const user = userEvent.setup();
    await openPayments(user);
    const panel = await selectAhmad(user);
    expect(within(panel).queryByRole("button", { name: "Setujui" })).toBeNull();
    expect(within(panel).getByRole("note")).toHaveTextContent("hanya dapat melihat antrean");
  });

  it("konflik kepentingan: pembayaran milik alumni tertaut tidak dapat diputus admin tersebut", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    await user.click(screen.getByRole("button", { name: "Halaman berikutnya" }));
    await user.click(await screen.findByRole("button", { name: /Alumni Contoh 21/ }));
    const panel = await screen.findByRole("article", { name: "Alumni Contoh 21" });
    expect(within(panel).getByRole("note")).toHaveTextContent("tertaut ke akun admin Anda");
    expect(within(panel).queryByRole("button", { name: "Setujui" })).toBeNull();
  });

  it("admin pengaturan tanpa payments.read hanya melihat tab metode dan biaya", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["settings.manage"] });
    const user = userEvent.setup();
    // Judul mengikuti cakupan izin: admin ini tidak memverifikasi pembayaran.
    await openPayments(user, "Metode & Biaya Pembayaran");
    expect(screen.queryByRole("heading", { level: 1, name: "Verifikasi Pembayaran" })).toBeNull();
    const tabs = screen.getByRole("tablist", { name: "Menu pembayaran" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Kelola Metode", "Biaya Pembayaran"]);
    expect(screen.queryByRole("table")).toBeNull();
  });
});
