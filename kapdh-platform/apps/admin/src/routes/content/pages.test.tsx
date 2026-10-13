import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";
import { CONTENT_IDS, contentRequests, mockContent } from "../../api/mocks/content";
import { findToast, renderApp, signIn, type User } from "../../test/utils";

// Suite admin berjalan paralel; potongan kode area dan editor dimuat lazy sehingga butuh waktu tunggu lebih.
configure({ asyncUtilTimeout: 5000 });

beforeAll(async () => {
  // Potongan kode area dan editor dimuat lazy; muat lebih dahulu agar waktu transformasi modul saat suite berjalan
  // paralel tidak dihitung sebagai waktu tunggu UI.
  await Promise.all([import("./ContentPages"), import("../../components/ui/RichTextEditorImpl")]);
}, 60_000);

const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);

async function openPages(user: User, page?: string) {
  const utils = renderApp(`/content?tab=pages${page ? `&page=${page}` : ""}`);
  await signIn(user);
  const table = await screen.findByRole("table", { name: "Daftar halaman" }, { timeout: 8000 });
  return { ...utils, table };
}

const rowOf = (table: HTMLElement, name: RegExp) =>
  within(table).getByRole("rowheader", { name }).closest("tr")!;

describe("tab Halaman (F-08, F-01, PRD 6.2; server tiruan)", () => {
  it("tabel menampilkan halaman baku lebih dahulu, versi tayang dan status draf; halaman baku tidak dapat dihapus", async () => {
    const user = userEvent.setup();
    const { table } = await openPages(user);
    const titles = within(table)
      .getAllByRole("rowheader")
      .map((h) => h.textContent);
    expect(titles[0]).toMatch(/^Kebijakan Privasi/);
    expect(titles.at(-1)).toMatch(/^Panduan Iuran/);
    const privasi = rowOf(table, /Kebijakan Privasi/);
    expect(within(privasi).getByText("Legal: Kebijakan privasi")).toBeInTheDocument();
    expect(within(privasi).getByText("Halaman baku")).toBeInTheDocument();
    expect(within(privasi).getByText(/^Versi 2/)).toBeInTheDocument();
    expect(within(privasi).getByText("Ada perubahan belum terbit")).toBeInTheDocument();
    expect(
      within(rowOf(table, /Ketentuan Layanan/)).getByText("Sama dengan versi tayang"),
    ).toBeInTheDocument();
    expect(within(rowOf(table, /Panduan Iuran/)).getByText("Belum terbit")).toBeInTheDocument();
    expect(
      within(privasi).getByRole("button", { name: /Hapus halaman Kebijakan Privasi \(halaman baku/ }),
    ).toBeDisabled();
  });

  it("F-01: menerbitkan dokumen legal menampilkan versi tayang terpisah dari draf dan konfirmasi akibat versi legal", async () => {
    const user = userEvent.setup();
    const { table, router } = await openPages(user);
    await user.click(within(table).getByRole("button", { name: /^Kebijakan Privasi/ }));
    expect(router.state.location.search).toMatchObject({ tab: "pages", page: CONTENT_IDS.pagePrivasi });
    const editor = await screen.findByRole("region", { name: "Kebijakan Privasi" });
    await waitFor(() =>
      expect(within(editor).getByRole("heading", { name: "Kebijakan Privasi" })).toHaveFocus(),
    );

    const published = within(editor).getByRole("region", { name: "Versi tayang" });
    expect(within(published).getByText("Versi 2")).toBeInTheDocument();
    expect(within(published).getByText("Kebijakan privasi KAPDH.")).toBeInTheDocument();
    const draft = within(editor).getByRole("region", { name: "Draf kerja" });
    expect(
      await within(draft).findByText(/penambahan retensi cadangan/, undefined, { timeout: 8000 }),
    ).toBeInTheDocument();
    expect(within(draft).getByRole("textbox", { name: /^Slug/ })).toHaveAttribute("readonly");

    await user.click(within(draft).getByRole("button", { name: "Terbitkan versi baru" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: /Terbitkan versi baru "Kebijakan Privasi"\?/,
    });
    expect(dialog).toHaveTextContent("naik dari versi 2 menjadi versi 3");
    expect(dialog).toHaveTextContent("Registrasi berikutnya menyetujui pasangan versi");
    expect(dialog).toHaveTextContent("dicatat di audit");
    const confirm = within(dialog).getByRole("button", { name: "Terbitkan versi 3" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox", { name: /^Catatan perubahan/ }), "Retensi cadangan");
    await user.click(within(dialog).getByRole("checkbox", { name: /versi legal naik/ }));
    await user.click(confirm);

    await findToast("success", 'Versi 3 "Kebijakan Privasi" diterbitkan.');
    const publish = contentRequests.find((r) => r.path.endsWith("/publish"));
    expect(publish).toMatchObject({ ifMatch: "5", body: { change_note: "Retensi cadangan" } });
    expect(publish?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(await within(published).findByText("Versi 3")).toBeInTheDocument();
    expect(within(draft).getByRole("button", { name: "Terbitkan versi baru" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(mockContent.page(CONTENT_IDS.pagePrivasi)?.published_version).toBe("3");
  });

  it("simpan draf tidak mengubah versi tayang; terbit hanya setelah draf tersimpan berbeda", async () => {
    const user = userEvent.setup();
    await openPages(user, CONTENT_IDS.pageKetentuan);
    const editor = await screen.findByRole("region", { name: "Ketentuan Layanan" });
    const draft = within(editor).getByRole("region", { name: "Draf kerja" });
    const publish = within(draft).getByRole("button", { name: "Terbitkan versi baru" });
    expect(publish).toHaveAttribute("aria-disabled", "true");
    expect(within(draft).getByText("Tidak ada perubahan untuk diterbitkan.")).toBeInTheDocument();

    const title = within(draft).getByRole("textbox", { name: /^Judul/ });
    await user.clear(title);
    await user.type(title, "Ketentuan Layanan KAPDH");
    expect(within(draft).getByText(/Simpan draf terlebih dahulu/)).toBeInTheDocument();
    await user.click(within(draft).getByRole("button", { name: "Simpan draf" }));
    await findToast("success", "Draf halaman disimpan. Teks tayang belum berubah sampai diterbitkan.");
    expect(contentRequests.find((r) => r.method === "PATCH")).toMatchObject({
      ifMatch: "2",
      body: { title: "Ketentuan Layanan KAPDH" },
    });
    expect(mockContent.page(CONTENT_IDS.pageKetentuan)).toMatchObject({
      published_version: "1",
      has_unpublished_changes: true,
    });
    await waitFor(() => expect(publish).not.toHaveAttribute("aria-disabled"));
  });

  it("AC F15-4: draf halaman diubah pengurus lain → konflik dan muat ulang tanpa menimpa", async () => {
    const user = userEvent.setup();
    await openPages(user, CONTENT_IDS.pageBantuan);
    const editor = await screen.findByRole("region", { name: "Bantuan" });
    const title = within(editor).getByRole("textbox", { name: /^Judul/ });
    await user.type(title, " Anggota");
    mockContent.editPageElsewhere(CONTENT_IDS.pageBantuan, "<p>Hubungi bantuan lewat WhatsApp.</p>");
    await user.click(within(editor).getByRole("button", { name: "Simpan draf" }));
    const notice = (
      await within(editor).findByText(/Halaman ini sudah diubah pengurus lain/)
    ).closest<HTMLElement>('[role="alert"]')!;
    expect(title).toHaveValue("Bantuan Anggota");
    expect(mockContent.page(CONTENT_IDS.pageBantuan)?.title).toBe("Bantuan");
    await user.click(within(notice).getByRole("button", { name: "Muat ulang versi terbaru" }));
    await waitFor(() => expect(title).toHaveValue("Bantuan"));
    expect(
      await within(editor).findByText("Hubungi bantuan lewat WhatsApp.", undefined, { timeout: 8000 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(title).toHaveFocus());
  });

  it("membuat halaman informasi baru sebagai draf lalu membuka editornya; halaman non-baku dapat dihapus", async () => {
    const user = userEvent.setup();
    const { table } = await openPages(user);
    await user.click(screen.getByRole("button", { name: "Buat Halaman" }));
    const dialog = await screen.findByRole("dialog", { name: "Buat halaman informasi" });
    await user.type(within(dialog).getByRole("textbox", { name: /^Judul/ }), "Kontak Pengurus");
    await user.type(within(dialog).getByRole("textbox", { name: /^Slug/ }), "Kontak Pengurus");
    const body = await within(dialog).findByRole("textbox", { name: /^Isi halaman/ }, { timeout: 8000 });
    body.focus();
    await user.paste("Hubungi sekretariat.");
    await user.click(within(dialog).getByRole("button", { name: "Simpan draf" }));
    const slug = within(dialog).getByRole("textbox", { name: /^Slug/ });
    await waitFor(() => expect(slug).toHaveAttribute("aria-invalid", "true"));
    expect(contentRequests.some((r) => r.method === "POST")).toBe(false);
    await user.clear(slug);
    await user.type(slug, "kontak-pengurus");
    await user.click(within(dialog).getByRole("button", { name: "Simpan draf" }));
    await findToast("success", 'Halaman "Kontak Pengurus" dibuat sebagai draf.');
    expect(contentRequests.find((r) => r.method === "POST")?.body).toMatchObject({
      slug: "kontak-pengurus",
      title: "Kontak Pengurus",
    });
    expect(await screen.findByRole("region", { name: "Kontak Pengurus" })).toBeInTheDocument();
    expect(screen.getByText(/Belum pernah terbit; halaman belum dapat dibaca publik/)).toBeInTheDocument();

    const row = await within(table).findByRole("rowheader", { name: /Kontak Pengurus/ });
    await user.click(
      within(row.closest("tr")!).getByRole("button", { name: "Hapus halaman Kontak Pengurus" }),
    );
    const confirm = await screen.findByRole("alertdialog", { name: /Hapus halaman\?/ });
    await user.click(within(confirm).getByRole("checkbox"));
    await user.click(within(confirm).getByRole("button", { name: "Hapus halaman" }));
    await findToast("success", 'Halaman "Kontak Pengurus" dihapus.');
    expect(await screen.findByText("Pilih halaman")).toBeInTheDocument();
  });
});
