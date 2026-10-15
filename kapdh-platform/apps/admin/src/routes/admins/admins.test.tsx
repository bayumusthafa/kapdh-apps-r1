import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockAuth } from "../../api/mocks";
import {
  adminRequests,
  MOCK_ADMIN_IDS,
  MOCK_CANDIDATE_IDS,
  mockAdmins,
  PERMISSION_CATALOG,
} from "../../api/mocks/admins";
import { confirmReauth, expectNoReauthDialog, openPage, section } from "../../test/governance";
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
    expect(
      within(chips)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["USER", "Admin", "Pembayaran", "Konten", "Event"]);
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

  it("AC F16-1, ADR-025: delegasi alumni menjadi admin — kandidat tak layak ditandai, izin berlabel, Idempotency-Key, tanpa reautentikasi", async () => {
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
    expect(await within(dialog).findByText("Undangan dijadwalkan")).toBeInTheDocument();
    expectNoReauthDialog();
    expect(within(dialog).getByText("info.kapdh@gmail.com")).toBeInTheDocument();
    const post = writes().find((r) => r.method === "POST" && r.path === "/admin/admins");
    expect(post?.body).toEqual({
      alumni_user_id: MOCK_CANDIDATE_IDS.ridwan,
      role: "admin",
      permissions: ["payments.read", "payments.decide"],
    });
    expect(post?.reauth).toBe(false);
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
    await waitFor(() => expect(email).toHaveAccessibleDescription(/sudah dipakai identitas admin lain/));
    expectNoReauthDialog();
    expect(mockAdmins.count()).toBe(5);
  });

  it("AC F16-1, ADR-025: ubah izin admin — ringkasan perubahan dikonfirmasi, If-Match, versi izin naik, tanpa reautentikasi", async () => {
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
    expect(await screen.findByText(/Perubahan Ahmad Zulhadi tersimpan \(versi izin 2\)/)).toBeInTheDocument();
    expectNoReauthDialog();
    const patch = writes().find((r) => r.method === "PATCH");
    expect(patch).toMatchObject({ ifMatch: "1", reauth: false });
    expect(patch?.body).toEqual({ permissions: ["payments.read", "payments.decide", "events.manage"] });
    expect(mockAdmins.get(MOCK_ADMIN_IDS.ahmad)?.permissions).not.toContain("content.manage");
  });

  it("AC F16-2: Super Admin aktif terakhir tidak dapat diturunkan; dialog konfirmasi tertutup, galat tampil dan difokuskan pada isian peran", async () => {
    const user = userEvent.setup();
    await openDetail(user, MOCK_ADMIN_IDS.bayu, "Bayu Musthafa");
    const card = await section("Peran & izin");
    expect(within(card).getByRole("note")).toHaveTextContent("Ini akun Anda sendiri");
    await user.click(within(card).getByLabelText(/^Admin/));
    await user.click(await within(card).findByLabelText(/^Lihat audit/));
    await saveAccess(user);
    const roleGroup = within(card).getByRole("group", { name: /Peran/ });
    await waitFor(() => expect(roleGroup).toHaveAccessibleDescription(/Minimal satu Super Admin aktif/));
    // Galat yang ditolak server tidak boleh tertinggal di balik dialog yang masih terbuka (N-11, PRD 4.5).
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(roleGroup).toContainElement(document.activeElement as HTMLElement));
    expect(document.activeElement).toHaveAttribute("type", "radio");
    expect(mockAdmins.get(MOCK_ADMIN_IDS.bayu)?.role).toBe("super_admin");
    expect(writes().filter((r) => r.method === "PATCH")).toHaveLength(1);
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
    expect(await screen.findByText(/Ahmad Zulhadi dinonaktifkan; semua sesinya dicabut/)).toBeInTheDocument();
    expectNoReauthDialog();
    expect(within(status).getByRole("button", { name: "Aktifkan kembali" })).toBeInTheDocument();
    expect(within(status).getByRole("button", { name: /Pulihkan akun/ })).toBeInTheDocument();
    expect(writes().at(-1)?.body).toEqual({ status: "disabled", reason: "Masa jabatan pengurus berakhir" });
    expect(writes().at(-1)).toMatchObject({ method: "PATCH", ifMatch: "1", reauth: false });
  });

  it("F-16 pemulihan (tindakan kredensial, ADR-025): reautentikasi tetap diminta; sandi & autentikator direset lewat undangan ulang, sesi dicabut", async () => {
    const user = userEvent.setup();
    await openDetail(user, MOCK_ADMIN_IDS.ahmad, "Ahmad Zulhadi");
    const status = await section("Status & pemulihan");
    await user.click(within(status).getByRole("button", { name: /Pulihkan akun/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Pulihkan akun admin?" });
    await user.type(within(dialog).getByLabelText(/^Alasan pemulihan/), "Ponsel autentikator hilang");
    await user.click(within(dialog).getByLabelText(/Saya sudah memverifikasi identitas/));
    await user.click(within(dialog).getByRole("button", { name: "Pulihkan akun" }));
    expect(await screen.findByRole("dialog", { name: /Konfirmasi identitas/ })).toHaveAccessibleDescription(
      /Memulihkan akun Ahmad Zulhadi/,
    );
    expect(writes().filter((r) => r.path.endsWith("/recovery"))).toHaveLength(0);
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

  it("F-16, ADR-025: kirim ulang undangan (dengan reautentikasi) lalu hapus identitas yang belum pernah aktif (ketik nama, tanpa reautentikasi)", async () => {
    const user = userEvent.setup();
    const { router } = await openDetail(user, MOCK_ADMIN_IDS.rina, "Rina Kartika");
    const status = await section("Status & pemulihan");
    expect(within(status).queryByRole("button", { name: /Pulihkan akun/ })).toBeNull();
    await user.click(within(status).getByRole("button", { name: "Kirim ulang undangan" }));
    const resend = await screen.findByRole("dialog", { name: "Kirim ulang undangan?" });
    await user.click(within(resend).getByRole("button", { name: "Kirim ulang undangan" }));
    expect(await screen.findByRole("dialog", { name: /Konfirmasi identitas/ })).toHaveAccessibleDescription(
      /Mengirim ulang undangan Rina Kartika/,
    );
    await confirmReauth(user);
    expect(await screen.findByText(/Undangan baru dikirim ke rina@kapdh.test/)).toBeInTheDocument();
    expect(writes().find((r) => r.path.endsWith("/invitation"))).toMatchObject({
      ifMatch: "1",
      reauth: true,
    });

    await user.click(within(status).getByRole("button", { name: "Hapus identitas admin" }));
    const del = await screen.findByRole("alertdialog", { name: /Hapus identitas admin/ });
    const confirm = within(del).getByRole("button", { name: "Hapus identitas" });
    expect(confirm).toBeDisabled();
    await user.type(within(del).getByLabelText(/Ketik/), "Rina Kartika");
    await user.click(confirm);
    expect(await findToast("success", "Identitas admin Rina Kartika dihapus")).toBeInTheDocument();
    expectNoReauthDialog();
    await waitFor(() => expect(router.state.location.pathname).toBe("/admins"));
    expect(mockAdmins.get(MOCK_ADMIN_IDS.rina)).toBeUndefined();
    // If-Match versi terbaru (setelah kirim ulang versi naik menjadi 2).
    expect(writes().find((r) => r.method === "DELETE")).toMatchObject({ ifMatch: "2", reauth: false });
  });

  it("ADR-025: kirim ulang undangan tetap membuka dialog Konfirmasi identitas; batal = undangan tidak dikirim", async () => {
    const user = userEvent.setup();
    await openDetail(user, MOCK_ADMIN_IDS.rina, "Rina Kartika");
    const status = await section("Status & pemulihan");
    await user.click(within(status).getByRole("button", { name: "Kirim ulang undangan" }));
    const resend = await screen.findByRole("dialog", { name: "Kirim ulang undangan?" });
    await user.click(within(resend).getByRole("button", { name: "Kirim ulang undangan" }));
    const reauth = await screen.findByRole("dialog", { name: /Konfirmasi identitas/ });
    expect(reauth).toHaveAccessibleDescription(/Mengirim ulang undangan Rina Kartika/);
    await user.click(within(reauth).getByRole("button", { name: "Batal" }));
    await waitFor(() => expectNoReauthDialog());
    expect(writes()).toHaveLength(0);
    expect(screen.queryByText(/Undangan baru dikirim/)).toBeNull();
    expect(mockAdmins.get(MOCK_ADMIN_IDS.rina)?.version).toBe("1");
  });

  it("ADR-025: aktifkan kembali admin tersimpan tanpa dialog Konfirmasi identitas dan tanpa X-Reauth-Token", async () => {
    const user = userEvent.setup();
    await openDetail(user, MOCK_ADMIN_IDS.dedi, "Dedi Pratama");
    const status = await section("Status & pemulihan");
    await user.click(within(status).getByRole("button", { name: "Aktifkan kembali" }));
    const dialog = await screen.findByRole("dialog", { name: "Aktifkan kembali admin?" });
    await user.click(within(dialog).getByRole("button", { name: "Aktifkan kembali" }));
    expect(
      await screen.findByText(/Dedi Pratama aktif kembali dengan sandi dan autentikator lamanya/),
    ).toBeInTheDocument();
    expectNoReauthDialog();
    expect(writes()).toEqual([
      expect.objectContaining({ method: "PATCH", ifMatch: "1", reauth: false, body: { status: "active" } }),
    ]);
    expect(mockAdmins.get(MOCK_ADMIN_IDS.dedi)?.status).toBe("active");
  });

  it("ADR-025: koreksi email login adalah tindakan kredensial: dialog Konfirmasi identitas lalu PATCH dengan X-Reauth-Token", async () => {
    const user = userEvent.setup();
    await openDetail(user, MOCK_ADMIN_IDS.rina, "Rina Kartika");
    const status = await section("Status & pemulihan");
    await user.click(within(status).getByRole("button", { name: "Koreksi email login" }));
    const dialog = await screen.findByRole("dialog", { name: "Koreksi email login" });
    const email = within(dialog).getByLabelText(/^Email login baru/);
    await user.clear(email);
    await user.type(email, "rina.baru@kapdh.test");
    await user.click(within(dialog).getByRole("button", { name: "Simpan email" }));
    expect(await screen.findByRole("dialog", { name: /Konfirmasi identitas/ })).toHaveAccessibleDescription(
      /Mengoreksi email login Rina Kartika/,
    );
    await confirmReauth(user);
    expect(await screen.findByText(/Email login diganti ke rina\.baru@kapdh\.test/)).toBeInTheDocument();
    expect(writes()).toEqual([
      expect.objectContaining({
        method: "PATCH",
        ifMatch: "1",
        reauth: true,
        body: { email: "rina.baru@kapdh.test" },
      }),
    ]);
    expect(mockAdmins.get(MOCK_ADMIN_IDS.rina)?.email).toBe("rina.baru@kapdh.test");
  });

  it("ADR-025: batal di dialog Konfirmasi identitas = email login tidak dikoreksi", async () => {
    const user = userEvent.setup();
    await openDetail(user, MOCK_ADMIN_IDS.rina, "Rina Kartika");
    const status = await section("Status & pemulihan");
    await user.click(within(status).getByRole("button", { name: "Koreksi email login" }));
    const dialog = await screen.findByRole("dialog", { name: "Koreksi email login" });
    const email = within(dialog).getByLabelText(/^Email login baru/);
    await user.clear(email);
    await user.type(email, "penyerang@contoh.test");
    await user.click(within(dialog).getByRole("button", { name: "Simpan email" }));
    const reauth = await screen.findByRole("dialog", { name: /Konfirmasi identitas/ });
    await user.click(within(reauth).getByRole("button", { name: "Batal" }));
    await waitFor(() => expectNoReauthDialog());
    expect(writes()).toHaveLength(0);
    expect(mockAdmins.get(MOCK_ADMIN_IDS.rina)?.email).toBe("rina@kapdh.test");
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
