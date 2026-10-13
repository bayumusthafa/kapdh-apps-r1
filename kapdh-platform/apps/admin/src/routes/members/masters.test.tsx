import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockAuth } from "../../api/mocks";
import { MOCK_MEMBER, memberRequests, mockMembers, professionId, skillId } from "../../api/mocks/members";
import { findToast, renderApp, signIn, type User } from "../../test/utils";

/**
 * Manajemen Skill & Profesi (F-10, F-15, AC F10-4, F15-4) terhadap server tiruan src/api/mocks/members.ts. Bukti
 * mock bukan bukti AC sisi server (PRD 7.3).
 */

async function openMasters(user: User, path = "/members/masters") {
  renderApp(path);
  await signIn(user);
  await screen.findByRole("heading", { level: 1, name: "Manajemen Skill & Profesi" });
}

function row(name: string): HTMLElement {
  const table = screen.getByRole("table");
  return within(table).getByRole("rowheader", { name }).closest("tr") as HTMLElement;
}

const writes = () => memberRequests.filter((r) => r.method !== "GET" && r.path.startsWith("/admin/masters"));

describe("master profesi dan keahlian (F-10, AC F10-4; server tiruan)", () => {
  it("F-10: daftar profesi menampilkan status, jumlah pemakaian dan aksi; tab keahlian tersimpan di URL", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/members/masters");
    await signIn(user);
    await screen.findByRole("heading", { level: 1, name: "Manajemen Skill & Profesi" });
    expect(await screen.findByRole("table", { name: "Daftar profesi" })).toBeInTheDocument();
    expect(screen.getByText("Menampilkan 11 dari 11")).toBeInTheDocument();
    const guru = row("Guru");
    expect(within(guru).getByText("Aktif")).toBeInTheDocument();
    expect(within(guru).getByText("6 alumni")).toBeInTheDocument();
    // Master terpakai tidak memiliki tombol hapus; dinonaktifkan sebagai gantinya (AC F10-4).
    expect(within(guru).queryByRole("button", { name: "Hapus Guru" })).toBeNull();
    expect(within(guru).getByRole("button", { name: "Nonaktifkan Guru" })).toBeInTheDocument();
    const petani = row("Petani/Peternak/Nelayan");
    expect(within(petani).getByText("Nonaktif")).toBeInTheDocument();
    expect(within(petani).getByText("1 alumni")).toBeInTheDocument();
    expect(
      within(petani).getByRole("button", { name: "Aktifkan Petani/Peternak/Nelayan" }),
    ).toBeInTheDocument();
    expect(within(row("Pensiunan")).getByRole("button", { name: "Hapus Pensiunan" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Keahlian" }));
    expect(await screen.findByRole("table", { name: "Daftar keahlian" })).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ kind: "skills" });
    expect(await screen.findByRole("rowheader", { name: "Kuliner" })).toBeInTheDocument();
  });

  it("F-15: pencarian, filter status dan urutan dikirim ke server", async () => {
    const user = userEvent.setup();
    await openMasters(user);
    await screen.findByText("Menampilkan 11 dari 11");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "false");
    expect(await screen.findByText("Menampilkan 2 dari 2")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Urutkan" }), "usage_desc");
    await user.type(screen.getByRole("searchbox", { name: "Cari profesi" }), "pen");
    expect(await screen.findByText("Menampilkan 1 dari 1")).toBeInTheDocument();
    const last = memberRequests.filter((r) => r.path === "/admin/masters/professions").at(-1);
    expect(last?.query).toMatchObject({ active: "false", sort: "usage_desc", q: "pen" });
  });

  it("AC F10-4: menonaktifkan master terpakai meminta konfirmasi dan memakai If-Match", async () => {
    const user = userEvent.setup();
    await openMasters(user);
    await screen.findByText("Menampilkan 11 dari 11");
    await user.click(within(row("Guru")).getByRole("button", { name: "Nonaktifkan Guru" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Nonaktifkan Guru?" });
    expect(dialog).toHaveTextContent("6 alumni yang sudah memakainya tetap menampilkan labelnya");
    await user.click(within(dialog).getByRole("button", { name: "Nonaktifkan" }));
    expect(await findToast("success", "Guru dinonaktifkan")).toBeInTheDocument();
    await waitFor(() => expect(within(row("Guru")).getByText("Nonaktif")).toBeInTheDocument());
    expect(writes()[0]).toMatchObject({ method: "PATCH", ifMatch: "1", body: { active: false } });
    expect(mockMembers.master(professionId("Guru"))?.active).toBe(false);
    // Anggota yang memakai tetap menampilkan label historis.
    expect(mockMembers.get(MOCK_MEMBER.umar)?.profession).toMatchObject({ label: "Guru", active: false });
  });

  it("AC F10-4: hapus master yang ternyata sudah dipakai ditolak server dan ditawarkan untuk dinonaktifkan", async () => {
    const user = userEvent.setup();
    await openMasters(user, "/members/masters?kind=skills");
    await screen.findByRole("table", { name: "Daftar keahlian" });
    await screen.findByRole("rowheader", { name: "Analisis Data" });
    // Alumni memilih keahlian ini setelah daftar dimuat.
    mockMembers.useMaster(MOCK_MEMBER.ridwan, skillId("Analisis Data"));
    await user.click(within(row("Analisis Data")).getByRole("button", { name: "Hapus Analisis Data" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Hapus Analisis Data?" });
    await user.click(within(confirm).getByRole("checkbox"));
    await user.click(within(confirm).getByRole("button", { name: "Hapus keahlian" }));

    expect(await findToast("error", "dipakai 1 alumni")).toBeInTheDocument();
    const deactivate = await screen.findByRole("alertdialog", { name: "Nonaktifkan Analisis Data?" });
    expect(deactivate).toHaveTextContent("1 alumni yang sudah memakainya");
    await user.click(within(deactivate).getByRole("button", { name: "Nonaktifkan" }));
    await waitFor(() => expect(mockMembers.master(skillId("Analisis Data"))?.active).toBe(false));
    expect(mockMembers.master(skillId("Analisis Data"))).toBeDefined();
  });

  it("F-15: master yang belum dipakai dapat dihapus setelah konfirmasi dua langkah", async () => {
    const user = userEvent.setup();
    await openMasters(user);
    await screen.findByText("Menampilkan 11 dari 11");
    await user.click(within(row("Pensiunan")).getByRole("button", { name: "Hapus Pensiunan" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Hapus Pensiunan?" });
    const remove = within(confirm).getByRole("button", { name: "Hapus profesi" });
    expect(remove).toBeDisabled();
    await user.click(within(confirm).getByRole("checkbox"));
    await user.click(remove);
    expect(await findToast("success", "Pensiunan dihapus.")).toBeInTheDocument();
    expect(await screen.findByText("Menampilkan 10 dari 10")).toBeInTheDocument();
    expect(writes()[0]).toMatchObject({ method: "DELETE", ifMatch: "1" });
  });

  it("F-15: tambah master; label ganda (tanpa beda huruf besar) ditolak pada isian label", async () => {
    const user = userEvent.setup();
    await openMasters(user);
    await screen.findByText("Menampilkan 11 dari 11");
    await user.click(screen.getByRole("button", { name: "Tambah profesi" }));
    let dialog = await screen.findByRole("dialog", { name: "Tambah profesi" });
    const label = within(dialog).getByRole("textbox", { name: /Label/ });
    await user.type(label, "  guru ");
    await user.click(within(dialog).getByRole("button", { name: "Tambah" }));
    await waitFor(() => expect(label).toHaveAttribute("aria-invalid", "true"));
    expect(label).toHaveAccessibleDescription(/sudah ada/);
    expect(writes()[0]?.body).toMatchObject({ label: "guru", active: true, sort_order: 0 });

    await user.clear(label);
    await user.type(label, "Arsitek");
    await user.click(within(dialog).getByRole("button", { name: "Tambah" }));
    expect(await findToast("success", "Arsitek ditambahkan.")).toBeInTheDocument();
    expect(await screen.findByRole("rowheader", { name: "Arsitek" })).toBeInTheDocument();
    dialog = screen.queryByRole("dialog", { name: "Tambah profesi" }) as HTMLElement;
    expect(dialog).toBeNull();
  });

  it("AC F15-4: ubah master yang sudah diubah admin lain → konflik versi, muat ulang ditawarkan", async () => {
    const user = userEvent.setup();
    await openMasters(user);
    await screen.findByText("Menampilkan 11 dari 11");
    await user.click(within(row("Dokter")).getByRole("button", { name: "Ubah Dokter" }));
    const dialog = await screen.findByRole("dialog", { name: "Ubah profesi" });
    const label = await within(dialog).findByRole("textbox", { name: /Label/ });
    expect(label).toHaveValue("Dokter");
    mockMembers.touchMasterByOtherAdmin(professionId("Dokter"), { label: "Dokter Umum" });
    await user.clear(label);
    await user.type(label, "Dokter Spesialis");
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));

    expect(await findToast("error", "sudah diubah admin lain")).toBeInTheDocument();
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("tidak tertimpa");
    expect(within(dialog).getByRole("button", { name: "Simpan" })).toHaveAttribute("aria-disabled", "true");
    await user.click(within(dialog).getByRole("button", { name: "Muat data terbaru" }));
    expect(within(dialog).getByRole("textbox", { name: /Label/ })).toHaveValue("Dokter Umum");
    expect(mockMembers.master(professionId("Dokter"))?.label).toBe("Dokter Umum");
    expect(writes().map((w) => w.ifMatch)).toEqual(["1"]);
  });

  it("AC F15-1: admin tanpa master.manage tidak dapat membuka halaman master", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["members.read"] });
    const user = userEvent.setup();
    renderApp("/members/masters");
    await signIn(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("Akses ditolak");
    expect(
      memberRequests.some((r) => r.path.startsWith("/admin/masters/professions") && r.query.limit === "30"),
    ).toBe(false);
  });

  it("AC F15-1: admin master saja tidak diberi tautan breadcrumb ke daftar anggota", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["master.manage"] });
    const user = userEvent.setup();
    await openMasters(user);
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).queryByRole("link", { name: "Manajemen Users" })).toBeNull();
    expect(await screen.findByRole("table", { name: "Daftar profesi" })).toBeInTheDocument();
  });
});
