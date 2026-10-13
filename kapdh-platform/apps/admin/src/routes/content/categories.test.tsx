import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";
import { mockAuth } from "../../api/mocks/auth";
import { CONTENT_IDS, contentRequests, mockContent } from "../../api/mocks/content";
import { findToast, renderApp, signIn, type User } from "../../test/utils";

// Suite admin berjalan paralel; potongan kode area dan editor dimuat lazy sehingga butuh waktu tunggu lebih.
configure({ asyncUtilTimeout: 5000 });

beforeAll(async () => {
  // Potongan kode area dan editor dimuat lazy; muat lebih dahulu agar waktu transformasi modul saat suite berjalan
  // paralel tidak dihitung sebagai waktu tunggu UI.
  await Promise.all([import("./ContentPages"), import("../../components/ui/RichTextEditorImpl")]);
}, 60_000);

async function openCategories(user: User, extraQuery?: string) {
  const utils = renderApp(`/content?tab=categories${extraQuery ? `&${extraQuery}` : ""}`);
  await signIn(user);
  await screen.findByRole("heading", { level: 1, name: "Manajemen Konten" }, { timeout: 8000 });
  return utils;
}

const rowOf = (table: HTMLElement, name: RegExp) =>
  within(table).getByRole("rowheader", { name }).closest("tr")!;

