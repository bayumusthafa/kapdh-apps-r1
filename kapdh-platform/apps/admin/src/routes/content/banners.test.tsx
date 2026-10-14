import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";
import { mockAuth } from "../../api/mocks/auth";
import { CONTENT_IDS, contentRequests, mockContent } from "../../api/mocks/content";
import { MOCK_EVENT_IDS } from "../../api/mocks/events";
import { findToast, renderApp, signIn, type User } from "../../test/utils";

// Suite admin berjalan paralel; potongan kode area dan editor dimuat lazy sehingga butuh waktu tunggu lebih.
configure({ asyncUtilTimeout: 5000 });

beforeAll(async () => {
  // Potongan kode area dan editor dimuat lazy; muat lebih dahulu agar waktu transformasi modul saat suite berjalan
  // paralel tidak dihitung sebagai waktu tunggu UI.
  await Promise.all([import("./ContentPages"), import("../../components/ui/RichTextEditorImpl")]);
}, 60_000);

/** PNG 1280x720 minimal (header IHDR) untuk unggahan tiruan. */
function pngFile(name = "banner.png"): File {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x05, 0x00, 0,
    0, 0x02, 0xd0, 8, 6, 0, 0, 0,
  ]);
  return new File([bytes], name, { type: "image/png" });
}

async function openBanners(user: User) {
  renderApp("/content?tab=banners");
  await signIn(user);
  return screen.findByRole("table", { name: "Daftar banner" }, { timeout: 8000 });
}

const rowOf = (table: HTMLElement, name: RegExp) =>
  within(table).getByRole("rowheader", { name }).closest("tr")!;

