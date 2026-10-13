import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockAuth, mockPayments, paymentRequests } from "../../api/mocks";
import { findToast, toasts } from "../../test/utils";
import { confirmReauth, IDS, openPayments, requestsTo } from "./testing";

const methodRequests = (method: string) => requestsTo(method, /^\/admin\/payment-methods/);

async function methodsTable() {
  return screen.findByRole("table", { name: "Metode pembayaran" });
}

function rowOf(table: HTMLElement, provider: string): HTMLElement {
  return within(table)
    .getByRole("rowheader", { name: new RegExp(provider.replace(/[[\]]/g, "\\$&")) })
    .closest("tr")!;
}

describe("kelola metode pembayaran (F-15, guidelines hlm. 17; server tiruan)", () => {
  it("F-15: daftar server-side dengan urutan tampil, status aktif, penanda sudah dipakai dan filter status", async () => {
    const user = userEvent.setup();
    await openPayments(user, { tab: "methods" });
    const table = await methodsTable();
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Urutan", "Penyedia", "Rekening", "Status", "Kelola"]);
    expect(
      within(table)
        .getAllByRole("rowheader")
        .map((h) => h.textContent),
    ).toEqual(["[Nama bank 1]Bank", "[Nama e-wallet]E-wallet", "[Nama bank 2]Bank"]);
    expect(screen.getByText("Menampilkan 3 dari 3")).toBeInTheDocument();

    const inUse = rowOf(table, "[Nama bank 1]");
    expect(within(inUse).getByText("Sudah dipakai")).toBeInTheDocument();
    expect(within(inUse).getByText("Aktif")).toBeInTheDocument();
    // Metode yang sudah dipakai hanya dapat dinonaktifkan: tidak ada tombol hapus.
    expect(within(inUse).queryByRole("button", { name: /Hapus/ })).toBeNull();
    expect(within(rowOf(table, "[Nama bank 2]")).getByText("Nonaktif")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "inactive");
    await screen.findByText("Menampilkan 1 dari 1");
    expect(methodRequests("GET").at(-1)?.query).toMatchObject({ active: "false" });
  });

  it("AC F15-3: tambah metode meminta reautentikasi lebih dahulu; batal reautentikasi tidak mengirim apa pun", async () => {
    const user = userEvent.setup();
    await openPayments(user, { tab: "methods" });
    await methodsTable();
    await user.click(screen.getByRole("button", { name: "Tambah metode" }));
    const dialog = await screen.findByRole("dialog", { name: "Tambah metode pembayaran" });
    expect(within(dialog).getByRole("spinbutton", { name: /Urutan tampil/ })).toHaveValue(3);
    await user.type(
      within(dialog).getByRole("textbox", { name: /Nama bank atau e-wallet/ }),
      "[[Nama bank 3]",
    );
    await user.type(within(dialog).getByRole("textbox", { name: /Nomor rekening/ }), "7001234567");
    await user.type(
      within(dialog).getByRole("textbox", { name: /Nama pemilik rekening/ }),
      "Bendahara KAPDH",
    );
    await user.click(within(dialog).getByRole("button", { name: "Simpan metode" }));

    const reauth = await screen.findByRole("dialog", { name: "Konfirmasi identitas" });
    expect(reauth).toHaveAccessibleDescription(/Menambah rekening tujuan pembayaran/);
    await user.click(within(reauth).getByRole("button", { name: "Batal" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Konfirmasi identitas" })).toBeNull());
    expect(methodRequests("POST")).toHaveLength(0);
    expect(toasts("error")).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Simpan metode" }));
    await confirmReauth(user, /Menambah rekening tujuan pembayaran/);
    expect(await findToast("success", "Metode pembayaran ditambahkan.")).toBeInTheDocument();
    const post = methodRequests("POST")[0];
    expect(post?.reauthToken).toMatch(/^mock-reauth-/);
    expect(post?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.body).toEqual({
      kind: "bank",
      provider: "[Nama bank 3]",
      account_number: "7001234567",
      account_holder: "Bendahara KAPDH",
      instructions: null,
      active: true,
      sort_order: 3,
    });
    await screen.findByText("Menampilkan 4 dari 4");
    expect(screen.queryByRole("dialog", { name: "Tambah metode pembayaran" })).toBeNull();
  });

  it("validasi isian wajib di klien sebelum reautentikasi", async () => {
    const user = userEvent.setup();
    await openPayments(user, { tab: "methods" });
    await methodsTable();
    await user.click(screen.getByRole("button", { name: "Tambah metode" }));
    const dialog = await screen.findByRole("dialog", { name: "Tambah metode pembayaran" });
    await user.type(within(dialog).getByRole("textbox", { name: /Petunjuk tambahan/ }), "<b>tebal</b>");
    await user.click(within(dialog).getByRole("button", { name: "Simpan metode" }));
    const provider = within(dialog).getByRole("textbox", { name: /Nama bank atau e-wallet/ });
    await waitFor(() => expect(provider).toHaveAccessibleDescription("Nama bank atau e-wallet wajib diisi."));
    expect(provider).toHaveFocus();
    expect(within(dialog).getByRole("textbox", { name: /Petunjuk tambahan/ })).toHaveAccessibleDescription(
      /teks polos tanpa HTML/,
    );
    expect(screen.queryByRole("dialog", { name: "Konfirmasi identitas" })).toBeNull();
    expect(methodRequests("POST")).toHaveLength(0);
  });

  it("AC F15-3: metode yang sudah dipakai hanya dapat diubah petunjuk, status dan urutan; dikirim dengan If-Match", async () => {
    const user = userEvent.setup();
    await openPayments(user, { tab: "methods" });
    await methodsTable();
    await user.click(screen.getByRole("button", { name: "Ubah [Nama bank 1]" }));
    const dialog = await screen.findByRole("dialog", { name: "Ubah metode pembayaran" });
    expect(within(dialog).getByRole("note")).toHaveTextContent("sudah dipakai pembayaran");
    expect(within(dialog).getByRole("textbox", { name: /Nama bank atau e-wallet/ })).toBeDisabled();
    expect(within(dialog).getByRole("textbox", { name: /Nomor rekening/ })).toBeDisabled();
    expect(within(dialog).getByRole("textbox", { name: /Nama pemilik rekening/ })).toBeDisabled();
    expect(within(dialog).getByRole("radio", { name: "E-wallet" })).toBeDisabled();

    await user.type(within(dialog).getByRole("textbox", { name: /Petunjuk tambahan/ }), "Kode bank 451.");
    await user.click(within(dialog).getByRole("switch", { name: "Tampilkan ke alumni" }));
    await user.click(within(dialog).getByRole("button", { name: "Simpan metode" }));
    await confirmReauth(user, /Mengubah rekening tujuan pembayaran/);
    expect(await findToast("success", "Metode pembayaran diperbarui.")).toBeInTheDocument();

    const put = methodRequests("PUT")[0];
    expect(put?.path).toBe(`/admin/payment-methods/${IDS.methodInUse}`);
    expect(put?.ifMatch).toBe("1");
    expect(put?.reauthToken).toMatch(/^mock-reauth-/);
    expect(put?.body).toMatchObject({
      provider: "[Nama bank 1]",
      account_number: "[Nomor rekening]",
      instructions: "Kode bank 451.",
      active: false,
    });
    expect(mockPayments.method(IDS.methodInUse)).toMatchObject({ active: false, version: "2" });
    const table = await methodsTable();
    await waitFor(() =>
      expect(within(rowOf(table, "[Nama bank 1]")).getByText("Nonaktif")).toBeInTheDocument(),
    );
  });

  it("AC F15-4: konflik versi menampilkan versi terbaru dan meminta muat ulang, tidak menimpa diam-diam", async () => {
    const user = userEvent.setup();
    await openPayments(user, { tab: "methods" });
    await methodsTable();
    await user.click(screen.getByRole("button", { name: "Ubah [Nama e-wallet]" }));
    const dialog = await screen.findByRole("dialog", { name: "Ubah metode pembayaran" });
    const provider = within(dialog).getByRole("textbox", { name: /Nama bank atau e-wallet/ });
    await user.clear(provider);
    await user.type(provider, "[[E-wallet baru]");
    mockPayments.updateMethodAsOtherAdmin(IDS.methodEwallet, { account_holder: "Bendahara Baru" });
    await user.click(within(dialog).getByRole("button", { name: "Simpan metode" }));
    await confirmReauth(user);

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Metode ini sudah diubah admin lain. Perubahan Anda belum disimpan.");
    expect(alert).toHaveTextContent("Bendahara Baru");
    expect(await findToast("error", "Metode sudah diubah admin lain")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Simpan metode" })).toBeDisabled();
    // Data server tidak ditimpa oleh formulir lama.
    expect(mockPayments.method(IDS.methodEwallet)).toMatchObject({
      provider: "[Nama e-wallet]",
      account_holder: "Bendahara Baru",
      version: "2",
    });

    await user.click(within(alert).getByRole("button", { name: "Muat versi terbaru" }));
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(within(dialog).getByRole("textbox", { name: /Nama pemilik rekening/ })).toHaveValue(
      "Bendahara Baru",
    );
    expect(provider).toHaveValue("[Nama e-wallet]");
    await user.clear(provider);
    await user.type(provider, "[[E-wallet baru]");
    await user.click(within(dialog).getByRole("button", { name: "Simpan metode" }));
    await confirmReauth(user);
    expect(await findToast("success", "Metode pembayaran diperbarui.")).toBeInTheDocument();
    const puts = methodRequests("PUT");
    expect(puts.map((r) => r.ifMatch)).toEqual(["1", "2"]);
    expect(mockPayments.method(IDS.methodEwallet)).toMatchObject({
      provider: "[E-wallet baru]",
      account_holder: "Bendahara Baru",
      version: "3",
    });
  });

  it("F-15, PRD 4.5: hapus metode belum dipakai dengan konfirmasi dua langkah, reautentikasi dan If-Match", async () => {
    const user = userEvent.setup();
    await openPayments(user, { tab: "methods" });
    const table = await methodsTable();
    await user.click(
      within(rowOf(table, "[Nama bank 2]")).getByRole("button", { name: "Hapus [Nama bank 2]" }),
    );
    const dialog = await screen.findByRole("alertdialog", { name: /Hapus metode pembayaran\?/ });
    const confirm = within(dialog).getByRole("button", { name: "Hapus metode" });
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Batal" })).toHaveFocus();
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(confirm);
    await confirmReauth(user, /Menghapus rekening tujuan pembayaran/);
    expect(await findToast("success", "Metode [Nama bank 2] dihapus.")).toBeInTheDocument();
    const del = methodRequests("DELETE")[0];
    expect(del?.path).toBe(`/admin/payment-methods/${IDS.methodInactive}`);
    expect(del?.ifMatch).toBe("2");
    expect(mockPayments.method(IDS.methodInactive)).toBeUndefined();
    await screen.findByText("Menampilkan 2 dari 2");
    // N-11: tombol hapus pemicu ikut hilang; fokus pindah ke tombol "Tambah metode", tidak jatuh ke <body>.
    expect(screen.queryByRole("button", { name: "Hapus [Nama bank 2]" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Tambah metode" })).toHaveFocus());
  });

  it("AC F15-3: ubah tanpa perubahan tidak meminta reautentikasi dan tidak mengirim PUT", async () => {
    const user = userEvent.setup();
    await openPayments(user, { tab: "methods" });
    await methodsTable();
    await user.click(screen.getByRole("button", { name: "Ubah [Nama e-wallet]" }));
    const dialog = await screen.findByRole("dialog", { name: "Ubah metode pembayaran" });
    const save = within(dialog).getByRole("button", { name: "Simpan metode" });
    expect(save).toBeDisabled();
    await user.click(save);
    expect(screen.queryByRole("dialog", { name: "Konfirmasi identitas" })).toBeNull();

    // Spasi di ujung isian dipangkas server sehingga tetap bukan perubahan.
    const holder = within(dialog).getByRole("textbox", { name: /Nama pemilik rekening/ });
    await user.type(holder, " ");
    expect(save).toBeDisabled();
    // Perubahan yang dikembalikan ke nilai semula juga bukan perubahan.
    await user.click(within(dialog).getByRole("switch", { name: "Tampilkan ke alumni" }));
    expect(save).toBeEnabled();
    await user.click(within(dialog).getByRole("switch", { name: "Tampilkan ke alumni" }));
    expect(save).toBeDisabled();
    expect(methodRequests("PUT")).toHaveLength(0);

    await user.click(within(dialog).getByRole("switch", { name: "Tampilkan ke alumni" }));
    await user.click(save);
    await confirmReauth(user, /Mengubah rekening tujuan pembayaran/);
    expect(await findToast("success", "Metode pembayaran diperbarui.")).toBeInTheDocument();
    expect(methodRequests("PUT")).toHaveLength(1);
    expect(methodRequests("PUT")[0]?.body).toMatchObject({
      account_holder: "[Nama pemilik akun]",
      active: false,
    });
  });

  it("AC F15-1: admin pembayaran tanpa settings.manage tidak melihat tab metode dan biaya", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read", "payments.decide"] });
    const user = userEvent.setup();
    await openPayments(user, { tab: "methods" });
    const tabs = screen.getByRole("tablist", { name: "Menu pembayaran" });
    const names = within(tabs)
      .getAllByRole("tab")
      .map((t) => t.textContent ?? "");
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^Verifikasi Pembayaran/);
    expect(names[1]).toMatch(/^Penyesuaian/);
    // ?tab=methods tidak diizinkan: tab pertama yang diizinkan yang tampil.
    expect(await screen.findByRole("table", { name: "Antrean pembayaran" })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Metode pembayaran" })).toBeNull();
    expect(paymentRequests.some((r) => r.path.startsWith("/admin/payment-methods"))).toBe(false);
    expect(paymentRequests.some((r) => r.path === "/admin/settings/fees")).toBe(false);
  });
});