describe("tab Kategori (guideline p13/p14, F-15; server tiruan)", () => {
  it("kategori berita menampilkan pemakaian; kategori yang dipakai tidak dapat dihapus, hanya dinonaktifkan", async () => {
    const user = userEvent.setup();
    await openCategories(user);
    const table = await screen.findByRole("table", { name: "Kategori Berita" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Label", "Slug", "Urutan", "Status", "Dipakai", "Kelola"]);
    const pengumuman = rowOf(table, /Pengumuman/);
    expect(within(pengumuman).getByText(/^\d+ berita$/)).toBeInTheDocument();
    expect(
      within(pengumuman).getByRole("button", {
        name: /Hapus kategori Pengumuman \(dipakai \d+ berita; nonaktifkan saja\)/,
      }),
    ).toBeDisabled();
    expect(within(rowOf(table, /Arsip Lama/)).getByText("Nonaktif")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "false");
    expect(await screen.findByText("Menampilkan 1 dari 1")).toBeInTheDocument();
    expect(contentRequests.at(-1)).toMatchObject({
      path: "/admin/content/post-categories",
      query: { active: "false", sort: "sort_order_asc" },
    });
  });

  it("menambah kategori berita (slug otomatis bila kosong) lalu menghapusnya setelah konfirmasi", async () => {
    const user = userEvent.setup();
    await openCategories(user);
    const table = await screen.findByRole("table", { name: "Kategori Berita" });
    await user.click(screen.getByRole("button", { name: "Tambah Kategori" }));
    const dialog = await screen.findByRole("dialog", { name: "Tambah kategori berita" });
    const label = within(dialog).getByRole("textbox", { name: /^Label/ });
    await waitFor(() => expect(label).toHaveFocus());
    await user.type(label, "Opini Alumni");
    expect(within(dialog).getByText(/Kosongkan agar dibuat otomatis \(opini-alumni\)/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Tambah kategori" }));
    await findToast("success", 'Kategori "Opini Alumni" ditambahkan.');
    const create = contentRequests.find((r) => r.method === "POST");
    expect(create?.body).toEqual({ label: "Opini Alumni", sort_order: 0, active: true });
    expect(create?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    const row = rowOf(table, /Opini Alumni/);
    expect(within(row).getByText("Belum dipakai")).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Hapus kategori Opini Alumni" }));
    const confirm = await screen.findByRole("alertdialog", { name: /Hapus kategori\?/ });
    await user.click(within(confirm).getByRole("checkbox"));
    await user.click(within(confirm).getByRole("button", { name: "Hapus kategori" }));
    await findToast("success", 'Kategori "Opini Alumni" dihapus.');
    expect(contentRequests.find((r) => r.method === "DELETE")?.ifMatch).toBe("1");
  });

  it("kategori mulai dipakai sebelum dihapus → server menolak (FK RESTRICT) dan alasan ditampilkan", async () => {
    const user = userEvent.setup();
    await openCategories(user);
    const table = await screen.findByRole("table", { name: "Kategori Berita" });
    await user.click(screen.getByRole("button", { name: "Tambah Kategori" }));
    const dialog = await screen.findByRole("dialog", { name: "Tambah kategori berita" });
    await user.type(within(dialog).getByRole("textbox", { name: /^Label/ }), "Liputan");
    await user.click(within(dialog).getByRole("button", { name: "Tambah kategori" }));
    await findToast("success", 'Kategori "Liputan" ditambahkan.');
    const createdId = mockContent.categoryByLabel("post", "Liputan")!.id;

    await user.click(within(rowOf(table, /Liputan/)).getByRole("button", { name: "Hapus kategori Liputan" }));
    // Berita lain mulai memakai kategori ini setelah tabel dimuat (balapan; server menegakkan FK RESTRICT).
    mockContent.useCategory(createdId);
    const confirm = await screen.findByRole("alertdialog", { name: /Hapus kategori\?/ });
    await user.click(within(confirm).getByRole("checkbox"));
    await user.click(within(confirm).getByRole("button", { name: "Hapus kategori" }));
    await findToast(
      "error",
      "Kategori masih dipakai 1 berita. Nonaktifkan kategori agar tidak dipilih lagi.",
    );
    expect(mockContent.category(createdId)).toBeDefined();
    expect(await within(rowOf(table, /Liputan/)).findByText("1 berita")).toBeInTheDocument();
  });

  it("AC F15-4: mengubah kategori yang sudah diubah pengurus lain menampilkan konflik dan muat ulang", async () => {
    const user = userEvent.setup();
    await openCategories(user);
    const table = await screen.findByRole("table", { name: "Kategori Berita" });
    await user.click(within(table).getByRole("button", { name: "Ubah kategori Promo Spesial" }));
    const dialog = await screen.findByRole("dialog", { name: "Ubah kategori berita" });
    expect(within(dialog).getByRole("button", { name: "Simpan perubahan" })).toBeDisabled();
    await user.click(within(dialog).getByRole("switch", { name: "Aktif" }));
    mockContent.editCategoryElsewhere(CONTENT_IDS.categoryPromo);
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));
    const notice = (
      await within(dialog).findByText(/Kategori ini sudah diubah pengurus lain/)
    ).closest<HTMLElement>('[role="alert"]')!;
    expect(contentRequests.find((r) => r.method === "PATCH")).toMatchObject({
      ifMatch: "1",
      body: { active: false },
    });
    expect(mockContent.category(CONTENT_IDS.categoryPromo)?.active).toBe(true);
    await user.click(within(notice).getByRole("button", { name: "Muat ulang versi terbaru" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("textbox", { name: /^Label/ })).toHaveValue("Promo Spesial (diubah)"),
    );
    expect(within(dialog).getByRole("switch", { name: "Aktif" })).toHaveAttribute("aria-checked", "true");
  });

  it("guideline p14: kategori event dikelola di halaman Event dan Tiket, bukan dari tab Kategori konten", async () => {
    const user = userEvent.setup();
    // Parameter lama ?kind=event diabaikan; tab Kategori hanya memuat kategori berita.
    const { router } = await openCategories(user, "kind=event");
    expect(await screen.findByRole("table", { name: "Kategori Berita" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Kategori Event" })).toBeNull();
    expect(contentRequests.some((r) => r.path.startsWith("/admin/content/event-categories"))).toBe(false);
    await user.click(screen.getByRole("link", { name: "Event dan Tiket" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/events"));
  });

  it("AC F15-1: admin konten tanpa events.manage tidak diarahkan ke kategori event", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["content.manage"] });
    const user = userEvent.setup();
    await openCategories(user);
    expect(await screen.findByRole("table", { name: "Kategori Berita" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Event dan Tiket" })).toBeNull();
    expect(screen.queryByText(/Kategori event dikelola/)).toBeNull();
  });

  it("AC F15-1: admin event tanpa content.manage tidak dapat membuka tab Kategori konten", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["events.manage"] });
    const user = userEvent.setup();
    renderApp("/content?tab=categories");
    await signIn(user);
    expect(await screen.findByRole("heading", { level: 1, name: "Akses ditolak" }, { timeout: 8000 })).toBeInTheDocument();
    expect(contentRequests).toHaveLength(0);
  });
});