describe("tab Banner (F-08, AC F08-2, F15-4; server tiruan)", () => {
  it("AC F08-2: tabel banner menampilkan kategori tujuan, masa tayang, status tayang dan tujuan yang tidak tersedia", async () => {
    const user = userEvent.setup();
    const table = await openBanners(user);
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Judul", "Gambar", "Kategori", "Tgl Publikasi", "Status", "Urutan", "Kelola"]);
    const arsip = rowOf(table, /Beasiswa 2025/);
    expect(within(arsip).getByText("Tujuan tidak tersedia")).toBeInTheDocument();
    expect(within(arsip).getByText("Berita: Pendaftaran beasiswa 2025")).toBeInTheDocument();
    expect(within(arsip).getByText("Arsip Lama")).toBeInTheDocument();
    expect(within(arsip).getByText("Tayang")).toBeInTheDocument();
    expect(within(rowOf(table, /Reuni Akbar/)).getByText("Terjadwal")).toBeInTheDocument();
    expect(within(rowOf(table, /Reuni Akbar/)).getByText("Reuni")).toBeInTheDocument();
    expect(within(rowOf(table, /Situs resmi KAPDH/)).getByText("Berakhir")).toBeInTheDocument();
    expect(
      within(rowOf(table, /Situs resmi KAPDH/)).getByText("1 Jan 2026 - 1 Feb 2026"),
    ).toBeInTheDocument();
    expect(within(rowOf(table, /Pusat bantuan/)).getByText("Nonaktif")).toBeInTheDocument();
    expect(within(rowOf(table, /Donasi korban bencana/)).queryByText("Tujuan tidak tersedia")).toBeNull();

    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "ended");
    expect(await screen.findByText("Menampilkan 1 dari 1")).toBeInTheDocument();
    expect(contentRequests.at(-1)?.query).toMatchObject({ state: "ended", sort: "sort_order_asc" });
  });

  it("membuat banner: validasi klien (gambar, tautan https, mulai tayang) lalu POST dengan Idempotency-Key", async () => {
    const user = userEvent.setup();
    const table = await openBanners(user);
    await user.click(screen.getByRole("button", { name: "Buat Banner" }));
    const dialog = await screen.findByRole("dialog", { name: "Buat banner" });
    expect(within(dialog).getByRole("textbox", { name: /^Judul banner/ })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Buat banner" }));
    expect(await within(dialog).findByText("Judul wajib diisi.")).toBeInTheDocument();
    expect(within(dialog).getByText("Gambar banner wajib diunggah.")).toBeInTheDocument();
    expect(within(dialog).getByText("Tanggal mulai tayang wajib diisi.")).toBeInTheDocument();
    expect(contentRequests.some((r) => r.method === "POST" && r.path === "/admin/content/banners")).toBe(
      false,
    );

    await user.type(within(dialog).getByRole("textbox", { name: /^Judul banner/ }), "Iuran 2027");
    await user.upload(within(dialog).getByTestId("content-image-input-banner_image"), pngFile());
    expect(await within(dialog).findByRole("img", { name: "Gambar banner Iuran 2027" })).toBeInTheDocument();
    const media = contentRequests.find((r) => r.path === "/admin/content/media");
    expect(media?.method).toBe("POST");

    await user.click(within(dialog).getByRole("radio", { name: "Tautan luar" }));
    const url = within(dialog).getByRole("textbox", { name: /^Tautan luar/ });
    await user.type(url, "http://contoh.id");
    fireEvent.change(within(dialog).getByLabelText(/^Mulai tayang/), {
      target: { value: "2026-11-01T07:00" },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Selesai tayang/), {
      target: { value: "2026-10-01T07:00" },
    });
    await user.click(within(dialog).getByRole("button", { name: "Buat banner" }));
    expect(await within(dialog).findByText("Tautan luar harus diawali https://.")).toBeInTheDocument();
    expect(within(dialog).getByText("Selesai tayang harus setelah mulai tayang.")).toBeInTheDocument();

    await user.clear(url);
    await user.type(url, "https://kapdh.or.id/iuran");
    fireEvent.change(within(dialog).getByLabelText(/^Selesai tayang/), { target: { value: "" } });
    const order = within(dialog).getByRole("textbox", { name: /^Urutan tampil/ });
    await user.clear(order);
    await user.type(order, "5");
    await user.click(within(dialog).getByRole("button", { name: "Buat banner" }));

    await findToast("success", 'Banner "Iuran 2027" dibuat.');
    const create = contentRequests.find((r) => r.method === "POST" && r.path === "/admin/content/banners");
    expect(create?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(create?.body).toEqual({
      title: "Iuran 2027",
      image_file_id: expect.stringMatching(/^0199e100-/),
      target_type: "url",
      target_value: "https://kapdh.or.id/iuran",
      sort_order: 5,
      // 07.00 WIB = 00.00 UTC (ARCHITECTURE §2.6).
      starts_at: "2026-11-01T00:00:00.000Z",
      ends_at: null,
      active: true,
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Buat banner" })).toBeNull());
    expect(await within(table).findByRole("rowheader", { name: /Iuran 2027/ })).toBeInTheDocument();
  });

  it("AC F08-2: mengganti tujuan ke berita lewat pencarian mengirim jenis dan nilai tujuan berpasangan dengan If-Match", async () => {
    const user = userEvent.setup();
    const table = await openBanners(user);
    await user.click(within(table).getByRole("button", { name: "Ubah banner Pusat bantuan" }));
    const dialog = await screen.findByRole("dialog", { name: "Ubah banner" });
    expect(within(dialog).getByRole("radio", { name: "Halaman" })).toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Simpan perubahan" })).toBeDisabled();

    await user.click(within(dialog).getByRole("radio", { name: "Berita" }));
    await user.type(within(dialog).getByRole("combobox", { name: /^Berita tujuan/ }), "Halal");
    await user.click(await screen.findByRole("option", { name: /Halal bi Halal/ }));
    await user.click(within(dialog).getByRole("switch", { name: "Aktif" }));
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));

    await findToast("success", 'Banner "Pusat bantuan" diperbarui.');
    const patch = contentRequests.find((r) => r.method === "PATCH");
    expect(patch?.ifMatch).toBe("1");
    expect(patch?.body).toEqual({
      target_type: "post",
      target_value: CONTENT_IDS.postHalalBiHalal,
      active: true,
    });
    expect(mockContent.banner(CONTENT_IDS.bannerBantuan)?.target).toMatchObject({
      type: "post",
      label: "Halal bi Halal",
      category: { label: "Promo Spesial" },
    });
  });

  it("AC F08-2: event dipilih dari daftar event admin (area events) tersimpan sebagai tujuan banner yang tersedia", async () => {
    // Integrasi Fase C: pencarian memakai GET /admin/events milik area events, sehingga tujuan yang dipilih harus
    // dikenali server tiruan konten saat validasi dan saat menampilkan tujuan (satu sumber event di dev:mock).
    const user = userEvent.setup();
    const table = await openBanners(user);
    await user.click(within(table).getByRole("button", { name: "Ubah banner Pusat bantuan" }));
    const dialog = await screen.findByRole("dialog", { name: "Ubah banner" });
    await user.click(within(dialog).getByRole("radio", { name: "Event" }));
    await user.type(within(dialog).getByRole("combobox", { name: /^Event tujuan/ }), "Seminar AI");
    await user.click(await screen.findByRole("option", { name: /Seminar AI untuk Alumni/ }));
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));

    await findToast("success", 'Banner "Pusat bantuan" diperbarui.');
    expect(contentRequests.find((r) => r.method === "PATCH")?.body).toEqual({
      target_type: "event",
      target_value: MOCK_EVENT_IDS.seminar,
    });
    expect(mockContent.banner(CONTENT_IDS.bannerBantuan)?.target).toMatchObject({
      type: "event",
      value: MOCK_EVENT_IDS.seminar,
      available: true,
      label: "Seminar AI untuk Alumni",
      route: `/events/${MOCK_EVENT_IDS.seminar}`,
    });
  });

  it("AC F15-4: banner diubah pengurus lain → konflik dengan tombol muat ulang, bukan menimpa", async () => {
    const user = userEvent.setup();
    const table = await openBanners(user);
    await user.click(within(table).getByRole("button", { name: "Ubah banner Donasi korban bencana" }));
    const dialog = await screen.findByRole("dialog", { name: "Ubah banner" });
    const order = within(dialog).getByRole("textbox", { name: /^Urutan tampil/ });
    await user.clear(order);
    await user.type(order, "9");
    mockContent.editBannerElsewhere(CONTENT_IDS.bannerDonasi);
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));

    const notice = (
      await within(dialog).findByText(/Banner ini sudah diubah pengurus lain/)
    ).closest<HTMLElement>('[role="alert"]')!;
    expect(within(dialog).getByRole("button", { name: "Simpan perubahan" })).toBeDisabled();
    expect(mockContent.banner(CONTENT_IDS.bannerDonasi)?.sort_order).toBe(0);
    await user.click(within(notice).getByRole("button", { name: "Muat ulang versi terbaru" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("textbox", { name: /^Judul banner/ })).toHaveValue(
        "Donasi korban bencana (diubah)",
      ),
    );
    expect(order).toHaveValue("0");
  });

  it("AC F08-2: dialog ubah banner menjelaskan tujuan tersimpan yang tidak tersedia, juga berita yang sudah dihapus", async () => {
    mockContent.deletePost(CONTENT_IDS.postDonasi);
    const user = userEvent.setup();
    const table = await openBanners(user);

    await user.click(within(table).getByRole("button", { name: "Ubah banner Beasiswa 2025" }));
    let dialog = await screen.findByRole("dialog", { name: "Ubah banner" });
    expect(within(dialog).getByRole("combobox", { name: /^Berita tujuan/ })).toHaveValue(
      "Pendaftaran beasiswa 2025",
    );
    expect(within(dialog).getByText("Tujuan tidak tersedia")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Berita tujuan belum terbit, sudah diarsipkan atau sudah dihapus\./),
    ).toHaveTextContent(/Pilih tujuan lain atau nonaktifkan banner\./);
    await user.click(within(dialog).getByRole("button", { name: "Batal" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Ubah banner" })).toBeNull());

    // Berita tujuan sudah dihapus: pemilih tidak menampilkan ID mentah sebagai pilihan yang sah.
    await user.click(within(table).getByRole("button", { name: "Ubah banner Donasi korban bencana" }));
    dialog = await screen.findByRole("dialog", { name: "Ubah banner" });
    const picker = within(dialog).getByRole("combobox", { name: /^Berita tujuan/ });
    expect(picker).toHaveValue("(tujuan tidak ditemukan)");
    expect(within(dialog).queryByDisplayValue(CONTENT_IDS.postDonasi)).toBeNull();
    expect(within(dialog).getByText("Tujuan tidak tersedia")).toBeInTheDocument();

    // Memilih tujuan lain menghilangkan peringatan.
    await user.clear(picker);
    await user.type(picker, "Halal");
    await user.click(await screen.findByRole("option", { name: /Halal bi Halal/ }));
    expect(within(dialog).queryByText("Tujuan tidak tersedia")).toBeNull();
  });

  it("PRD 4.5: simpan banner ditahan selama gambar baru diunggah; gambar baru ikut tersimpan", async () => {
    const user = userEvent.setup();
    const table = await openBanners(user);
    await user.click(within(table).getByRole("button", { name: "Ubah banner Donasi korban bencana" }));
    const dialog = await screen.findByRole("dialog", { name: "Ubah banner" });
    const order = within(dialog).getByRole("textbox", { name: /^Urutan tampil/ });
    await user.clear(order);
    await user.type(order, "3");

    const release = mockContent.holdUploads();
    await user.upload(within(dialog).getByTestId("content-image-input-banner_image"), pngFile("baru.png"));
    const save = within(dialog).getByRole("button", { name: "Simpan perubahan" });
    await waitFor(() => expect(save).toBeDisabled());
    expect(save).toHaveAccessibleDescription("Tunggu unggahan gambar selesai sebelum menyimpan.");
    await user.type(order, "{Enter}");
    expect(contentRequests.some((r) => r.method === "PATCH")).toBe(false);

    release();
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await findToast("success", 'Banner "Donasi korban bencana" diperbarui.');
    expect(contentRequests.find((r) => r.method === "PATCH")?.body).toEqual({
      image_file_id: expect.stringMatching(/^0199e100-0000-7000-9000-/),
      sort_order: 3,
    });
  });

  it("tanpa izin events.manage: tujuan event diisi ID event yang divalidasi", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["content.manage"] });
    const user = userEvent.setup();
    const table = await openBanners(user);
    await user.click(within(table).getByRole("button", { name: "Ubah banner Donasi korban bencana" }));
    const dialog = await screen.findByRole("dialog", { name: "Ubah banner" });
    await user.click(within(dialog).getByRole("radio", { name: "Event" }));
    const id = within(dialog).getByRole("textbox", { name: /^ID event tujuan/ });
    expect(id).toHaveAccessibleDescription(/memerlukan izin events\.manage/);
    await user.type(id, "bukan-id");
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));
    expect(await within(dialog).findByText("ID event tidak valid.")).toBeInTheDocument();
    await user.clear(id);
    await user.type(id, CONTENT_IDS.eventReuni);
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));
    await findToast("success", 'Banner "Donasi korban bencana" diperbarui.');
    expect(mockContent.banner(CONTENT_IDS.bannerDonasi)?.target).toMatchObject({
      type: "event",
      value: CONTENT_IDS.eventReuni,
      available: true,
    });
  });

  it("hapus banner dengan konfirmasi dua langkah dan If-Match", async () => {
    const user = userEvent.setup();
    const table = await openBanners(user);
    await user.click(within(table).getByRole("button", { name: "Hapus banner Situs resmi KAPDH" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Hapus banner\?/ });
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: "Hapus banner" }));
    await findToast("success", 'Banner "Situs resmi KAPDH" dihapus.');
    expect(contentRequests.find((r) => r.method === "DELETE")).toMatchObject({
      path: `/admin/content/banners/${CONTENT_IDS.bannerSitus}`,
      ifMatch: "1",
    });
    await waitFor(() =>
      expect(within(table).queryByRole("rowheader", { name: /Situs resmi KAPDH/ })).toBeNull(),
    );
  });
});
