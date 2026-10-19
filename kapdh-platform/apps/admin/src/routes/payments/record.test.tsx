import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";
import { mockAuth, mockPayments } from "../../api/mocks";
import { MOCK_MEMBER } from "../../api/mocks/members";
import { findToast, renderApp, signIn, type User } from "../../test/utils";
import {
  canRecordDuesFor,
  duesUnavailableReason,
  feesUnconfigured,
  recordBlockReason,
} from "./recordEligibility";
import { IDS, openPayments, requestsTo } from "./testing";

/**
 * "Catat iuran" (rencana cadangan D13, kontrak adminRecordPayment; temuan audit D6-01) terhadap server tiruan
 * src/api/mocks/payments.ts, yang respons setiap cabangnya divalidasi terhadap kontrak di
 * src/api/mocks/contract-conformance.test.ts. Bukti mock bukan bukti AC sisi server (PRD 7.3); jalur API nyata
 * diuji di apps/admin/src/live (pnpm --filter @kapdh/admin test:live).
 */

const DIALOG = "Catat iuran di luar aplikasi";
/** Alur penuh (router + dialog + unggah) di mesin build yang sibuk dapat melewati 20 detik bawaan. */
const FLOW = { timeout: 60_000 };

// Potongan kode halaman dimuat lazy; transformasi pertamanya dilakukan di sini, bukan di dalam batas waktu tes pertama.
beforeAll(async () => {
  await Promise.all([
    import("./PaymentsPage"),
    import("../members/MemberDetailPage"),
    import("../settings/SettingsPage"),
  ]);
}, 120_000);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function pngFile(name = "mutasi.png"): File {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: "image/png" });
}

/** Tempel teks ke isian (lebih cepat daripada mengetik per karakter di seluruh aplikasi). */
async function typeText(user: User, field: HTMLElement, text: string): Promise<void> {
  await user.click(field);
  await user.paste(text);
}

async function openRecordDialog(user: User): Promise<HTMLElement> {
  await user.click(await screen.findByRole("button", { name: "Catat iuran" }));
  return screen.findByRole("dialog", { name: DIALOG });
}

async function pickMember(user: User, dialog: HTMLElement, query: string, name: RegExp): Promise<void> {
  await user.type(within(dialog).getByRole("combobox", { name: /^Alumni/ }), query);
  await user.click(await screen.findByRole("option", { name }));
  await within(dialog).findByRole("region", { name: "Alumni terpilih" });
}

/** Isi rekening, bukti, catatan dan konfirmasi dana untuk jenis iuran yang sudah terpilih. */
async function fillVerification(
  user: User,
  dialog: HTMLElement,
  opts: { method?: RegExp; note?: string; reason?: string; amount?: string } = {},
): Promise<void> {
  await user.click(
    await within(dialog).findByRole("radio", { name: opts.method ?? /\[Nama bank 2\] \(nonaktif\)/ }),
  );
  await user.upload(within(dialog).getByTestId("file-input"), pngFile());
  await within(dialog).findByText("Berkas siap dilampirkan.");
  if (opts.note) await typeText(user, within(dialog).getByLabelText(/^Catatan transfer/), opts.note);
  await typeText(
    user,
    within(dialog).getByLabelText(/^Catatan verifikasi/),
    opts.reason ?? "Dana cocok dengan mutasi 13 Okt.",
  );
  await user.click(
    within(dialog).getByRole("checkbox", {
      name: new RegExp(`Saya sudah mencocokkan dana ${opts.amount ?? "Rp10\\.000"}`),
    }),
  );
}

const submit = (user: User, dialog: HTMLElement) =>
  user.click(within(dialog).getByRole("button", { name: "Catat iuran" }));

