import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";
import { mockPayments, paymentRequests } from "../../api/mocks";
import { expectNoReauthDialog } from "../../test/governance";
import { findToast, toasts, type User } from "../../test/utils";
import { openPayments, requestsTo } from "./testing";

/**
 * Metode bayar QRIS dengan gambar QR (permintaan PO 2026-10-15, ADR-026) terhadap server tiruan
 * src/api/mocks/payments.ts, yang respons setiap cabangnya divalidasi terhadap kontrak di
 * src/api/mocks/contract-conformance.test.ts. Bukti mock bukan bukti AC sisi server (PRD 7.3); aturan server diuji di
 * apps/api/test/payments/payment-methods-qris.e2e.test.ts.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HINT =
  "Gunakan QRIS statis resmi organisasi (tanpa nominal), PNG/JPG minimal 512 px, maksimal 5 MB. Gambar ini ditampilkan ke alumni.";
/** NMID dan merchant metode QRIS contoh `mockPayments.addQrisMethod()`. */
const NMID = "ID1022334455667";
const MERCHANT = "KAPDH PUSAT";

// Potongan kode halaman dimuat lazy; transformasi pertamanya dilakukan di sini, bukan di dalam batas waktu tes pertama.
beforeAll(async () => {
  await import("./PaymentsPage");
}, 120_000);

/** PNG minimal dengan header IHDR berdimensi tertentu (server tiruan membaca dimensi dari header). */
function pngFile(width: number, height: number, name = "qris.png"): File {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return new File([bytes], name, { type: "image/png" });
}

const methodRequests = (method: string) => requestsTo(method, /^\/admin\/payment-methods/);
const qrUploads = () => requestsTo("POST", "/admin/payment-qr-images");

async function methodsTable(): Promise<HTMLElement> {
  return screen.findByRole("table", { name: "Metode pembayaran" });
}

function rowOf(table: HTMLElement, provider: RegExp): HTMLElement {
  return within(table).getByRole("rowheader", { name: provider }).closest("tr")!;
}

async function openAddDialog(user: User): Promise<HTMLElement> {
  await openPayments(user, { tab: "methods" });
  await methodsTable();
  await user.click(screen.getByRole("button", { name: "Tambah metode" }));
  return screen.findByRole("dialog", { name: "Tambah metode pembayaran" });
}

async function openEditDialog(user: User, provider = "QRIS"): Promise<HTMLElement> {
  await openPayments(user, { tab: "methods" });
  await methodsTable();
  await user.click(screen.getByRole("button", { name: `Ubah ${provider}` }));
  return screen.findByRole("dialog", { name: "Ubah metode pembayaran" });
}

const qrButton = (dialog: HTMLElement, action: "Pilih gambar" | "Ganti gambar" | "Mengunggah") =>
  within(dialog).getByRole("button", { name: `${action}: Gambar QRIS` });
const qrInput = (dialog: HTMLElement) => within(dialog).getByTestId("payment-qr-input");
const save = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: "Simpan metode" });

