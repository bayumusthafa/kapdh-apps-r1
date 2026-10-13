import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockAuth } from "../../api/mocks";
import { adminRequests, MOCK_ADMIN_IDS, MOCK_CANDIDATE_IDS, mockAdmins, PERMISSION_CATALOG } from "../../api/mocks/admins";
import { confirmReauth, openPage, section } from "../../test/governance";
import { findToast, renderApp, signIn, type User } from "../../test/utils";
import { togglePermission } from "./shared";

const writes = () => adminRequests.filter((r) => r.method !== "GET");

async function openDetail(user: User, id: string, name: string) {
  return openPage(user, `/admins/${id}`, name);
}

async function saveAccess(user: User) {
  const card = await section("Peran & izin");
  await user.click(within(card).getByRole("button", { name: "Simpan perubahan" }));
  const confirm = await screen.findByRole("alertdialog", { name: /Simpan perubahan izin/ });
  await user.click(within(confirm).getByRole("button", { name: "Simpan perubahan" }));
  await confirmReauth(user);
  return card;
}

describe("katalog izin (F-16)", () => {
  it("memilih izin ikut memilih prasyarat; melepas prasyarat ikut melepas izin turunannya", () => {
    const on = togglePermission([], "payments.decide", true, PERMISSION_CATALOG);
    expect(on.next).toEqual(["payments.read", "payments.decide"]);
    expect(on.note).toMatch(/Lihat pembayaran ikut dipilih/);
    const off = togglePermission(on.next, "payments.read", false, PERMISSION_CATALOG);
    expect(off.next).toEqual([]);
    expect(off.note).toMatch(/Putuskan pembayaran ikut dilepas/);
  });
});