describe("kelayakan Catat iuran (recordEligibility, sama dengan GET /me/fees dan kontrak adminRecordPayment)", () => {
  const base = {
    account_status: "active" as const,
    linked_admin: null,
    renewal_opens_at: null,
  };

  it("AC F07-5: pendaftaran hanya untuk unverified; perpanjangan hanya untuk expiring/expired", () => {
    expect(duesUnavailableReason({ effective_status: "unverified", renewal_opens_at: null })).toEqual({
      registration: null,
      renewal: "Perpanjangan tersedia setelah iuran pendaftaran disetujui.",
    });
    for (const status of ["expiring", "expired"] as const)
      expect(duesUnavailableReason({ effective_status: status, renewal_opens_at: null })).toEqual({
        registration: "Iuran pendaftaran anggota ini sudah disetujui.",
        renewal: null,
      });
    expect(
      duesUnavailableReason({ effective_status: "verified", renewal_opens_at: "2027-01-01T00:00:00Z" })
        .renewal,
    ).toMatch(/^Jendela perpanjangan dibuka /);
  });

  it("PRD 2.3: akun tertaut admin pemanggil, dibatasi, belum aktif atau dihapus tidak dapat dicatat iurannya", () => {
    const admin = "0199e000-0000-7000-8000-00000000ad01";
    const linked = {
      admin_id: admin,
      display_name: "Fikri",
      role: "admin" as const,
      status: "active" as const,
    };
    expect(recordBlockReason({ ...base, effective_status: "expired", linked_admin: linked }, admin)).toMatch(
      /konflik kepentingan/,
    );
    // Tertaut ke admin LAIN bukan konflik kepentingan pemanggil.
    expect(
      recordBlockReason({ ...base, effective_status: "expired", linked_admin: linked }, "lain"),
    ).toBeNull();
    expect(recordBlockReason({ ...base, effective_status: "suspended" }, admin)).toMatch(/dibatasi/);
    for (const status of ["pending_otp", "disabled", "deletion_pending"] as const)
      expect(recordBlockReason({ ...base, effective_status: status }, admin)).toMatch(/belum aktif/);
    expect(canRecordDuesFor({ ...base, effective_status: "verified" }, admin)).toBe(false);
    expect(canRecordDuesFor({ ...base, effective_status: "unverified" }, admin)).toBe(true);
  });

  it("PRD 8.2: nominal iuran belum tersimpan (versi 0) atau total 0.00 menghalangi payment baru, per jenis", () => {
    const fees = { version: "3", registration_total: "60000.00", renewal_fee: "10000.00" };
    expect(feesUnconfigured(fees, "registration")).toBe(false);
    expect(feesUnconfigured(fees, "renewal")).toBe(false);
    expect(feesUnconfigured({ ...fees, version: "0" }, "registration")).toBe(true);
    expect(feesUnconfigured({ ...fees, version: "0" }, "renewal")).toBe(true);
    expect(feesUnconfigured({ ...fees, renewal_fee: "0.00" }, "renewal")).toBe(true);
    expect(feesUnconfigured({ ...fees, renewal_fee: "0.00" }, "registration")).toBe(false);
    expect(feesUnconfigured({ ...fees, registration_total: "0.00" }, "registration")).toBe(true);
    // Nilai yang tidak dapat dibaca klien tidak menghalangi; server tetap penentu.
    expect(feesUnconfigured({ ...fees, renewal_fee: "?" }, "renewal")).toBe(false);
  });
});

