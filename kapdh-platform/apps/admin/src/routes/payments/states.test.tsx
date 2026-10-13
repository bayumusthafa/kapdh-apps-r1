import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockPayments } from "../../api/mocks";
import type { User } from "../../test/utils";
import { IDS, openPayments } from "./testing";

/**
 * Keadaan layar area pembayaran (BUILD_PLAN "Acceptance evidence", PRD 4.5): memuat, kosong, galat dengan
 * "Coba lagi", izin ditolak (403 FORBIDDEN di tengah sesi) dan sukses untuk antrean, panel keputusan, metode,
 * biaya, daftar dan panel penyesuaian. Server tiruan menahan atau menggagalkan permintaan tertentu; bukti mock
 * bukan bukti AC (PRD 7.3).
 */

const FORBIDDEN = {
  status: 403,
  code: "FORBIDDEN",
  message: "Anda tidak memiliki izin untuk tindakan ini.",
} as const;

/** Galat umum (500) tampil dengan judul, pesan server, kode referensi dan tombol "Coba lagi" yang berfungsi. */
async function expectRetryableError(container: HTMLElement, title: string, user: User) {
  const alert = await within(container).findByRole("alert");
  expect(alert).toHaveTextContent(title);
  expect(alert).toHaveTextContent("Terjadi kesalahan pada server. Coba lagi.");
  expect(alert).toHaveTextContent(/Kode referensi: mock-/);
  await user.click(within(alert).getByRole("button", { name: "Coba lagi" }));
}

async function expectForbidden(container: HTMLElement) {
  const alert = await within(container).findByRole("alert");
  expect(alert).toHaveTextContent("Akses ditolak");
  expect(alert).toHaveTextContent("tidak memiliki izin");
}

function verifyPanel(): HTMLElement {
  return screen.getByRole("tabpanel", { name: /Verifikasi Pembayaran/ });
}

function adjustmentsPanel(): HTMLElement {
  return screen.getByRole("tabpanel", { name: /Penyesuaian/ });
}

function methodsPanel(): HTMLElement {
  return screen.getByRole("tabpanel", { name: /Kelola Metode/ });
}

function feesPanel(): HTMLElement {
  return screen.getByRole("tabpanel", { name: /Biaya Pembayaran/ });
}

