import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mockAuth, mockPayments } from "../../api/mocks";
import { findToast, type User } from "../../test/utils";
import { IDS, openPayments, requestsTo } from "./testing";

beforeAll(() => {
  // jsdom tidak menyediakan object URL; pratinjau lokal unggahan cukup memakai URL tiruan.
  URL.createObjectURL = vi.fn(() => "blob:pratinjau");
  URL.revokeObjectURL = vi.fn();
});

const adjustmentLists = () => requestsTo("GET", "/admin/payment-adjustments");

async function adjustmentsTable() {
  return screen.findByRole("table", { name: "Daftar penyesuaian" });
}

function rowOf(table: HTMLElement, name: string): HTMLElement {
  return within(table)
    .getByRole("button", { name: new RegExp(name) })
    .closest("tr")!;
}

async function openAdjustment(user: User, name: string, title: string) {
  const table = await adjustmentsTable();
  await user.click(within(table).getByRole("button", { name: new RegExp(name) }));
  return screen.findByRole("article", { name: title });
}

function pngFile(name = "bukti-refund.png"): File {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: "image/png" });
}

describe("penyesuaian refund dan koreksi (D6, D2, PRD 3.4; server tiruan)", () => {
  it("D6: antrean menunggu proses diurutkan tenggat terdekat; lewat tenggat bertanda teks; rekening tidak pernah di daftar", async () => {
    const user = userEvent.setup();
    await openPayments(user, { tab: "adjustments" });
    const table = await adjustmentsTable();
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Tenggat", "Alumni", "Pembayaran asal", "Penyesuaian", "Status"]);
    const names = within(table)
      .getAllByRole("rowheader")
      .map((h) => h.textContent);
    expect(names).toEqual([
      expect.stringMatching(/^Laila Fitriani/),
      expect.stringMatching(/^Fajar Nugroho/),
      expect.stringMatching(/^Yusuf Hidayat/),
    ]);
    expect(screen.getByText("Menampilkan 3 dari 3")).toBeInTheDocument();
    expect(adjustmentLists()[0]?.query).toMatchObject({ status: "pending" });
    expect(adjustmentLists()[0]?.query).not.toHaveProperty("sort");

    const laila = rowOf(table, "Laila Fitriani");
    expect(within(laila).getByText("Lewat tenggat")).toBeInTheDocument();
    expect(within(laila).getByText("Siap ditransfer")).toBeInTheDocument();
    expect(within(laila).getByText("Tiket: Halal bi Halal")).toBeInTheDocument();
    expect(within(rowOf(table, "Fajar Nugroho")).getByText("Menunggu rekening")).toBeInTheDocument();
    const yusuf = rowOf(table, "Yusuf Hidayat");
    expect(within(yusuf).getByText("Tanpa tenggat")).toBeInTheDocument();
    expect(within(yusuf).getByText("Koreksi")).toBeInTheDocument();
    // Nilai rekening tujuan tidak pernah dikirim di daftar (D2).
    expect(screen.queryByText("[Nomor rekening refund]")).toBeNull();

    // Filter rekening tujuan menyiratkan refund (koreksi tidak memiliki rekening).
    await user.selectOptions(screen.getByRole("combobox", { name: "Rekening tujuan" }), "missing");
    await screen.findByText("Menampilkan 1 dari 1");
    expect(screen.getByRole("combobox", { name: "Jenis" })).toHaveValue("refund");
    expect(adjustmentLists().at(-1)?.query).toMatchObject({
      status: "pending",
      kind: "refund",
      has_refund_destination: "false",
    });
  });

  it("D6, D2: rekening tampil selama pending; tandai selesai wajib bukti transfer, lalu rekening dihapus", async () => {
    const user = userEvent.setup();
    await openPayments(user, { tab: "adjustments" });
    const panel = await openAdjustment(user, "Laila Fitriani", "Refund Rp75.000");
    const destination = within(panel).getByRole("region", { name: "Rekening tujuan refund" });
    expect(destination).toHaveTextContent("[Bank tujuan refund]");
    expect(destination).toHaveTextContent("[Nomor rekening refund]");
    expect(destination).toHaveTextContent("Laila Fitriani");
    expect(within(panel).getByText(/oleh sistem \(otomatis, D6\)/)).toBeInTheDocument();

    await user.click(await within(panel).findByRole("button", { name: "Tandai selesai" }));
    const dialog = await screen.findByRole("dialog", { name: "Tandai refund selesai" });
    expect(dialog).toHaveTextContent(
      "Transfer Rp75.000 ke [Bank tujuan refund] [Nomor rekening refund] a.n. Laila Fitriani.",
    );
    const done = within(dialog).getByRole("button", { name: "Tandai selesai" });
    expect(done).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: /sudah saya transfer/ }));
    await user.click(done);
    expect(
      await within(dialog).findByText("Lampirkan bukti transfer refund sebelum menandai selesai."),
    ).toBeInTheDocument();
    expect(requestsTo("POST", /\/complete$/)).toHaveLength(0);

    await user.upload(within(dialog).getByTestId("file-input"), pngFile());
    await within(dialog).findByText("Berkas siap dilampirkan.");
    await user.click(done);

    expect(await within(panel).findByRole("status")).toHaveTextContent(
      "Refund ditandai selesai. Rekening tujuan dihapus dan pemilik diberi notifikasi.",
    );
    const sent = requestsTo("POST", /\/complete$/)[0];
    expect(sent?.ifMatch).toBe("1");
    expect(sent?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent?.body).toMatchObject({ evidence_file_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(within(panel).getByText("Selesai", { selector: "dt" }).nextElementSibling).toHaveTextContent(
      "oleh Bayu Musthafa",
    );
    expect(within(panel).queryByRole("region", { name: "Rekening tujuan refund" })).toBeNull();
    expect(screen.queryByText("[Nomor rekening refund]")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Tandai selesai" })).toBeNull();
    expect(within(panel).getByRole("heading", { name: "Refund Rp75.000" })).toHaveFocus();
    expect(mockPayments.adjustment(IDS.lailaRefund)).toMatchObject({
      status: "completed",
      refund_destination: null,
      has_refund_destination: false,
    });
    expect(mockPayments.get(IDS.laila)?.events.at(-1)).toMatchObject({
      kind: "adjusted",
      reason: "Refund selesai",
    });
    await screen.findByText("Menampilkan 2 dari 2");
  });

  it("D2, PRD 4.5: batalkan penyesuaian wajib alasan dan konfirmasi dua langkah", async () => {
    const user = userEvent.setup();
    await openPayments(user, { tab: "adjustments" });
    const panel = await openAdjustment(user, "Fajar Nugroho", "Refund Rp50.000");
    expect(within(panel).getByRole("region", { name: "Rekening tujuan refund" })).toHaveTextContent(
      "Menunggu rekening tujuan dari pemilik",
    );
    await user.click(await within(panel).findByRole("button", { name: "Batalkan" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Batalkan refund\?/ });
    const confirm = within(dialog).getByRole("button", { name: "Batalkan penyesuaian" });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(confirm);
    const reason = within(dialog).getByRole("textbox", { name: /Alasan pembatalan/ });
    expect(reason).toHaveAccessibleDescription(/minimal 3 karakter/);
    // N-11: fokus pindah ke isian alasan sehingga galatnya dibacakan (bukan tertinggal di tombol konfirmasi).
    await waitFor(() => expect(reason).toHaveFocus());
    expect(reason).toHaveAttribute("aria-invalid", "true");
    expect(requestsTo("POST", /\/cancel$/)).toHaveLength(0);

    await user.type(reason, "Peserta memilih tiket dialihkan ke event pengganti");
    await user.click(confirm);
    expect(await within(panel).findByRole("status")).toHaveTextContent("Refund dibatalkan.");
    const sent = requestsTo("POST", /\/cancel$/)[0];
    expect(sent?.ifMatch).toBe("1");
    expect(sent?.body).toEqual({ reason: "Peserta memilih tiket dialihkan ke event pengganti" });
    expect(within(panel).getByText("Dibatalkan", { selector: "dt" }).nextElementSibling).toHaveTextContent(
      "oleh Bayu Musthafa | Alasan: Peserta memilih tiket dialihkan ke event pengganti",
    );
    expect(mockPayments.adjustment(IDS.fajarRefund)).toMatchObject({
      status: "cancelled",
      cancel_reason: "Peserta memilih tiket dialihkan ke event pengganti",
    });
  });

  it("AC F15-4: pemilik mengirim rekening saat admin mengubah penyesuaian → konflik versi, data terbaru dimuat", async () => {
    const user = userEvent.setup();
    await openPayments(user, { tab: "adjustments" });
    const panel = await openAdjustment(user, "Fajar Nugroho", "Refund Rp50.000");
    await user.click(await within(panel).findByRole("button", { name: "Ubah" }));
    const dialog = await screen.findByRole("dialog", { name: "Ubah refund" });
    await user.click(within(dialog).getByRole("checkbox", { name: /Catat rekening tujuan refund/ }));
    await user.type(
      within(dialog).getByRole("textbox", { name: /Nama bank atau e-wallet/ }),
      "[[Bank dari admin]",
    );
    await user.type(within(dialog).getByRole("textbox", { name: /Nomor rekening/ }), "111");
    await user.type(within(dialog).getByRole("textbox", { name: /Nama pemilik rekening/ }), "Fajar N");
    mockPayments.setRefundDestination(IDS.fajarRefund, {
      provider: "[Bank pilihan pemilik]",
      account_number: "[Rekening pemilik]",
      account_holder: "Fajar Nugroho",
    });
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));

    expect(await findToast("error", "Penyesuaian sudah diubah")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Ubah refund" })).toBeNull());
    const destination = within(panel).getByRole("region", { name: "Rekening tujuan refund" });
    expect(destination).toHaveTextContent("[Bank pilihan pemilik]");
    expect(within(panel).getByRole("status")).toHaveTextContent("Penyesuaian diperbarui pihak lain");
    const patch = requestsTo("PATCH", /^\/admin\/payment-adjustments\//)[0];
    expect(patch?.ifMatch).toBe("1");
    expect(mockPayments.adjustment(IDS.fajarRefund)?.refund_destination).toMatchObject({
      provider: "[Bank pilihan pemilik]",
    });
  });

  it("D6: catat refund dari detail pembayaran lunas; total refund tidak boleh melebihi nominal pembayaran", async () => {
    const user = userEvent.setup();
    await openPayments(user, { search: `payment=${IDS.yusuf}` });
    const panel = await screen.findByRole("article", { name: "Yusuf Hidayat" });
    const section = within(panel).getByRole("region", { name: /Penyesuaian \(1\)/ });
    await user.click(within(section).getByRole("button", { name: "Catat penyesuaian" }));
    const dialog = await screen.findByRole("dialog", { name: "Catat penyesuaian" });
    expect(within(dialog).getByRole("radio", { name: /Refund/ })).toBeChecked();
    expect(dialog).toHaveTextContent("Sisa yang dapat direfund Rp10.000");
    const amount = within(dialog).getByRole("textbox", { name: /Nominal/ });
    await user.type(amount, "15.000");
    await user.type(
      within(dialog).getByRole("textbox", { name: /Alasan/ }),
      "Anggota membatalkan perpanjangan",
    );
    await user.click(within(dialog).getByRole("button", { name: "Simpan penyesuaian" }));
    await waitFor(() =>
      expect(amount).toHaveAccessibleDescription("Melebihi sisa yang dapat direfund (Rp10.000)."),
    );
    expect(requestsTo("POST", /\/adjustments$/)).toHaveLength(0);

    await user.clear(amount);
    await user.type(amount, "10.000");
    await user.click(within(dialog).getByRole("button", { name: "Simpan penyesuaian" }));
    expect(await within(panel).findByRole("status")).toHaveTextContent(
      "Refund dicatat. Pemilik diberi notifikasi untuk mengirim rekening tujuan.",
    );
    const sent = requestsTo("POST", /\/adjustments$/)[0];
    expect(sent?.path).toBe(`/admin/payments/${IDS.yusuf}/adjustments`);
    expect(sent?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent?.body).toEqual({
      kind: "refund",
      amount: "10000.00",
      reason: "Anggota membatalkan perpanjangan",
    });
    // Status lunas tidak berubah; penyesuaian dicatat terpisah (ARCHITECTURE §2 butir 13).
    expect(mockPayments.get(IDS.yusuf)?.status).toBe("paid");
    const updated = await within(panel).findByRole("region", { name: /Penyesuaian \(2\)/ });
    await user.click(
      within(updated).getByRole("button", { name: "Buka refund Rp10.000 di tab Penyesuaian" }),
    );
    const adjustment = await screen.findByRole("article", { name: "Refund Rp10.000" });
    expect(within(adjustment).getByRole("region", { name: "Rekening tujuan refund" })).toHaveTextContent(
      "Menunggu rekening tujuan dari pemilik",
    );
    expect(screen.getByRole("tab", { name: /Penyesuaian/ })).toHaveAttribute("aria-selected", "true");
  });

  it("D6: penyesuaian selesai menampilkan bukti penyelesaian dan tautan ke pembayaran asal", async () => {
    const user = userEvent.setup();
    await openPayments(user, { tab: "adjustments" });
    await adjustmentsTable();
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "completed");
    await screen.findByText("Menampilkan 1 dari 1");
    const panel = await openAdjustment(user, "Gita Permata", "Refund Rp75.000");
    expect(
      await within(panel).findByRole("img", { name: /Bukti penyelesaian refund Gita Permata/ }),
    ).toBeInTheDocument();
    expect(within(panel).getByText("Selesai", { selector: "dt" }).nextElementSibling).toHaveTextContent(
      "oleh Admin Keuangan",
    );
    expect(within(panel).queryByRole("region", { name: "Rekening tujuan refund" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Tandai selesai" })).toBeNull();
    await user.click(within(panel).getByRole("button", { name: "Buka pembayaran asal" }));
    const payment = await screen.findByRole("article", { name: "Gita Permata" });
    expect(within(payment).getByRole("region", { name: /Penyesuaian \(2\)/ })).toHaveTextContent(
      "Dibatalkan",
    );
  });

  it("AC F15-1, D2: admin tanpa payments.decide melihat penyesuaian tanpa tombol proses dan tanpa isi rekening", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read"] });
    const user = userEvent.setup();
    await openPayments(user, { tab: "adjustments" });
    const panel = await openAdjustment(user, "Laila Fitriani", "Refund Rp75.000");
    expect(within(panel).queryByRole("button", { name: "Tandai selesai" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Batalkan" })).toBeNull();
    expect(within(panel).getByText(/hanya dapat melihat penyesuaian/)).toBeInTheDocument();
    expect(within(panel).getByRole("region", { name: "Rekening tujuan refund" })).toHaveTextContent(
      "Rekening tujuan sudah dikirim pemilik",
    );
    expect(screen.queryByText("[Nomor rekening refund]")).toBeNull();
  });

  it("PRD 2.3: penyesuaian atas payment milik alumni tertaut tidak dapat diproses admin tersebut", async () => {
    mockPayments.linkOwnerToAdmin(IDS.laila);
    const user = userEvent.setup();
    await openPayments(user, { tab: "adjustments" });
    const panel = await openAdjustment(user, "Laila Fitriani", "Refund Rp75.000");
    const note = await within(panel).findByRole("note");
    expect(note).toHaveTextContent("tertaut ke akun admin Anda");
    expect(within(panel).queryByRole("button", { name: "Tandai selesai" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Ubah" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Batalkan" })).toBeNull();
    // Konflik dihitung server pada payment asal; rekening tujuan juga tidak dikirim kepada admin ini (D2).
    expect(requestsTo("GET", `/admin/payments/${IDS.laila}`)).not.toHaveLength(0);
    expect(within(panel).getByRole("region", { name: "Rekening tujuan refund" })).toHaveTextContent(
      "Rekening tujuan sudah dikirim pemilik",
    );
    expect(screen.queryByText("[Nomor rekening refund]")).toBeNull();
  });

  it("PRD 4.5, D2: menghapus rekening tujuan tersimpan lewat Ubah wajib konfirmasi dua langkah", async () => {
    const user = userEvent.setup();
    await openPayments(user, { tab: "adjustments" });
    const panel = await openAdjustment(user, "Laila Fitriani", "Refund Rp75.000");
    await user.click(await within(panel).findByRole("button", { name: "Ubah" }));
    const dialog = await screen.findByRole("dialog", { name: "Ubah refund" });
    await user.click(within(dialog).getByRole("checkbox", { name: /Catat rekening tujuan refund/ }));
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));

    // Langkah konfirmasi: belum ada PATCH; batal kembali ke formulir tanpa mengirim apa pun.
    let confirm = await screen.findByRole("alertdialog", { name: /Hapus rekening tujuan refund\?/ });
    expect(confirm).toHaveAccessibleDescription(/dihapus permanen/);
    expect(requestsTo("PATCH", /^\/admin\/payment-adjustments\//)).toHaveLength(0);
    await user.click(within(confirm).getByRole("button", { name: "Batal" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Ubah refund" })).toBeInTheDocument();
    expect(requestsTo("PATCH", /^\/admin\/payment-adjustments\//)).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));
    confirm = await screen.findByRole("alertdialog", { name: /Hapus rekening tujuan refund\?/ });
    const remove = within(confirm).getByRole("button", { name: "Hapus rekening dan simpan" });
    expect(remove).toBeDisabled();
    await user.click(within(confirm).getByRole("checkbox"));
    await user.click(remove);

    expect(await within(panel).findByRole("status")).toHaveTextContent(
      "Penyesuaian diperbarui. Rekening tujuan refund dihapus.",
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Ubah refund" })).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const patch = requestsTo("PATCH", /^\/admin\/payment-adjustments\//);
    expect(patch).toHaveLength(1);
    expect(patch[0]?.ifMatch).toBe("1");
    expect(patch[0]?.body).toEqual({ refund_destination: null });
    expect(mockPayments.adjustment(IDS.lailaRefund)).toMatchObject({
      refund_destination: null,
      has_refund_destination: false,
    });
  });

  it("D6, D2: refund tanpa rekening tercatat diperingatkan saat ditandai selesai; pernyataan tidak merujuk rekening", async () => {
    const user = userEvent.setup();
    await openPayments(user, { tab: "adjustments" });
    const panel = await openAdjustment(user, "Fajar Nugroho", "Refund Rp50.000");
    await user.click(await within(panel).findByRole("button", { name: "Tandai selesai" }));
    const dialog = await screen.findByRole("dialog", { name: "Tandai refund selesai" });
    expect(within(dialog).getByRole("note")).toHaveTextContent(
      "Belum ada rekening tujuan yang tercatat. Catat rekening lewat Ubah",
    );
    expect(within(dialog).getByRole("note")).toHaveTextContent(
      "pemilik tidak dapat lagi mengirim rekening tujuan",
    );
    expect(within(dialog).queryByRole("checkbox", { name: /rekening tujuan di atas/ })).toBeNull();
    expect(within(dialog).getByRole("checkbox", { name: /sudah saya pastikan benar/ })).toBeInTheDocument();
    // Refund dengan rekening tercatat tetap merujuk rekening yang ditampilkan.
    await user.click(within(dialog).getByRole("button", { name: "Batal" }));
    const laila = await openAdjustment(user, "Laila Fitriani", "Refund Rp75.000");
    await user.click(await within(laila).findByRole("button", { name: "Tandai selesai" }));
    const withDestination = await screen.findByRole("dialog", { name: "Tandai refund selesai" });
    expect(within(withDestination).queryByRole("note")).toBeNull();
    expect(
      within(withDestination).getByRole("checkbox", { name: /rekening tujuan di atas/ }),
    ).toBeInTheDocument();
  });

  it("N-11, PRD 4.5: tautan antartab memindah fokus ke judul panel yang dibuka, tidak jatuh ke body", async () => {
    const user = userEvent.setup();
    await openPayments(user, { search: `payment=${IDS.laila}` });
    const payment = await screen.findByRole("article", { name: "Laila Fitriani" });
    const section = within(payment).getByRole("region", { name: /Penyesuaian \(1\)/ });
    await user.click(
      within(section).getByRole("button", { name: "Buka refund Rp75.000 di tab Penyesuaian" }),
    );
    const adjustment = await screen.findByRole("article", { name: "Refund Rp75.000" });
    await waitFor(() =>
      expect(within(adjustment).getByRole("heading", { name: "Refund Rp75.000" })).toHaveFocus(),
    );

    await user.click(within(adjustment).getByRole("button", { name: "Buka pembayaran asal" }));
    const back = await screen.findByRole("article", { name: "Laila Fitriani" });
    await waitFor(() => expect(within(back).getByRole("heading", { name: "Laila Fitriani" })).toHaveFocus());
  });
});
