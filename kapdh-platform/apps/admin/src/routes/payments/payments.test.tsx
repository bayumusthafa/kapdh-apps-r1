import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockAuth, mockPayments, paymentRequests } from "../../api/mocks";
import { findToast, type User } from "../../test/utils";
import { IDS, openPayments, requestsTo } from "./testing";
import { PAYMENT_POLL_MS } from "./VerificationTab";

afterEach(() => {
  vi.useRealTimers();
});

async function selectAhmad(user: User) {
  await user.click(await screen.findByRole("button", { name: /Ahmad Islam/ }));
  return screen.findByRole("article", { name: "Ahmad Islam" });
}

const listRequests = () => paymentRequests.filter((r) => r.method === "GET" && r.path === "/admin/payments");
const decisionPosts = () => requestsTo("POST", /\/decision$/);

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
    expect(screen.getByText("Menampilkan 20 dari 23")).toBeInTheDocument();
    // "Menunggu" = stage awaiting_review (kontrak C3), bukan status=pending yang ikut memuat instruksi tanpa bukti.
    expect(listRequests()[0]?.query).toMatchObject({ stage: "awaiting_review" });
    expect(listRequests()[0]?.query).not.toHaveProperty("status");
    expect(listRequests()[0]?.query).not.toHaveProperty("sort");
    // Pill emas bersumber dari GET /admin/payments/summary dan sama dengan total "Menunggu".
    const nav = screen.getByRole("navigation", { name: "Menu admin" });
    await waitFor(() =>
      expect(within(nav).getByRole("link", { name: /Verifikasi Pembayaran/ })).toHaveTextContent("23"),
    );
    expect(paymentRequests.some((r) => r.path === "/admin/payments/summary")).toBe(true);
    // Hitungan tab: menunggu verifikasi dan penyesuaian yang menunggu proses.
    const tabs = screen.getByRole("tablist", { name: "Menu pembayaran" });
    await waitFor(() =>
      expect(within(tabs).getByRole("tab", { name: /Penyesuaian/ })).toHaveTextContent("Penyesuaian3"),
    );
  });

  it("paging kursor server: halaman berikutnya dan sebelumnya", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    await screen.findByText("Menampilkan 20 dari 23");
    await user.click(screen.getByRole("button", { name: "Halaman berikutnya" }));
    expect(await screen.findByText("Menampilkan 21–23 dari 23")).toBeInTheDocument();
    // Halaman terakhir: tombol nonaktif tetapi tetap memegang fokus (aria-disabled, N-11).
    const next = screen.getByRole("button", { name: "Halaman berikutnya" });
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(next).toHaveFocus();
    expect(listRequests().at(-1)?.query.cursor).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Halaman sebelumnya" }));
    expect(await screen.findByText("Menampilkan 20 dari 23")).toBeInTheDocument();
  });

  it("pencarian di-debounce: mengetik cepat hanya mengirim satu permintaan dengan kata kunci akhir", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    await screen.findByText("Menampilkan 20 dari 23");
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
    await screen.findByText("Menampilkan 20 dari 23");
    await user.selectOptions(screen.getByRole("combobox", { name: "Jenis" }), "ticket");
    await screen.findByText("Menampilkan 2 dari 2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "all");
    const table = await screen.findByRole("table", { name: "Antrean pembayaran" });
    await waitFor(() =>
      expect(within(table).getByRole("columnheader", { name: "Status" })).toBeInTheDocument(),
    );
    // Tiket yang sudah lunas ikut tampil di "Semua" beserta penanda pembatalan setelah lunas.
    await screen.findByText("Menampilkan 5 dari 5");
    expect(listRequests().at(-1)?.query).toMatchObject({ type: "ticket" });
    expect(listRequests().at(-1)?.query).not.toHaveProperty("status");
    expect(listRequests().at(-1)?.query).not.toHaveProperty("stage");
  });

  it("status Disetujui: keputusan terbaru dahulu dengan kolom waktu keputusan (kontrak decided_at_desc)", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    await screen.findByText("Menampilkan 20 dari 23");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "paid");
    await screen.findByText("Menampilkan 4 dari 4");
    expect(listRequests().at(-1)?.query).toMatchObject({ status: "paid", sort: "decided_at_desc" });
    const table = screen.getByRole("table", { name: "Antrean pembayaran" });
    expect(within(table).getAllByRole("columnheader")[0]).toHaveTextContent("Diputus (WIB)");
    const names = within(table)
      .getAllByRole("rowheader")
      .map((h) => h.textContent);
    expect(names[0]).toMatch(/Yusuf Hidayat/);
    // Pilihan urutan antrean hanya untuk "Menunggu".
    expect(screen.queryByRole("combobox", { name: "Urutan" })).toBeNull();
  });

  it("PRD 4.4, D5: urutan batas review terdekat mengirim sort=review_due_at_asc", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    await screen.findByText("Menampilkan 20 dari 23");
    await user.selectOptions(screen.getByRole("combobox", { name: "Urutan" }), "review_due_at_asc");
    await waitFor(() =>
      expect(listRequests().at(-1)?.query).toMatchObject({
        stage: "awaiting_review",
        sort: "review_due_at_asc",
      }),
    );
  });

  it("status Semua memuat instruksi tanpa bukti dengan label tahap; histori menampilkan ganti rekening", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    await screen.findByText("Menampilkan 20 dari 23");
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
    await screen.findByText("Menampilkan 20 dari 23");
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
    const decision = decisionPosts()[0];
    expect(decision?.body).toMatchObject({
      decision: "approve",
      funds_verified: true,
      expected_proof_version: 1,
      expected_version: "1",
    });
    expect(decision?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockPayments.get(IDS.ahmad)?.status).toBe("paid");
    // Antrean pending dimuat ulang: Ahmad tidak lagi menunggu.
    await waitFor(() =>
      expect(within(screen.getByRole("table")).queryByRole("button", { name: /Ahmad Islam/ })).toBeNull(),
    );
  });

  it("AC F03-5, F15-3: detail menampilkan snapshot rekening tujuan, versi bukti, versi biaya dan catatan transfer", async () => {
    const user = userEvent.setup();
    // Biaya diubah setelah tagihan Ahmad dibuat: tagihan tetap memakai snapshot versi 1 (AC F03-5).
    mockPayments.updateFeesAsOtherAdmin("70000.00", "15000.00", "20000.00");
    await openPayments(user);
    const panel = await selectAhmad(user);
    const terms = within(panel)
      .getAllByRole("term")
      .map((t) => t.textContent);
    expect(terms).toEqual(
      expect.arrayContaining([
        "Nominal tagihan",
        "Rekening tujuan",
        "Versi bukti",
        "Versi biaya",
        "Catatan transfer",
      ]),
    );
    expect(within(panel).getByText("Rp60.000")).toBeInTheDocument();
    expect(
      within(panel).getByText(/Register alumni baru Rp50\.000 \+ Pembuatan KTA Rp10\.000/),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/Bank \[Nama bank 1\]/)).toBeInTheDocument();
    expect(within(panel).getByText("[Nomor rekening] a.n. [Nama pemilik rekening]")).toBeInTheDocument();
    const valueOf = (term: string) => within(panel).getByText(term, { selector: "dt" }).nextElementSibling;
    expect(valueOf("Versi bukti")).toHaveTextContent(/^Versi 1$/);
    expect(valueOf("Versi biaya")).toHaveTextContent(
      /^Versi 1\s*Nominal mengikuti biaya saat tagihan dibuat\.$/,
    );
    expect(
      within(panel).getByText("Transfer m-banking a.n. Ahmad Islam pukul 14.15 WIB."),
    ).toBeInTheDocument();
  });

  it("AC F04-3: admin lain memutus lebih dulu → konflik, status terbaru dimuat dan diumumkan, formulir ditutup", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    const panel = await selectAhmad(user);
    await user.click(within(panel).getByRole("checkbox", { name: /dana Rp60\.000 sudah masuk/ }));
    mockPayments.decideAsOtherAdmin(IDS.ahmad, "approve");
    await user.click(within(panel).getByRole("button", { name: "Setujui" }));

    expect(await findToast("error", "Pembayaran sudah diputus admin lain")).toBeInTheDocument();
    const refreshed = await screen.findByRole("article", { name: "Ahmad Islam" });
    await waitFor(() =>
      expect(within(refreshed).getByRole("status")).toHaveTextContent(
        "Pembayaran ini sudah diputus admin lain: Disetujui.",
      ),
    );
    expect(within(refreshed).queryByRole("button", { name: "Setujui" })).toBeNull();
    expect(within(refreshed).getByText(/oleh Admin Keuangan/)).toBeInTheDocument();
    // Hanya satu keputusan berlaku: keputusan admin ini ditolak 409 dan tidak diulang.
    expect(decisionPosts()).toHaveLength(1);
    expect(mockPayments.get(IDS.ahmad)?.decided_by?.display_name).toBe("Admin Keuangan");
    expect(within(refreshed).getByRole("heading", { name: "Ahmad Islam" })).toHaveFocus();
  });

  it("AC F04-4: bukti diganti saat admin memutus → konflik, data terbaru dimuat, centang dana direset", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    const panel = await selectAhmad(user);
    await user.click(within(panel).getByRole("checkbox", { name: /dana Rp60\.000 sudah masuk/ }));
    mockPayments.replaceProof(IDS.ahmad);
    await user.click(within(panel).getByRole("button", { name: "Setujui" }));

    expect(await findToast("error", "Bukti sudah diganti")).toBeInTheDocument();
    const refreshed = await screen.findByRole("article", { name: "Ahmad Islam" });
    expect(await within(refreshed).findByText(/versi bukti 2/)).toBeInTheDocument();
    const checkbox = within(refreshed).getByRole("checkbox", { name: /dana Rp60\.000 sudah masuk/ });
    expect(checkbox).not.toBeChecked();
    expect(within(refreshed).getByRole("button", { name: "Setujui" })).toBeDisabled();
    expect(mockPayments.get(IDS.ahmad)?.status).toBe("pending");
    // Formulir dipasang ulang (tombol Setujui yang difokus hilang): fokus ke judul panel dan alasan diumumkan.
    expect(within(refreshed).getByRole("status")).toHaveTextContent(
      "Bukti transfer diganti alumni (versi 2). Centang dana dan alasan dikosongkan",
    );
    expect(within(refreshed).getByRole("heading", { name: "Ahmad Islam" })).toHaveFocus();
  });

  it("AC F04-4: versi data berubah tanpa bukti baru → centang dana direset; keputusan berikutnya memakai versi baru", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    const panel = await selectAhmad(user);
    await user.click(within(panel).getByRole("checkbox", { name: /dana Rp60\.000 sudah masuk/ }));
    mockPayments.touch(IDS.ahmad);
    await user.click(within(panel).getByRole("button", { name: "Setujui" }));

    expect(await findToast("error", "Data pembayaran sudah berubah")).toBeInTheDocument();
    const refreshed = await screen.findByRole("article", { name: "Ahmad Islam" });
    await waitFor(() =>
      expect(within(refreshed).getByRole("status")).toHaveTextContent(
        "Data pembayaran diperbarui. Centang dana dan alasan dikosongkan",
      ),
    );
    const checkbox = within(refreshed).getByRole("checkbox", { name: /dana Rp60\.000 sudah masuk/ });
    expect(checkbox).not.toBeChecked();
    expect(within(refreshed).getByRole("button", { name: "Setujui" })).toBeDisabled();

    await user.click(checkbox);
    await user.click(within(refreshed).getByRole("button", { name: "Setujui" }));
    expect(await within(refreshed).findByRole("status")).toHaveTextContent("Pembayaran disetujui.");
    const posts = decisionPosts();
    expect(posts).toHaveLength(2);
    expect(posts[0]?.body).toMatchObject({ expected_version: "1" });
    expect(posts[1]?.body).toMatchObject({ expected_version: "2" });
    // Muat ulang = niat baru: Idempotency-Key berbeda (PRD 4.3).
    expect(posts[1]?.idempotencyKey).not.toBe(posts[0]?.idempotencyKey);
  });

  it("AC F04-4: polling melihat bukti baru saat admin mengetik alasan → formulir direset, diumumkan, fokus ke judul", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openPayments(user);
    const panel = await selectAhmad(user);
    const reason = within(panel).getByRole("textbox", { name: /Alasan penolakan/ });
    await user.type(reason, "Nominal kurang");
    expect(reason).toHaveFocus();
    mockPayments.replaceProof(IDS.ahmad);
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

  it("U-02, AC F03-3: histori memuat alasan penolakan sebelumnya dan bukti versi lama dapat dibuka", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    await user.click(await screen.findByRole("button", { name: /Siti Rahmawati/ }));
    const panel = await screen.findByRole("article", { name: "Siti Rahmawati" });
    expect(within(panel).getByText("Pernah ditolak 1 kali")).toBeInTheDocument();
    expect(within(panel).getByText("Alasan penolakan sebelumnya")).toBeInTheDocument();
    expect(within(panel).getByText("Foto bukti buram sehingga nominal tidak terbaca.")).toBeInTheDocument();
    expect(await within(panel).findByRole("img", { name: /Siti Rahmawati, versi 2/ })).toBeInTheDocument();

    await user.click(within(panel).getByText(/Riwayat lengkap \(4\)/));
    const history = within(panel).getByRole("list", { name: "Riwayat pembayaran" });
    const rejected = within(history).getByText("Ditolak (versi 1)").closest("li")!;
    expect(rejected).toHaveTextContent(
      "Pengurus: Admin Keuangan | Alasan penolakan: Foto bukti buram sehingga nominal tidak terbaca.",
    );
    expect(within(history).getByText("Bukti diganti (versi 2)")).toBeInTheDocument();

    await user.click(within(history).getByRole("button", { name: "Lihat bukti versi 1" }));
    const dialog = await screen.findByRole("dialog", { name: "Bukti transfer versi 1" });
    expect(dialog).toHaveAccessibleDescription(/sudah diganti alumni/);
    expect(await within(dialog).findByRole("img", { name: /Siti Rahmawati, versi 1/ })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Tutup" }));
    expect(within(history).getByRole("button", { name: "Lihat bukti versi 2 (aktif)" })).toBeInTheDocument();
  });

  it("N-10: bukti PDF ditampilkan sebagai dokumen PDF dengan tautan buka di tab baru", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    await user.click(await screen.findByRole("button", { name: /Rizky Pratama/ }));
    const panel = await screen.findByRole("article", { name: "Rizky Pratama" });
    expect(await within(panel).findByText("Dokumen PDF")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: /Buka PDF/ })).toHaveAttribute("target", "_blank");
    expect(within(panel).queryByRole("img")).toBeNull();
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
    expect(mockPayments.get(IDS.ahmad)?.status).toBe("rejected");
    expect(decisionPosts()[0]?.body).toMatchObject({ decision: "reject", reason: "Nominal tidak sesuai" });
  });

  it("PRD 4.3: batalkan instruksi tanpa bukti wajib alasan, konfirmasi dua langkah dan If-Match", async () => {
    const user = userEvent.setup();
    await openPayments(user, { search: `payment=${IDS.hasan}` });
    const panel = await screen.findByRole("article", { name: "Hasan Basri" });
    await user.click(within(panel).getByRole("button", { name: "Batalkan instruksi" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Batalkan instruksi pembayaran\?/ });
    const confirm = within(dialog).getByRole("button", { name: "Batalkan instruksi" });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(confirm);
    const reason = within(dialog).getByRole("textbox", { name: /Alasan pembatalan/ });
    expect(reason).toHaveAccessibleDescription(/minimal 3 karakter/);
    expect(requestsTo("POST", /\/cancel$/)).toHaveLength(0);

    await user.type(reason, "Instruksi ditinggalkan lebih dari 30 hari");
    await user.click(confirm);
    expect(await within(panel).findByRole("status")).toHaveTextContent(
      "Instruksi pembayaran dibatalkan dan pemilik diberi notifikasi.",
    );
    expect(mockPayments.get(IDS.hasan)).toMatchObject({
      status: "cancelled",
      cancel_reason: "Instruksi ditinggalkan lebih dari 30 hari",
    });
    const sent = requestsTo("POST", /\/cancel$/)[0];
    expect(sent?.ifMatch).toBe("2");
    expect(sent?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(within(panel).queryByRole("button", { name: "Batalkan instruksi" })).toBeNull();
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
    expect(mockPayments.get(IDS.deleted)?.status).toBe("paid");
    // Tanpa pemilik: tidak ada periode keanggotaan (PRD 4.4).
    expect(mockPayments.get(IDS.deleted)?.period).toBeNull();
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
    const decided = mockPayments.get(IDS.dewi);
    expect(decided?.status).toBe("paid");
    expect(decided?.ticket?.ticket_status).toBe("cancelled");
    expect(decided?.adjustments).toMatchObject([
      { kind: "refund", amount: "50000.00", status: "pending", created_by: null },
    ]);
    // Refund sistem langsung terlihat di bagian penyesuaian panel dengan tautan ke tab Penyesuaian.
    const section = await within(panel).findByRole("region", { name: /Penyesuaian \(1\)/ });
    expect(within(section).getByText("Refund Rp50.000")).toBeInTheDocument();
    expect(within(section).getByText("Menunggu proses")).toBeInTheDocument();
  });

  it("AC F15-1: admin tanpa payments.decide hanya dapat melihat (tanpa tombol keputusan)", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read"] });
    const user = userEvent.setup();
    await openPayments(user);
    const panel = await selectAhmad(user);
    expect(within(panel).queryByRole("button", { name: "Setujui" })).toBeNull();
    expect(within(panel).getByRole("note")).toHaveTextContent("hanya dapat melihat antrean");
  });

  it("PRD 2.3: pembayaran milik alumni tertaut tidak dapat diputus admin tersebut", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    await user.click(screen.getByRole("button", { name: "Halaman berikutnya" }));
    await user.click(await screen.findByRole("button", { name: /Alumni Contoh 21/ }));
    const panel = await screen.findByRole("article", { name: "Alumni Contoh 21" });
    expect(within(panel).getByRole("note")).toHaveTextContent("tertaut ke akun admin Anda");
    expect(within(panel).queryByRole("button", { name: "Setujui" })).toBeNull();
  });

  it("AC F15-1: admin pengaturan tanpa payments.read hanya melihat tab metode dan biaya", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["settings.manage"] });
    const user = userEvent.setup();
    // Judul mengikuti cakupan izin: admin ini tidak memverifikasi pembayaran.
    await openPayments(user, { title: "Metode & Biaya Pembayaran" });
    expect(screen.queryByRole("heading", { level: 1, name: "Verifikasi Pembayaran" })).toBeNull();
    const tabs = screen.getByRole("tablist", { name: "Menu pembayaran" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Kelola Metode", "Biaya Pembayaran"]);
    expect(await screen.findByRole("table", { name: "Metode pembayaran" })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Antrean pembayaran" })).toBeNull();
    // Antrean dan ringkasan tidak pernah diminta tanpa payments.read.
    expect(paymentRequests.some((r) => r.path.startsWith("/admin/payments"))).toBe(false);
  });
});