describe("Catat iuran di Verifikasi Pembayaran (D13, adminRecordPayment; server tiruan)", FLOW, () => {
  it("D13, AC F03-5: instruksi tanpa bukti diselesaikan di tempat (200); rekening nonaktif boleh, nominal tidak dikirim klien", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    const dialog = await openRecordDialog(user);
    await pickMember(user, dialog, "Hendra", /Hendra Gunawan/);

    // Hendra expired: hanya perpanjangan yang layak dan langsung terpilih (AC F07-5).
    const types = await within(dialog).findByRole("group", { name: /Jenis iuran/ });
    expect(within(types).getByRole("radio", { name: /Pendaftaran/ })).toBeDisabled();
    await waitFor(() => expect(within(types).getByRole("radio", { name: /Perpanjangan/ })).toBeChecked());
    // Tagihan terbuka tanpa bukti ditampilkan: pencatatan menyelesaikannya, bukan membuat payment kedua.
    expect(await within(dialog).findByText(/Belum ada bukti dari anggota/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Catat iuran" })).toBeEnabled();

    await fillVerification(user, dialog, { note: "BSI 13 Okt" });
    await submit(user, dialog);

    await findToast(
      "success",
      /Tagihan perpanjangan Hendra Gunawan yang sudah ada diselesaikan sebagai lunas\./,
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: DIALOG })).toBeNull());
    // Payment hasil langsung terbuka di panel keputusan: lunas dan histori pencatatan oleh admin.
    const panel = await screen.findByRole("article", { name: "Hendra Gunawan" });
    expect(await within(panel).findAllByText("Disetujui")).not.toHaveLength(0);
    const sent = requestsTo("POST", "/admin/payments");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.idempotencyKey).toMatch(UUID);
    expect(sent[0]?.body).toEqual({
      user_id: MOCK_MEMBER.hendra,
      type: "renewal",
      payment_method_id: IDS.methodInactive,
      proof_file_id: expect.stringMatching(UUID),
      transfer_note: "BSI 13 Okt",
      funds_verified: true,
      reason: "Dana cocok dengan mutasi 13 Okt.",
    });
    expect(mockPayments.get(IDS.hendra)).toMatchObject({
      status: "paid",
      method_id: IDS.methodInactive,
      proof_version: 1,
    });
  });

  it("D13: tanpa tagihan terbuka → payment baru dari biaya aktif (201); formulir wajib konfirmasi dana dan catatan", async () => {
    mockPayments.cancelAsOtherAdmin(IDS.hendra);
    const user = userEvent.setup();
    await openPayments(user);
    const dialog = await openRecordDialog(user);
    await pickMember(user, dialog, "Hendra", /Hendra Gunawan/);
    expect(await within(dialog).findByText(/Belum ada tagihan terbuka untuk iuran ini/)).toHaveTextContent(
      "Rp10.000",
    );

    // Tanpa rekening, bukti, catatan dan centang dana: tidak ada yang dikirim.
    await submit(user, dialog);
    expect(await within(dialog).findByText("Pilih rekening penerima dana.")).toBeInTheDocument();
    expect(within(dialog).getByText("Unggah bukti verifikasi dana.")).toBeInTheDocument();
    expect(within(dialog).getByText(/Centang setelah dana dicocokkan/)).toBeInTheDocument();
    expect(requestsTo("POST", "/admin/payments")).toHaveLength(0);

    await fillVerification(user, dialog, { method: /\[Nama bank 1\]/ });
    await submit(user, dialog);
    await findToast("success", /Iuran perpanjangan Hendra Gunawan tercatat lunas\. Masa aktif sampai /);
    const panel = await screen.findByRole("article", { name: "Hendra Gunawan" });
    expect(await within(panel).findAllByText("Disetujui")).not.toHaveLength(0);
    const sent = requestsTo("POST", "/admin/payments");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).not.toHaveProperty("amount");
    expect(sent[0]?.body).not.toHaveProperty("transfer_note");
  });

  it("D13: bukti anggota menunggu verifikasi → dialog menolak pencatatan dan membuka bukti itu di panel keputusan", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    const dialog = await openRecordDialog(user);
    await pickMember(user, dialog, "Fikri", /Muhammad Fikri/);
    const note = await within(dialog).findByText(/Anggota sudah mengirim bukti untuk iuran ini/);
    expect(note).toHaveTextContent("iuran tidak dapat dicatat dua kali");
    expect(within(dialog).getByRole("button", { name: "Catat iuran" })).toBeDisabled();
    expect(within(dialog).queryByTestId("file-input")).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Buka bukti anggota" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: DIALOG })).toBeNull());
    const panel = await screen.findByRole("article", { name: "Muhammad Fikri" });
    expect(within(panel).getByRole("button", { name: "Setujui" })).toBeInTheDocument();
    expect(requestsTo("POST", "/admin/payments")).toHaveLength(0);
  });

  it("D13: anggota mengirim bukti saat dialog terbuka → 409 PAYMENT_STATE_CONFLICT, tidak dicatat, tautan ke bukti itu", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    const dialog = await openRecordDialog(user);
    await pickMember(user, dialog, "Hendra", /Hendra Gunawan/);
    await within(dialog).findByText(/Belum ada bukti dari anggota/);
    await fillVerification(user, dialog);
    mockPayments.replaceProof(IDS.hendra);
    await submit(user, dialog);

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Anggota sudah mengirim bukti untuk iuran ini.");
    expect(mockPayments.get(IDS.hendra)).toMatchObject({ status: "pending", proof_version: 1 });
    // Data tagihan dimuat ulang: tombol simpan nonaktif dan catatan bukti anggota tampil.
    await within(dialog).findByText(/iuran tidak dapat dicatat dua kali/);
    expect(within(dialog).getByRole("button", { name: "Catat iuran" })).toBeDisabled();
    await user.click(within(alert).getByRole("button", { name: "Buka pembayaran itu" }));
    const panel = await screen.findByRole("article", { name: "Hendra Gunawan" });
    expect(await within(panel).findByRole("button", { name: "Setujui" })).toBeInTheDocument();
  });

  it("PRD 8.2: tagihan terbuka memakai snapshot-nya sendiri → tetap dapat diselesaikan walaupun nominal iuran belum tersimpan", async () => {
    mockPayments.unsetFees();
    const user = userEvent.setup();
    await openPayments(user);
    const dialog = await openRecordDialog(user);
    await pickMember(user, dialog, "Hendra", /Hendra Gunawan/);
    await within(dialog).findByText(/Belum ada bukti dari anggota/);
    expect(within(dialog).queryByText(/Nominal iuran ini belum ditetapkan/)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Catat iuran" })).toBeEnabled();
  });

  it("PRD 8.2: nominal iuran belum ditetapkan → iuran baru tidak dapat dicatat dan dialog menunjuk tab Biaya", async () => {
    mockPayments.unsetFees();
    mockPayments.cancelAsOtherAdmin(IDS.hendra);
    const user = userEvent.setup();
    await openPayments(user);
    const dialog = await openRecordDialog(user);
    // Tanpa tagihan terbuka: payment baru akan ditolak server (403), jadi formulir tidak ditawarkan.
    await pickMember(user, dialog, "Hendra", /Hendra Gunawan/);
    const note = await within(dialog).findByText(/Nominal iuran ini belum ditetapkan atau bernilai nol/);
    expect(within(dialog).getByRole("button", { name: "Catat iuran" })).toBeDisabled();
    expect(within(dialog).queryByTestId("file-input")).toBeNull();
    const toFees = within(note.parentElement!).getByRole("link", { name: "Buka tab Biaya" });
    expect(toFees).toHaveAttribute("href", "/payments?tab=fees");
    await user.click(toFees);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: DIALOG })).toBeNull());
    expect(await screen.findByRole("tabpanel")).toHaveAttribute("id", expect.stringMatching(/fees/));
    expect(requestsTo("POST", "/admin/payments")).toHaveLength(0);
  });

  it("PRD 8.2: biaya diubah menjadi nol saat dialog terbuka → server menolak 403, pesannya tampil dan dialog mengikuti", async () => {
    mockPayments.cancelAsOtherAdmin(IDS.hendra);
    const user = userEvent.setup();
    await openPayments(user);
    const dialog = await openRecordDialog(user);
    await pickMember(user, dialog, "Hendra", /Hendra Gunawan/);
    await within(dialog).findByText(/Belum ada tagihan terbuka untuk iuran ini/);
    await fillVerification(user, dialog, { method: /\[Nama bank 1\]/ });
    mockPayments.updateFeesAsOtherAdmin("50000.00", "10000.00", "0.00");
    await submit(user, dialog);

    expect(
      await within(dialog).findByText(/Nominal iuran belum ditetapkan atau bernilai nol\. Simpan nominal/),
    ).toBeInTheDocument();
    // Biaya dimuat ulang: catatan nominal nol menggantikan formulir.
    expect(
      await within(dialog).findByText(/Nominal iuran ini belum ditetapkan atau bernilai nol/),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Catat iuran" })).toBeDisabled();
    expect(requestsTo("POST", "/admin/payments")).toHaveLength(1);
  });

  it("PRD 2.3: akun alumni tertaut admin pemanggil dan akun dibatasi tidak dapat dicatat iurannya", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    const dialog = await openRecordDialog(user);
    await pickMember(user, dialog, "Fikri", /Fikri Ramadhan/);
    expect(await within(dialog).findByText(/tertaut ke akun admin Anda/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("group", { name: /Jenis iuran/ })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Catat iuran" })).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "Ganti alumni" }));
    await pickMember(user, dialog, "Rizky", /Rizky Pratama/);
    expect(await within(dialog).findByText(/sedang dibatasi pengurus/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Catat iuran" })).toBeDisabled();
  });

  it("AC F15-1: tanpa payments.decide tombol Catat iuran tidak ada", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read", "members.read"] });
    const user = userEvent.setup();
    await openPayments(user);
    await screen.findByRole("table", { name: "Antrean pembayaran" });
    expect(screen.queryByRole("button", { name: "Catat iuran" })).toBeNull();
  });

  it("AC F15-1: tanpa settings.manage (daftar rekening penerima) dialog menjelaskan alasannya dan tidak dapat disimpan", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read", "payments.decide", "members.read"] });
    const user = userEvent.setup();
    await openPayments(user);
    const dialog = await openRecordDialog(user);
    await pickMember(user, dialog, "Hendra", /Hendra Gunawan/);
    expect(
      await within(dialog).findByText(/hanya dapat dibaca admin berizin kelola pengaturan/),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Catat iuran" })).toBeDisabled();
  });
});

describe("pintu masuk Catat iuran dan tautan payment (D6-01, D6-02; server tiruan)", FLOW, () => {
  async function openMember(user: User, userId: string, name: string) {
    const { router } = renderApp(`/members/${userId}`);
    await signIn(user);
    await screen.findByRole("heading", { level: 1, name }, { timeout: 10_000 });
    return { card: await screen.findByRole("region", { name: "Pembayaran terbaru" }), router };
  }

  it("D6-01: detail anggota expired menaut ke Catat iuran dengan alumni terpilih; parameter URL dihapus setelah dialog terbuka", async () => {
    const user = userEvent.setup();
    const { card, router } = await openMember(user, MOCK_MEMBER.hendra, "Hendra Gunawan");
    const link = within(card).getByRole("link", { name: "Catat iuran" });
    expect(link).toHaveAttribute("href", `/payments?tab=verify&record=${MOCK_MEMBER.hendra}`);
    await user.click(link);

    const dialog = await screen.findByRole("dialog", { name: DIALOG });
    const picked = await within(dialog).findByRole("region", { name: "Alumni terpilih" });
    expect(await within(picked).findByText("Hendra Gunawan")).toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox", { name: /^Alumni/ })).toBeNull();
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty("record"));
    expect(router.state.location.pathname).toBe("/payments");
    await within(dialog).findByText(/Belum ada bukti dari anggota/);
  });

  it("D6-01: Catat iuran tidak ditawarkan untuk anggota yang iurannya tidak dapat dicatat sekarang", async () => {
    const user = userEvent.setup();
    // Hasan verified di luar jendela perpanjangan; Fikri Ramadhan tertaut ke admin pemanggil (PRD 2.3).
    const { card: hasan } = await openMember(user, MOCK_MEMBER.hasan, "Hasan Basri");
    expect(within(hasan).queryByRole("link", { name: "Catat iuran" })).toBeNull();
    expect(within(hasan).getByRole("link", { name: "Semua pembayaran" })).toHaveAttribute(
      "href",
      `/payments?tab=verify&user=${MOCK_MEMBER.hasan}`,
    );
  });

  it("D6-02: Semua pembayaran membuka daftar yang dibatasi ke anggota itu dengan seluruh status; cakupan dapat dihapus", async () => {
    const user = userEvent.setup();
    const { card, router } = await openMember(user, MOCK_MEMBER.siti, "Siti Rahmawati");
    await user.click(within(card).getByRole("link", { name: "Semua pembayaran" }));

    const scope = await screen.findByRole("note", { name: "Cakupan daftar pembayaran" });
    await waitFor(() =>
      expect(scope).toHaveTextContent("Hanya menampilkan pembayaran milik Siti Rahmawati."),
    );
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("all");
    // Filter kontrak adminListPayments: user_id, tanpa stage (seluruh status).
    await waitFor(() => {
      const last = requestsTo("GET", "/admin/payments").at(-1);
      expect(last?.query).toMatchObject({ user_id: MOCK_MEMBER.siti });
      expect(last?.query).not.toHaveProperty("stage");
    });
    const table = await screen.findByRole("table", { name: "Antrean pembayaran" });
    const names = within(table)
      .getAllByRole("rowheader")
      .map((cell) => cell.textContent ?? "");
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.includes("Siti Rahmawati"))).toBe(true);

    await user.click(within(scope).getByRole("button", { name: "Tampilkan semua pembayaran" }));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty("user"));
    expect(screen.queryByRole("note", { name: "Cakupan daftar pembayaran" })).toBeNull();
    await waitFor(() =>
      expect(requestsTo("GET", "/admin/payments").at(-1)?.query).not.toHaveProperty("user_id"),
    );
  });

  it("D6-02: baris pembayaran terbaru menaut ke payment itu; panel keputusan membukanya langsung", async () => {
    const user = userEvent.setup();
    const { card, router } = await openMember(user, MOCK_MEMBER.siti, "Siti Rahmawati");
    const row = within(card).getByRole("link", { name: /^Pendaftaran Rp60\.000, dibuat / });
    expect(row).toHaveAttribute("href", `/payments?tab=verify&payment=${IDS.siti}`);
    await user.click(row);
    const panel = await screen.findByRole("article", { name: "Siti Rahmawati" });
    expect(within(panel).getByRole("heading", { name: "Siti Rahmawati" })).toBeInTheDocument();
    expect(router.state.location.search).toMatchObject({ tab: "verify", payment: IDS.siti });
  });

  it("D6-02: tanpa payments.read baris pembayaran tidak ditautkan", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["members.read"] });
    const user = userEvent.setup();
    const { card } = await openMember(user, MOCK_MEMBER.siti, "Siti Rahmawati");
    expect(within(card).queryByRole("link")).toBeNull();
  });

  it("D6-01: Pengaturan instruksi iuran menunjuk jalur Catat iuran; tanpa payments.decide menjelaskan izin yang dibutuhkan", async () => {
    const user = userEvent.setup();
    renderApp("/settings");
    await signIn(user);
    const note = await screen.findByRole("note", { name: "Pencatatan iuran di luar aplikasi" });
    expect(note).toHaveTextContent("dicatat pengurus lewat Catat iuran di Verifikasi Pembayaran");
    // Super Admin memegang seluruh izin formulir: tanpa daftar izin.
    expect(note).not.toHaveTextContent("members.read");
    expect(within(note).getByRole("link", { name: "Catat iuran" })).toHaveAttribute(
      "href",
      "/payments?tab=verify&record=true",
    );
    await user.click(within(note).getByRole("link", { name: "Catat iuran" }));
    expect(await screen.findByRole("dialog", { name: DIALOG })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^Alumni/ })).toBeInTheDocument();
  });

  it("D6-01: admin pengaturan tanpa payments.decide diberi tahu izin pencatatan sebelum menyembunyikan instruksi", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["settings.manage"] });
    const user = userEvent.setup();
    renderApp("/settings");
    await signIn(user);
    const note = await screen.findByRole("note", { name: "Pencatatan iuran di luar aplikasi" });
    expect(note).toHaveTextContent("payments.read dan payments.decide");
    expect(within(note).queryByRole("link")).toBeNull();
  });

  it("D6-01: pemutus pembayaran tanpa members.read tetap ditautkan, tetapi diberi tahu seluruh izin formulir pencatatan", async () => {
    mockAuth.setAdmin({
      role: "admin",
      permissions: ["settings.manage", "payments.read", "payments.decide"],
    });
    const user = userEvent.setup();
    renderApp("/settings");
    await signIn(user);
    const note = await screen.findByRole("note", { name: "Pencatatan iuran di luar aplikasi" });
    expect(note).toHaveTextContent("melihat data anggota (members.read)");
    expect(note).toHaveTextContent("kelola pengaturan (settings.manage)");
    expect(within(note).getByRole("link", { name: "Catat iuran" })).toBeInTheDocument();
  });
});
