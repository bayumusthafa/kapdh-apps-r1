import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CONTENT_IDS, contentRequests, mockContent } from "../../api/mocks/content";
import { findToast, renderApp, signIn, type User } from "../../test/utils";

/** Server tiruan src/api/mocks/content.ts; bukti mock bukan bukti AC (PRD 7.3). */
async function openContent(user: User, path = "/content") {
  const utils = renderApp(path);
  await signIn(user);
  await screen.findByRole("heading", { level: 1, name: "Manajemen Konten" });
  return utils;
}

const postListRequests = () =>
  contentRequests.filter((r) => r.method === "GET" && r.path === "/admin/content/posts");

describe("tab Berita (F-08, F-15, guideline p13; server tiruan)", () => {
  it("AC F08-1: tabel berita memakai kolom guideline p13, status turunan server dan paging kursor", async () => {
    const user = userEvent.setup();
    await openContent(user);
    const table = await screen.findByRole("table", { name: "Daftar berita" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(["Judul Konten", "Gambar", "Kategori", "Status", "Tgl Publikasi", "Kelola"]);
    expect(await screen.findByText("Menampilkan 20 dari 25")).toBeInTheDocument();
    // Draf, terjadwal, terbit dan arsip dibedakan dengan label teks (bukan warna saja, PRD 4.5).
    const row = (name: RegExp) => within(table).getByRole("rowheader", { name }).closest("tr")!;
    expect(within(row(/Rapat pengurus Oktober/)).getByText("Draf")).toBeInTheDocument();
    expect(within(row(/Reuni Akbar 2026/)).getByText("Terjadwal")).toBeInTheDocument();
    expect(within(row(/Reuni Akbar 2026/)).getByText(/WIB$/)).toBeInTheDocument();
    expect(postListRequests()[0]?.query).toMatchObject({ sort: "updated_at_desc", limit: "20" });

    await user.click(screen.getByRole("button", { name: "Halaman berikutnya" }));
    expect(await screen.findByText("Menampilkan 21–25 dari 25")).toBeInTheDocument();
    expect(postListRequests().at(-1)?.query.cursor).toBeTruthy();
    expect(within(row(/Pendaftaran beasiswa 2025/)).getByText("Diarsipkan")).toBeInTheDocument();
  });

  it("AC F08-1: filter status Terjadwal dan pencarian ber-debounce dikirim ke server", async () => {
    const user = userEvent.setup();
    await openContent(user);
    await screen.findByText("Menampilkan 20 dari 25");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "scheduled");
    expect(await screen.findByText("Menampilkan 1 dari 1")).toBeInTheDocument();
    expect(postListRequests().at(-1)?.query).toMatchObject({ state: "scheduled" });

    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "all");
    await screen.findByText("Menampilkan 20 dari 25");
    const before = postListRequests().length;
    await user.type(screen.getByRole("searchbox", { name: "Cari berita" }), "donasi");
    await screen.findByText("Menampilkan 1 dari 1");
    expect(
      postListRequests()
        .slice(before)
        .map((r) => r.query.q),
    ).toEqual(["donasi"]);
  });

  it("hapus hanya untuk draf/arsip: konfirmasi dua langkah lalu DELETE dengan If-Match versi yang dilihat", async () => {
    const user = userEvent.setup();
    await openContent(user);
    const table = await screen.findByRole("table", { name: "Daftar berita" });
    // Berita yang tampil harus diarsipkan dahulu (kontrak adminDeletePost).
    expect(within(table).getByRole("button", { name: /Hapus Donasi korban bencana \(arsipkan dahulu/ })).toBeDisabled();

    await user.click(within(table).getByRole("button", { name: "Hapus Rapat pengurus Oktober" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Hapus berita\?/ });
    const confirm = within(dialog).getByRole("button", { name: "Hapus berita" });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: /tidak dapat dikembalikan/ }));
    await user.click(confirm);
    await findToast("success", 'Berita "Rapat pengurus Oktober" dihapus.');
    const del = contentRequests.find((r) => r.method === "DELETE");
    expect(del).toMatchObject({ path: `/admin/content/posts/${CONTENT_IDS.postDraft}`, ifMatch: "1" });
    expect(mockContent.post(CONTENT_IDS.postDraft)).toBeUndefined();
    await waitFor(() =>
      expect(within(table).queryByRole("rowheader", { name: /Rapat pengurus Oktober/ })).toBeNull(),
    );
  });

  it("AC F15-4: hapus dari tabel lama setelah berita diubah pengurus lain → konflik, tabel dimuat ulang, tidak dihapus", async () => {
    const user = userEvent.setup();
    await openContent(user);
    const table = await screen.findByRole("table", { name: "Daftar berita" });
    mockContent.editPostElsewhere(CONTENT_IDS.postDraft);
    await user.click(within(table).getByRole("button", { name: "Hapus Rapat pengurus Oktober" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Hapus berita\?/ });
    await user.click(within(dialog).getByRole("checkbox", { name: /tidak dapat dikembalikan/ }));
    await user.click(within(dialog).getByRole("button", { name: "Hapus berita" }));
    await findToast("error", "Data sudah diubah pengurus lain");
    expect(mockContent.post(CONTENT_IDS.postDraft)).toBeDefined();
    expect(await within(table).findByRole("rowheader", { name: /Judul diubah pengurus lain/ })).toBeInTheDocument();
  });

  it("tombol Manajemen Kategori membuka tab Kategori berita; Buat Konten Baru membuka editor", async () => {
    const user = userEvent.setup();
    const { router } = await openContent(user);
    await screen.findByRole("table", { name: "Daftar berita" });
    await user.click(screen.getByRole("button", { name: "Manajemen Kategori" }));
    expect(await screen.findByRole("table", { name: "Kategori Berita" })).toBeInTheDocument();
    expect(router.state.location.search).toMatchObject({ tab: "categories", kind: "post" });
    expect(screen.getByRole("tab", { name: "Kategori" })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("tab", { name: "Berita" }));
    await user.click(await screen.findByRole("link", { name: "Buat Konten Baru" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Tambah Konten Baru" })).toBeInTheDocument();
  });
});