describe("keadaan layar pembayaran (PRD 4.5, BUILD_PLAN; server tiruan)", () => {
  it("PRD 4.5: antrean memuat lalu sukses; belum ada pilihan menampilkan petunjuk memilih pembayaran", async () => {
    const release = mockPayments.hold("GET", "/admin/payments");
    const user = userEvent.setup();
    await openPayments(user);
    expect(await screen.findByText("Memuat antrean pembayaran...")).toBeInTheDocument();
    expect(screen.queryByText(/^Menampilkan/)).toBeNull();
    release();
    expect(await screen.findByText("Menampilkan 20 dari 23")).toBeInTheDocument();
    expect(screen.queryByText("Memuat antrean pembayaran...")).toBeNull();
    expect(screen.getByText("Pilih pembayaran")).toBeInTheDocument();
    expect(
      screen.getByText("Pilih nama alumni pada antrean untuk melihat bukti dan memutus pembayaran."),
    ).toBeInTheDocument();
  });

  it("PRD 4.5: antrean gagal dimuat menampilkan galat dengan Coba lagi yang memuat ulang", async () => {
    mockPayments.fail("GET", "/admin/payments");
    const user = userEvent.setup();
    await openPayments(user);
    await expectRetryableError(verifyPanel(), "Data gagal dimuat", user);
    expect(await screen.findByText("Menampilkan 20 dari 23")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Antrean pembayaran" })).toBeInTheDocument();
  });

  it("PRD 4.5: antrean kosong dan pencarian tanpa hasil memiliki pesan masing-masing", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    await screen.findByText("Menampilkan 20 dari 23");
    await user.type(screen.getByRole("searchbox", { name: "Cari" }), "Tidak Ada Nama Ini");
    expect(await screen.findByText("Tidak ada pembayaran yang cocok")).toBeInTheDocument();
    expect(screen.getByText("Ubah kata kunci atau filter.")).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "Cari" }));
    await screen.findByText("Menampilkan 20 dari 23");

    await user.selectOptions(screen.getByRole("combobox", { name: "Jenis" }), "ticket");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "rejected");
    expect(await screen.findByText("Antrean kosong")).toBeInTheDocument();
    expect(screen.getByText("Tidak ada pembayaran dengan jenis dan status ini.")).toBeInTheDocument();
  });

  it("AC F16-3, PRD 4.5: antrean dijawab 403 FORBIDDEN di tengah sesi menampilkan Akses ditolak", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    await screen.findByText("Menampilkan 20 dari 23");
    mockPayments.fail("GET", "/admin/payments", FORBIDDEN);
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "paid");
    await expectForbidden(verifyPanel());
    expect(screen.queryByRole("button", { name: /Ahmad Islam/ })).toBeNull();
  });

  it("PRD 4.5: panel keputusan memuat, gagal dimuat dengan Coba lagi, lalu sukses", async () => {
    const user = userEvent.setup();
    await openPayments(user);
    const release = mockPayments.hold("GET", `/admin/payments/${IDS.ahmad}`);
    mockPayments.fail("GET", `/admin/payments/${IDS.ahmad}`);
    await user.click(await screen.findByRole("button", { name: /Ahmad Islam/ }));
    expect(await screen.findByText("Memuat detail pembayaran...")).toBeInTheDocument();
    release();
    await expectRetryableError(verifyPanel(), "Detail gagal dimuat", user);
    const panel = await screen.findByRole("article", { name: "Ahmad Islam" });
    expect(within(panel).getByRole("button", { name: "Setujui" })).toBeDisabled();
  });

  it("AC F16-3, PRD 4.5: panel keputusan dijawab 403 FORBIDDEN menampilkan Akses ditolak tanpa formulir", async () => {
    mockPayments.fail("GET", `/admin/payments/${IDS.ahmad}`, FORBIDDEN);
    const user = userEvent.setup();
    await openPayments(user);
    await user.click(await screen.findByRole("button", { name: /Ahmad Islam/ }));
    await expectForbidden(verifyPanel());
    expect(screen.queryByRole("article", { name: "Ahmad Islam" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Setujui" })).toBeNull();
  });

  it("PRD 4.5: tab metode memuat, gagal dengan Coba lagi, kosong, dan 403 FORBIDDEN menampilkan Akses ditolak", async () => {
    const release = mockPayments.hold("GET", "/admin/payment-methods");
    mockPayments.fail("GET", "/admin/payment-methods");
    const user = userEvent.setup();
    await openPayments(user, { tab: "methods" });
    expect(await screen.findByText("Memuat metode pembayaran...")).toBeInTheDocument();
    release();
    await expectRetryableError(methodsPanel(), "Data gagal dimuat", user);
    expect(await screen.findByText("Menampilkan 3 dari 3")).toBeInTheDocument();

    mockPayments.clearMethods();
    mockPayments.fail("GET", "/admin/payment-methods", FORBIDDEN);
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "active");
    await expectForbidden(methodsPanel());

    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "inactive");
    expect(await screen.findByText("Tidak ada metode dengan status ini")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "all");
    expect(await screen.findByText("Belum ada metode pembayaran")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tambah metode" })).toBeEnabled();
  });

  it("PRD 4.5: tab biaya memuat, gagal dengan Coba lagi lalu sukses; 403 FORBIDDEN menampilkan Akses ditolak", async () => {
    const release = mockPayments.hold("GET", "/admin/settings/fees");
    mockPayments.fail("GET", "/admin/settings/fees");
    const user = userEvent.setup();
    await openPayments(user, { tab: "fees" });
    expect(await screen.findByText("Memuat biaya pembayaran...")).toBeInTheDocument();
    release();
    await expectRetryableError(feesPanel(), "Biaya gagal dimuat", user);
    expect(await screen.findByRole("region", { name: "Biaya aktif" })).toBeInTheDocument();

    // Kembali ke tab biaya memuat ulang data dari server; jawaban 403 menutup editor dan menampilkan Akses ditolak.
    mockPayments.fail("GET", "/admin/settings/fees", FORBIDDEN);
    await user.click(screen.getByRole("tab", { name: "Kelola Metode" }));
    await screen.findByRole("table", { name: "Metode pembayaran" });
    await user.click(screen.getByRole("tab", { name: "Biaya Pembayaran" }));
    await expectForbidden(feesPanel());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Simpan biaya baru" })).toBeNull());
  });

  it("PRD 4.5: daftar penyesuaian memuat, gagal dengan Coba lagi, kosong, dan 403 FORBIDDEN menampilkan Akses ditolak", async () => {
    const release = mockPayments.hold("GET", "/admin/payment-adjustments");
    mockPayments.fail("GET", "/admin/payment-adjustments");
    const user = userEvent.setup();
    await openPayments(user, { tab: "adjustments" });
    expect(await screen.findByText("Memuat daftar penyesuaian...")).toBeInTheDocument();
    release();
    await expectRetryableError(adjustmentsPanel(), "Data gagal dimuat", user);
    expect(await screen.findByText("Menampilkan 3 dari 3")).toBeInTheDocument();
    expect(screen.getByText("Pilih penyesuaian")).toBeInTheDocument();

    // Kosong: koreksi tidak memiliki tenggat sehingga tidak ada yang lewat tenggat.
    await user.selectOptions(screen.getByRole("combobox", { name: "Jenis" }), "correction");
    await user.selectOptions(screen.getByRole("combobox", { name: "Tenggat" }), "overdue");
    expect(await screen.findByText("Tidak ada penyesuaian")).toBeInTheDocument();
    expect(
      screen.getByText("Tidak ada refund atau koreksi yang menunggu proses dengan filter ini."),
    ).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Cari" }), "Tidak Ada Nama Ini");
    expect(await screen.findByText("Tidak ada penyesuaian yang cocok")).toBeInTheDocument();

    mockPayments.fail("GET", "/admin/payment-adjustments", FORBIDDEN);
    await user.clear(screen.getByRole("searchbox", { name: "Cari" }));
    await expectForbidden(adjustmentsPanel());
  });

  it("PRD 4.5: panel penyesuaian memuat, gagal dengan Coba lagi lalu sukses; 403 FORBIDDEN menampilkan Akses ditolak", async () => {
    const user = userEvent.setup();
    await openPayments(user, { tab: "adjustments" });
    const table = await screen.findByRole("table", { name: "Daftar penyesuaian" });
    const release = mockPayments.hold("GET", `/admin/payment-adjustments/${IDS.lailaRefund}`);
    mockPayments.fail("GET", `/admin/payment-adjustments/${IDS.lailaRefund}`);
    await user.click(within(table).getByRole("button", { name: /Laila Fitriani/ }));
    expect(await screen.findByText("Memuat detail penyesuaian...")).toBeInTheDocument();
    release();
    await expectRetryableError(adjustmentsPanel(), "Detail gagal dimuat", user);
    const panel = await screen.findByRole("article", { name: "Refund Rp75.000" });
    expect(await within(panel).findByRole("button", { name: "Tandai selesai" })).toBeInTheDocument();

    mockPayments.fail("GET", `/admin/payment-adjustments/${IDS.fajarRefund}`, FORBIDDEN);
    await user.click(within(table).getByRole("button", { name: /Fajar Nugroho/ }));
    await expectForbidden(adjustmentsPanel());
    expect(screen.queryByRole("article", { name: "Refund Rp50.000" })).toBeNull();
  });
});