describe("metode bayar QRIS bergambar (ADR-026; server tiruan)", () => {
  it("ADR-026: jenis QRIS mengganti label isian, mengisi nama metode, dan mewajibkan gambar QRIS sebelum permintaan dikirim", async () => {
    const user = userEvent.setup();
    const dialog = await openAddDialog(user);
    const kinds = within(dialog).getByRole("group", { name: /Jenis rekening/ });
    expect(
      within(kinds)
        .getAllByRole("radio")
        .map((r) => r.closest("label")?.textContent),
    ).toEqual(["Bank", "E-wallet", "QRIS"]);
    expect(within(dialog).queryByRole("group", { name: /Gambar QRIS/ })).toBeNull();

    await user.click(within(kinds).getByRole("radio", { name: "QRIS" }));
    expect(within(dialog).getByRole("textbox", { name: /^Nama metode/ })).toHaveValue("QRIS");
    const nmid = within(dialog).getByRole("textbox", { name: /^NMID/ });
    const merchant = within(dialog).getByRole("textbox", { name: /^Nama merchant/ });
    expect(within(dialog).queryByRole("textbox", { name: /Nomor rekening/ })).toBeNull();
    expect(within(dialog).queryByRole("textbox", { name: /Nama bank atau e-wallet/ })).toBeNull();
    // Kelompok gambar bernama dan wajib; petunjuk dibacakan sebagai deskripsi tombol pilih (N-11).
    const group = within(dialog).getByRole("group", { name: /^Gambar QRIS/ });
    expect(group).toHaveAccessibleName(/^Gambar QRIS\s*\(wajib\)$/);
    expect(within(group).getByText(HINT)).toBeInTheDocument();
    expect(qrButton(dialog, "Pilih gambar")).toHaveAccessibleDescription(HINT);

    // Kosong: galat per label QRIS, fokus ke isian bergalat pertama, tidak ada permintaan.
    await user.click(save(dialog));
    await waitFor(() => expect(nmid).toHaveAccessibleDescription(/NMID wajib diisi\./));
    expect(nmid).toHaveFocus();
    expect(merchant).toHaveAccessibleDescription(/Nama merchant wajib diisi\./);
    expect(within(group).getByRole("alert")).toHaveTextContent("Gambar QRIS wajib diunggah.");

    await user.type(nmid, NMID);
    await user.type(merchant, MERCHANT);
    await user.click(save(dialog));
    // Hanya gambar yang kurang: tombol pilih gambar difokus dan galatnya terbaca.
    await waitFor(() => expect(qrButton(dialog, "Pilih gambar")).toHaveFocus());
    expect(qrButton(dialog, "Pilih gambar")).toHaveAccessibleDescription(
      `Gambar QRIS wajib diunggah. ${HINT}`,
    );
    expect(methodRequests("POST")).toHaveLength(0);
    expect(qrUploads()).toHaveLength(0);

    // Kembali ke bank: nama metode bawaan dikosongkan dan isian gambar hilang.
    await user.click(within(kinds).getByRole("radio", { name: "Bank" }));
    expect(within(dialog).getByRole("textbox", { name: /^Nama bank atau e-wallet/ })).toHaveValue("");
    expect(within(dialog).queryByRole("group", { name: /Gambar QRIS/ })).toBeNull();
    expect(within(dialog).getByRole("textbox", { name: /^Nomor rekening/ })).toHaveValue(NMID);
  });

  it("ADR-026, N-10: gambar diunggah multipart tanpa Idempotency-Key, pratinjau tampil, id gambar ikut dikirim saat simpan; tabel menandai QRIS dan NMID", async () => {
    const user = userEvent.setup();
    const dialog = await openAddDialog(user);
    await user.click(within(dialog).getByRole("radio", { name: "QRIS" }));
    await user.type(within(dialog).getByRole("textbox", { name: /^NMID/ }), NMID);
    await user.type(within(dialog).getByRole("textbox", { name: /^Nama merchant/ }), MERCHANT);
    await user.upload(qrInput(dialog), pngFile(1024, 1024));

    const preview = await within(dialog).findByRole("img", { name: "Pratinjau gambar QRIS" });
    // URL gambar hasil proses dari respons unggah (di jsdom: gambar pengganti server tiruan).
    expect(preview.getAttribute("src")).toMatch(/^data:image\//);
    expect(preview).toHaveStyle({ imageRendering: "pixelated" });
    expect(within(dialog).getByText(/^qris\.png \| 1024 x 1024 px \|/)).toBeInTheDocument();
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Gambar QRIS qris.png terunggah. Simpan metode untuk memakainya.",
    );
    expect(qrButton(dialog, "Ganti gambar")).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Hapus gambar: Gambar QRIS" })).toBeEnabled();
    expect(qrUploads()).toHaveLength(1);
    // Unggahan tidak memakai Idempotency-Key maupun reautentikasi (kontrak adminUploadPaymentQrImage).
    expect(qrUploads()[0]).toMatchObject({ idempotencyKey: null, reauthToken: null });

    await user.click(save(dialog));
    expect(await findToast("success", "Metode pembayaran ditambahkan.")).toBeInTheDocument();
    expectNoReauthDialog();
    const post = methodRequests("POST")[0];
    expect(post?.body).toEqual({
      kind: "qris",
      provider: "QRIS",
      account_number: NMID,
      account_holder: MERCHANT,
      instructions: null,
      active: true,
      sort_order: 3,
      qr_image_file_id: expect.stringMatching(UUID),
    });
    await screen.findByText("Menampilkan 4 dari 4");
    const imageId = post?.body?.qr_image_file_id as string;
    const created = mockPayments.method("0199e000-0000-7000-8000-000000000401");
    expect(created).toMatchObject({ kind: "qris", qr_image_file_id: imageId });
    // Gambar terlampir ke metode baru (FilesService.attach).
    expect(mockPayments.qrImage(imageId)).toEqual({ attachedTo: created?.id });

    const row = rowOf(await methodsTable(), /^QRIS/);
    expect(within(row).getByText(`NMID ${NMID}`)).toBeInTheDocument();
    expect(within(row).getByText(`a.n. ${MERCHANT}`)).toBeInTheDocument();
    expect(within(row).getAllByText("QRIS")).toHaveLength(2);
  });

  it("N-10: berkas selain PNG/JPG dan lebih dari 5 MB ditolak di klien tanpa unggahan; gambar terlalu kecil ditolak server (FILE_INVALID)", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const dialog = await openAddDialog(user);
    await user.click(within(dialog).getByRole("radio", { name: "QRIS" }));
    const group = within(dialog).getByRole("group", { name: /^Gambar QRIS/ });

    await user.upload(qrInput(dialog), new File(["RIFF....WEBP"], "qris.webp", { type: "image/webp" }));
    expect(await within(group).findByRole("alert")).toHaveTextContent(
      "Tipe berkas tidak diterima. Gunakan gambar PNG atau JPG.",
    );
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "besar.png", { type: "image/png" });
    await user.upload(qrInput(dialog), big);
    await waitFor(() => expect(within(group).getByRole("alert")).toHaveTextContent("Gambar maksimal 5 MB."));
    expect(qrUploads()).toHaveLength(0);

    // Server menolak gambar yang sisi terpendeknya < 512 piksel (422 FILE_INVALID, inspectUpload). Di jsdom isi berkas
    // tidak sampai ke server tiruan, jadi tolakan server disuntikkan dengan pesan server; aturan dimensi server tiruan
    // diuji di contract-conformance.test.ts dengan isi PNG sungguhan.
    mockPayments.fail("POST", "/admin/payment-qr-images", {
      status: 422,
      code: "FILE_INVALID",
      message: "Gambar QRIS terlalu kecil (minimal 512 piksel) sehingga sulit dipindai.",
    });
    await user.upload(qrInput(dialog), pngFile(400, 400, "kecil.png"));
    await waitFor(() =>
      expect(within(group).getByRole("alert")).toHaveTextContent(
        "Gambar QRIS terlalu kecil (minimal 512 piksel) sehingga sulit dipindai. Ketentuan: PNG/JPG, sisi terpendek minimal 512 px, maksimal 5 MB.",
      ),
    );
    expect(qrUploads()).toHaveLength(1);
    expect(within(dialog).queryByRole("img", { name: "Pratinjau gambar QRIS" })).toBeNull();
    expect(qrButton(dialog, "Pilih gambar")).toHaveAccessibleDescription(/terlalu kecil/);
    expect(qrButton(dialog, "Pilih gambar")).toHaveAttribute("aria-invalid", "true");
    expect(methodRequests("POST")).toHaveLength(0);
  });

  it("N-10, PRD 4.5: Simpan ditahan selama gambar QRIS masih diunggah", async () => {
    const user = userEvent.setup();
    const dialog = await openAddDialog(user);
    await user.click(within(dialog).getByRole("radio", { name: "QRIS" }));
    await user.type(within(dialog).getByRole("textbox", { name: /^NMID/ }), NMID);
    await user.type(within(dialog).getByRole("textbox", { name: /^Nama merchant/ }), MERCHANT);
    const release = mockPayments.hold("POST", "/admin/payment-qr-images");
    await user.upload(qrInput(dialog), pngFile(1024, 1024));

    expect(await within(dialog).findByRole("button", { name: "Mengunggah: Gambar QRIS" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(within(dialog).getByRole("status")).toHaveTextContent("Mengunggah qris.png...");
    expect(save(dialog)).toBeDisabled();
    await user.click(save(dialog));
    expect(methodRequests("POST")).toHaveLength(0);

    release();
    expect(await within(dialog).findByRole("img", { name: "Pratinjau gambar QRIS" })).toBeInTheDocument();
    await waitFor(() => expect(save(dialog)).toBeEnabled());
    await user.click(save(dialog));
    expect(await findToast("success", "Metode pembayaran ditambahkan.")).toBeInTheDocument();
    expect(methodRequests("POST")[0]?.body).toMatchObject({ qr_image_file_id: expect.stringMatching(UUID) });
  });

  it("AC F15-3, ADR-026: metode QRIS yang sudah dipakai: gambar terkunci seperti nomor rekening, PUT tetap mengirim id gambar yang sama", async () => {
    const method = mockPayments.addQrisMethod({ inUse: true });
    const user = userEvent.setup();
    await openPayments(user, { tab: "methods" });
    const row = rowOf(await methodsTable(), /^QRIS/);
    expect(within(row).getByText("Sudah dipakai")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /Hapus/ })).toBeNull();
    await user.click(within(row).getByRole("button", { name: "Ubah QRIS" }));
    const dialog = await screen.findByRole("dialog", { name: "Ubah metode pembayaran" });

    expect(within(dialog).getByRole("note")).toHaveTextContent("serta gambar QRIS tidak dapat diubah");
    expect(within(dialog).getByRole("radio", { name: "QRIS" })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: "Bank" })).toBeDisabled();
    expect(within(dialog).getByRole("textbox", { name: /^NMID/ })).toBeDisabled();
    expect(within(dialog).getByRole("img", { name: "Pratinjau gambar QRIS" })).toHaveAttribute(
      "src",
      method.qr_image_url,
    );
    const replace = qrButton(dialog, "Ganti gambar");
    expect(replace).toBeDisabled();
    expect(replace).toHaveAccessibleDescription(/tidak dapat diganti atau dihapus/);
    const remove = within(dialog).getByRole("button", { name: "Hapus gambar: Gambar QRIS" });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAccessibleDescription(/tidak dapat diganti atau dihapus/);
    expect(qrInput(dialog)).toBeDisabled();

    await user.type(
      within(dialog).getByRole("textbox", { name: /Petunjuk tambahan/ }),
      "Masukkan nominal sesuai tagihan.",
    );
    await user.click(save(dialog));
    expect(await findToast("success", "Metode pembayaran diperbarui.")).toBeInTheDocument();
    const put = methodRequests("PUT")[0];
    expect(put?.path).toBe(`/admin/payment-methods/${method.id}`);
    expect(put?.body).toMatchObject({
      kind: "qris",
      account_number: NMID,
      qr_image_file_id: method.qr_image_file_id,
      instructions: "Masukkan nominal sesuai tagihan.",
    });
    expect(mockPayments.method(method.id)).toMatchObject({
      qr_image_file_id: method.qr_image_file_id,
      version: "2",
    });
  });

  it("ADR-026: hapus gambar menahan simpan; gambar pengganti dikirim dengan id baru dan gambar lama dibuang; beralih ke bank mengirim null", async () => {
    const method = mockPayments.addQrisMethod();
    const user = userEvent.setup();
    let dialog = await openEditDialog(user);
    expect(save(dialog)).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "Hapus gambar: Gambar QRIS" }));
    expect(within(dialog).getByRole("status")).toHaveTextContent("Gambar QRIS dihapus dari isian.");
    expect(within(dialog).queryByRole("img", { name: "Pratinjau gambar QRIS" })).toBeNull();
    await user.click(save(dialog));
    await waitFor(() => expect(qrButton(dialog, "Pilih gambar")).toHaveFocus());
    expect(qrButton(dialog, "Pilih gambar")).toHaveAccessibleDescription(/Gambar QRIS wajib diunggah\./);
    expect(methodRequests("PUT")).toHaveLength(0);

    await user.upload(qrInput(dialog), pngFile(800, 800, "qris-baru.png"));
    await within(dialog).findByText(/^qris-baru\.png \| \d+ x \d+ px/);
    await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());
    await user.click(save(dialog));
    expect(await findToast("success", "Metode pembayaran diperbarui.")).toBeInTheDocument();
    const replacedId = methodRequests("PUT")[0]?.body?.qr_image_file_id as string;
    expect(replacedId).toMatch(UUID);
    expect(replacedId).not.toBe(method.qr_image_file_id);
    expect(methodRequests("PUT")[0]?.ifMatch).toBe("1");
    expect(mockPayments.method(method.id)?.qr_image_file_id).toBe(replacedId);
    expect(mockPayments.qrImage(method.qr_image_file_id!)).toBeUndefined();

    // Beralih ke bank: nama metode bawaan dikosongkan, gambar tidak lagi ditampilkan, body membawa null eksplisit.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Ubah metode pembayaran" })).toBeNull());
    await user.click(screen.getByRole("button", { name: "Ubah QRIS" }));
    dialog = await screen.findByRole("dialog", { name: "Ubah metode pembayaran" });
    await user.click(within(dialog).getByRole("radio", { name: "Bank" }));
    expect(within(dialog).queryByRole("group", { name: /Gambar QRIS/ })).toBeNull();
    await user.type(within(dialog).getByRole("textbox", { name: /^Nama bank atau e-wallet/ }), "Bank Baru");
    await user.click(save(dialog));
    expect(await findToast("success", "Metode pembayaran diperbarui.")).toBeInTheDocument();
    const toBank = methodRequests("PUT")[1];
    expect(toBank?.ifMatch).toBe("2");
    expect(toBank?.body).toMatchObject({ kind: "bank", provider: "Bank Baru", qr_image_file_id: null });
    expect(mockPayments.method(method.id)).toMatchObject({
      kind: "bank",
      qr_image_file_id: null,
      qr_image_url: null,
    });
    expect(mockPayments.qrImage(replacedId)).toBeUndefined();
    expect(toasts("error")).toHaveLength(0);
  });

  it("AC F15-4, ADR-026: konflik versi metode QRIS menampilkan versi terbaru dan memuat ulang tanpa kehilangan gambar", async () => {
    const method = mockPayments.addQrisMethod();
    const user = userEvent.setup();
    const dialog = await openEditDialog(user);
    const merchant = within(dialog).getByRole("textbox", { name: /^Nama merchant/ });
    await user.clear(merchant);
    await user.type(merchant, "KAPDH WILAYAH");
    mockPayments.updateMethodAsOtherAdmin(method.id, { account_holder: "KAPDH CABANG" });
    await user.click(save(dialog));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(
      `Versi terbaru: QRIS, NMID ${NMID} a.n. KAPDH CABANG, gambar QRIS sama, aktif, urutan 3.`,
    );
    expect(await findToast("error", "Metode sudah diubah admin lain")).toBeInTheDocument();
    expect(save(dialog)).toBeDisabled();

    await user.click(within(alert).getByRole("button", { name: "Muat versi terbaru" }));
    expect(merchant).toHaveValue("KAPDH CABANG");
    expect(within(dialog).getByRole("img", { name: "Pratinjau gambar QRIS" })).toHaveAttribute(
      "src",
      method.qr_image_url,
    );
    await user.clear(merchant);
    await user.type(merchant, "KAPDH WILAYAH");
    await user.click(save(dialog));
    expect(await findToast("success", "Metode pembayaran diperbarui.")).toBeInTheDocument();
    const puts = methodRequests("PUT");
    expect(puts.map((r) => r.ifMatch)).toEqual(["1", "2"]);
    expect(puts[1]?.body).toMatchObject({
      account_holder: "KAPDH WILAYAH",
      qr_image_file_id: method.qr_image_file_id,
    });
    expect(mockPayments.method(method.id)).toMatchObject({
      account_holder: "KAPDH WILAYAH",
      qr_image_file_id: method.qr_image_file_id,
      version: "3",
    });
  });

  it("ADR-026: detail pembayaran menampilkan snapshot QRIS (label, NMID, merchant) dan tautan Lihat QRIS", async () => {
    const method = mockPayments.addQrisMethod({ inUse: true });
    const paymentId = mockPayments.paymentsOfMethod(method.id)[0]!;
    const owner = mockPayments.get(paymentId)!.member!.full_name;
    const user = userEvent.setup();
    await openPayments(user, { search: `payment=${paymentId}` });
    const panel = await screen.findByRole("article", { name: owner });
    const value = within(panel).getByText("Rekening tujuan", { selector: "dt" })
      .nextElementSibling as HTMLElement;
    expect(value).toHaveTextContent(new RegExp(`^QRIS\\s*NMID ${NMID} a\\.n\\. ${MERCHANT}\\s*Lihat QRIS`));
    const link = within(value).getByRole("link", { name: /^Lihat QRIS\s*\(tab baru\)$/ });
    expect(link).toHaveAttribute("href", method.qr_image_url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(paymentRequests.some((r) => r.path === `/admin/payments/${paymentId}`)).toBe(true);
  });

  it("D13, ADR-026: Catat iuran menampilkan QRIS sebagai rekening penerima dengan NMID dan nama merchant", async () => {
    mockPayments.addQrisMethod();
    const user = userEvent.setup();
    await openPayments(user);
    await user.click(await screen.findByRole("button", { name: "Catat iuran" }));
    const dialog = await screen.findByRole("dialog", { name: "Catat iuran di luar aplikasi" });
    await user.type(within(dialog).getByRole("combobox", { name: /^Alumni/ }), "Hendra");
    await user.click(await screen.findByRole("option", { name: /Hendra Gunawan/ }));
    const receivers = await within(dialog).findByRole("group", { name: /Rekening penerima dana/ });
    const qris = within(receivers).getByRole("radio", { name: /^QRIS/ });
    expect(qris.closest("label")).toHaveTextContent(`QRISNMID ${NMID} a.n. ${MERCHANT}`);
    // Bank dan e-wallet tetap berlabel jenis + nama penyedia.
    expect(within(receivers).getByRole("radio", { name: /^Bank \[Nama bank 1\]/ })).toBeInTheDocument();
  }, 60_000);
});