describe("Manajemen Admin (F-16, guideline hlm. 15; server tiruan)", () => {
  it("F-16: daftar admin menampilkan jumlah, chip Role & Akses dan status berlabel", async () => {
    const user = userEvent.setup();
    await openPage(user, "/admins", "Manajemen Admin");
    expect(await screen.findByText("2 aktif, 1 diundang, 2 nonaktif")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Daftar admin" });
    const ahmad = within(table).getByRole("link", { name: "Ahmad Zulhadi" }).closest("tr")!;
    const chips = within(ahmad).getByRole("list", { name: "Peran dan akses" });
    expect(within(chips).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "USER",
      "Admin",
      "Pembayaran",
      "Konten",
      "Event",
    ]);
    expect(within(ahmad).getByText("Aktif")).toBeInTheDocument();
    const rina = within(table).getByRole("link", { name: "Rina Kartika" }).closest("tr")!;
    expect(within(rina).getByText("Diundang")).toBeInTheDocument();
    expect(within(rina).getByText(/Undangan s\.d\./)).toBeInTheDocument();
    const bayu = within(table).getByRole("link", { name: "Bayu Musthafa" }).closest("tr")!;
    expect(within(bayu).getByText("Semua akses")).toBeInTheDocument();
    expect(within(bayu).getByText("Akun Anda")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "Kelola Ahmad Zulhadi" })).toHaveAttribute(
      "href",
      `/admins/${MOCK_ADMIN_IDS.ahmad}`,
    );
  });

  it("pencarian dan filter status dikirim ke server (paging server, F-15)", async () => {
    const user = userEvent.setup();
    await openPage(user, "/admins", "Manajemen Admin");
    await screen.findByText("Menampilkan 5 dari 5");
    await user.type(screen.getByRole("searchbox", { name: "Cari admin" }), "ahmad");
    await screen.findByText("Menampilkan 1 dari 1");
    await user.clear(screen.getByRole("searchbox", { name: "Cari admin" }));
    await screen.findByText("Menampilkan 5 dari 5");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "invited");
    await screen.findByText("Menampilkan 1 dari 1");
    const last = adminRequests.filter((r) => r.path === "/admin/admins").at(-1);
    expect(last?.query).toMatchObject({ status: "invited", sort: "display_name_asc" });
  });

  it("AC F16-1: delegasi alumni menjadi admin — kandidat tak layak ditandai, izin berlabel, reautentikasi, Idempotency-Key", async () => {
    const user = userEvent.setup();
    await openPage(user, "/admins", "Manajemen Admin");
    await user.click(screen.getByRole("button", { name: "Delegasi User jadi Admin" }));
    const dialog = await screen.findByRole("dialog", { name: "Delegasi User jadi Admin" });
    const list = await within(dialog).findByRole("list", { name: "Kandidat admin" });
    const bayu = within(list).getByText("Bayu Musthafa Arief").closest("li")!;
    expect(within(bayu).queryByRole("button")).toBeNull();
    expect(within(bayu).getByText(/Sudah tertaut ke identitas admin/)).toBeInTheDocument();
    const sari = within(list).getByText("Sari Dewi").closest("li")!;
    expect(within(sari).getByText(/Sedang dibatasi pengurus/)).toBeInTheDocument();

    await user.click(within(list).getByRole("button", { name: "Jadikan Admin ridwan" }));
    await user.click(await within(dialog).findByLabelText(/^Putuskan pembayaran/));
    expect(within(dialog).getByLabelText(/^Lihat pembayaran/)).toBeChecked();
    expect(within(dialog).getByText(/Lihat pembayaran ikut dipilih/)).toBeInTheDocument();
    // admins.manage tidak dapat ditugaskan ke peran Admin.
    expect(within(dialog).getByLabelText(/^Kelola admin dan izin/)).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Kirim undangan" }));
    await confirmReauth(user);
    expect(await within(dialog).findByText("Undangan dijadwalkan")).toBeInTheDocument();
    expect(within(dialog).getByText("info.kapdh@gmail.com")).toBeInTheDocument();
    const post = writes().find((r) => r.method === "POST" && r.path === "/admin/admins");
    expect(post?.body).toEqual({
      alumni_user_id: MOCK_CANDIDATE_IDS.ridwan,
      role: "admin",
      permissions: ["payments.read", "payments.decide"],
    });
    expect(post?.reauth).toBe(true);
    expect(post?.idempotencyKey).toBeTruthy();
    expect(mockAdmins.count()).toBe(6);
    await user.click(within(dialog).getByRole("link", { name: "Lihat detail admin" }));
    expect(await screen.findByRole("heading", { level: 1, name: "ridwan" })).toBeInTheDocument();
  });

  it("F-16: undangan lewat email wajib email dan nama; email bentrok ditolak 409 pada isian email", async () => {
    const user = userEvent.setup();
    await openPage(user, "/admins", "Manajemen Admin");
    await user.click(screen.getByRole("button", { name: "Delegasi User jadi Admin" }));
    const dialog = await screen.findByRole("dialog", { name: "Delegasi User jadi Admin" });
    await user.click(within(dialog).getByLabelText(/Undang lewat email/));
    await user.click(within(dialog).getByRole("button", { name: "Kirim undangan" }));
    const email = within(dialog).getByLabelText(/^Email login admin/);
    await waitFor(() => expect(email).toHaveAccessibleDescription(/Email login wajib diisi/));
    expect(within(dialog).getByLabelText(/^Nama tampilan admin/)).toHaveAccessibleDescription(/wajib diisi/);
    await user.type(email, "rina@kapdh.test");
    await user.type(within(dialog).getByLabelText(/^Nama tampilan admin/), "Rina Dua");
    await user.click(within(dialog).getByLabelText(/^Check-in tiket/));
    await user.click(within(dialog).getByRole("button", { name: "Kirim undangan" }));
    await confirmReauth(user);
    await waitFor(() => expect(email).toHaveAccessibleDescription(/sudah dipakai identitas admin lain/));
    expect(mockAdmins.count()).toBe(5);
  });

  it("AC F16-1: ubah izin admin — ringkasan perubahan dikonfirmasi, reautentikasi, If-Match, versi izin naik", async () => {
    const user = userEvent.setup();
    await openDetail(user, MOCK_ADMIN_IDS.ahmad, "Ahmad Zulhadi");
    const card = await section("Peran & izin");
    await user.click(await within(card).findByLabelText(/^Kelola konten/));
    await user.click(within(card).getByRole("button", { name: "Simpan perubahan" }));
    const confirm = await screen.findByRole("alertdialog", { name: /Simpan perubahan izin/ });
    expect(within(confirm).getByRole("list", { name: "Ringkasan perubahan" })).toHaveTextContent(
      "Izin dicabut: Kelola konten",
    );
    await user.click(within(confirm).getByRole("button", { name: "Simpan perubahan" }));
    await confirmReauth(user);
    expect(await screen.findByText(/Perubahan Ahmad Zulhadi tersimpan \(versi izin 2\)/)).toBeInTheDocument();
    const patch = writes().find((r) => r.method === "PATCH");
    expect(patch).toMatchObject({ ifMatch: "1", reauth: true });
    expect(patch?.body).toEqual({ permissions: ["payments.read", "payments.decide", "events.manage"] });
    expect(mockAdmins.get(MOCK_ADMIN_IDS.ahmad)?.permissions).not.toContain("content.manage");
  });

  it("AC F16-2: Super Admin aktif terakhir tidak dapat diturunkan; galat server tampil pada isian peran", async () => {
    const user = userEvent.setup();
    await openDetail(user, MOCK_ADMIN_IDS.bayu, "Bayu Musthafa");
    const card = await section("Peran & izin");
    expect(within(card).getByRole("note")).toHaveTextContent("Ini akun Anda sendiri");
    await user.click(within(card).getByLabelText(/^Admin/));
    await user.click(await within(card).findByLabelText(/^Lihat audit/));
    await saveAccess(user);
    await waitFor(() =>
      expect(within(card).getByRole("group", { name: /Peran/ })).toHaveAccessibleDescription(
        /Minimal satu Super Admin aktif/,
      ),
    );
    expect(mockAdmins.get(MOCK_ADMIN_IDS.bayu)?.role).toBe("super_admin");
  });

  it("AC F15-4: data admin diubah pengurus lain → 409, tampilan dimuat ulang tanpa menimpa", async () => {
    const user = userEvent.setup();
    await openDetail(user, MOCK_ADMIN_IDS.ahmad, "Ahmad Zulhadi");
    const card = await section("Peran & izin");
    mockAdmins.changeElsewhere(MOCK_ADMIN_IDS.ahmad, { display_name: "Ahmad Z." });
    await user.click(await within(card).findByLabelText(/^Check-in tiket/));
    await saveAccess(user);
    expect(await screen.findByText(/sudah diubah pengurus lain/)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: "Ahmad Z." })).toBeInTheDocument();
    expect(mockAdmins.get(MOCK_ADMIN_IDS.ahmad)?.permissions).not.toContain("events.checkin");
    expect(writes().filter((r) => r.method === "PATCH")).toHaveLength(1);
  });

  it("F-16: nonaktifkan admin wajib alasan dan pernyataan; setelahnya tersedia aktifkan kembali dan pemulihan", async () => {
    const user = userEvent.setup();
    await openDetail(user, MOCK_ADMIN_IDS.ahmad, "Ahmad Zulhadi");
    const status = await section("Status & pemulihan");
    await user.click(within(status).getByRole("button", { name: "Nonaktifkan admin" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Nonaktifkan admin?" });
    await user.click(within(dialog).getByRole("button", { name: "Nonaktifkan" }));
    const reason = within(dialog).getByLabelText(/^Alasan/);
    await waitFor(() => expect(reason).toHaveAccessibleDescription(/minimal 3 karakter/));
    expect(within(dialog).getByText("Centang pernyataan ini.")).toBeInTheDocument();
    await user.type(reason, "Masa jabatan pengurus berakhir");
    await user.click(within(dialog).getByLabelText(/Saya memahami admin ini langsung keluar/));
    await user.click(within(dialog).getByRole("button", { name: "Nonaktifkan" }));
    await confirmReauth(user);
    expect(await screen.findByText(/Ahmad Zulhadi dinonaktifkan; semua sesinya dicabut/)).toBeInTheDocument();
    expect(within(status).getByRole("button", { name: "Aktifkan kembali" })).toBeInTheDocument();
    expect(within(status).getByRole("button", { name: /Pulihkan akun/ })).toBeInTheDocument();
    expect(writes().at(-1)?.body).toEqual({ status: "disabled", reason: "Masa jabatan pengurus berakhir" });
  });

  it("F-16 pemulihan: admin pernah aktif direset sandi & autentikator lewat undangan ulang, sesi dicabut", async () => {
    const user = userEvent.setup();
    await openDetail(user, MOCK_ADMIN_IDS.ahmad, "Ahmad Zulhadi");
    const status = await section("Status & pemulihan");
    await user.click(within(status).getByRole("button", { name: /Pulihkan akun/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Pulihkan akun admin?" });
    await user.type(within(dialog).getByLabelText(/^Alasan pemulihan/), "Ponsel autentikator hilang");
    await user.click(within(dialog).getByLabelText(/Saya sudah memverifikasi identitas/));
    await user.click(within(dialog).getByRole("button", { name: "Pulihkan akun" }));
    await confirmReauth(user);
    expect(await screen.findByText(/direset, 1 sesi dicabut/)).toBeInTheDocument();
    const recovery = writes().find((r) => r.path.endsWith("/recovery"));
    expect(recovery).toMatchObject({ ifMatch: "1", reauth: true });
    expect(recovery?.idempotencyKey).toBeTruthy();
    expect(recovery?.body).toEqual({ reason: "Ponsel autentikator hilang" });
    const identity = await section("Identitas");
    expect(within(identity).getByText("Diundang")).toBeInTheDocument();
    expect(within(identity).getByText("Belum terdaftar")).toBeInTheDocument();
  });

  it("akun sendiri tidak menawarkan pemulihan (gunakan ganti sandi/backup code)", async () => {
    const user = userEvent.setup();
    await openDetail(user, MOCK_ADMIN_IDS.bayu, "Bayu Musthafa");
    const status = await section("Status & pemulihan");
    expect(within(status).queryByRole("button", { name: /Pulihkan akun/ })).toBeNull();
    expect(within(status).getByText(/Akun sendiri tidak dapat dipulihkan dari sini/)).toBeInTheDocument();
  });

  it("F-16: kirim ulang undangan lalu hapus identitas yang belum pernah aktif (ketik nama untuk konfirmasi)", async () => {
    const user = userEvent.setup();
    const { router } = await openDetail(user, MOCK_ADMIN_IDS.rina, "Rina Kartika");
    const status = await section("Status & pemulihan");
    expect(within(status).queryByRole("button", { name: /Pulihkan akun/ })).toBeNull();
    await user.click(within(status).getByRole("button", { name: "Kirim ulang undangan" }));
    const resend = await screen.findByRole("dialog", { name: "Kirim ulang undangan?" });
    await user.click(within(resend).getByRole("button", { name: "Kirim ulang undangan" }));
    await confirmReauth(user);
    expect(await screen.findByText(/Undangan baru dikirim ke rina@kapdh.test/)).toBeInTheDocument();

    await user.click(within(status).getByRole("button", { name: "Hapus identitas admin" }));
    const del = await screen.findByRole("alertdialog", { name: /Hapus identitas admin/ });
    const confirm = within(del).getByRole("button", { name: "Hapus identitas" });
    expect(confirm).toBeDisabled();
    await user.type(within(del).getByLabelText(/Ketik/), "Rina Kartika");
    await user.click(confirm);
    await confirmReauth(user);
    expect(await findToast("success", "Identitas admin Rina Kartika dihapus")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/admins"));
    expect(mockAdmins.get(MOCK_ADMIN_IDS.rina)).toBeUndefined();
    // If-Match versi terbaru (setelah kirim ulang versi naik menjadi 2).
    expect(writes().find((r) => r.method === "DELETE")?.ifMatch).toBe("2");
  });

  it("detail admin yang tidak ada menampilkan Data tidak ditemukan", async () => {
    const user = userEvent.setup();
    renderApp("/admins/0199e000-0000-7000-8000-00000000dead");
    await signIn(user);
    expect(await screen.findByText("Data tidak ditemukan")).toBeInTheDocument();
  });

  it("AC F15-1: admin tanpa admins.manage ditolak di daftar dan detail tanpa memanggil API admin", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["audit.read"] });
    const user = userEvent.setup();
    renderApp(`/admins/${MOCK_ADMIN_IDS.ahmad}`);
    await signIn(user);
    expect(await screen.findByRole("heading", { level: 1, name: "Akses ditolak" })).toBeInTheDocument();
    expect(adminRequests.filter((r) => r.path.startsWith("/admin/admins"))).toHaveLength(0);
  });
});
