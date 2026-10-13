import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
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

// jsdom tidak mengimplementasikan geometri Range; ProseMirror memakainya untuk menggulir ke kursor.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);

async function openEditor(user: User, postId: string) {
  const utils = renderApp(`/content/posts/${postId}`);
  await signIn(user);
  await screen.findByRole("heading", { level: 1, name: "Edit Konten" }, { timeout: 8000 });
  await screen.findByRole("textbox", { name: /^Judul konten/ }, { timeout: 8000 });
  return utils;
}

/** PNG 1280x720 minimal (header IHDR) untuk unggahan tiruan. */
function pngFile(name = "cover.png"): File {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x05, 0x00, 0,
    0, 0x02, 0xd0, 8, 6, 0, 0, 0,
  ]);
  return new File([bytes], name, { type: "image/png" });
}

const panel = () => screen.getByRole("region", { name: "Status & Penerbitan" });
const lastRequest = (method: string, suffix: string) =>
  contentRequests.filter((r) => r.method === method && r.path.endsWith(suffix)).at(-1);

async function confirmIn(user: User, name: RegExp, button: string, acknowledge = false) {
  const dialog = await screen.findByRole("alertdialog", { name });
  if (acknowledge) await user.click(within(dialog).getByRole("checkbox"));
  await user.click(within(dialog).getByRole("button", { name: button }));
}

describe("editor berita (F-08, AC F08-1, F15-4, F15-5; server tiruan)", () => {
  it("membuat draf baru dengan Idempotency-Key lalu menerbitkannya sekarang setelah konfirmasi", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/content/posts/new");
    await signIn(user);
    await screen.findByRole("heading", { level: 1, name: "Tambah Konten Baru" }, { timeout: 8000 });
    // Penerbitan baru tersedia setelah draf tersimpan.
    expect(screen.getByText(/Simpan draf terlebih dahulu untuk menerbitkan/)).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: /^Judul konten/ }), "Silaturahmi Akbar 2026");
    expect(screen.getByRole("textbox", { name: /^Slug tautan/ })).toHaveAttribute(
      "placeholder",
      "silaturahmi-akbar-2026",
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Kategori" }), "Kegiatan Alumni");
    const editor = await screen.findByRole("textbox", { name: /^Isi berita/ }, { timeout: 8000 });
    // Mengetik per karakter ke ProseMirror tidak andal di jsdom; tempel teks memakai jalur paste editor.
    editor.focus();
    await user.paste("Seluruh alumni diundang hadir.");
    await waitFor(() => expect(editor).toHaveTextContent("Seluruh alumni diundang hadir."));

    await user.click(screen.getByRole("button", { name: "Simpan draf" }));
    await findToast("success", "Draf berita disimpan.");
    const create = lastRequest("POST", "/admin/content/posts");
    expect(create?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(create?.body).toMatchObject({
      title: "Silaturahmi Akbar 2026",
      excerpt: null,
      cover_file_id: null,
      category_id: CONTENT_IDS.categoryKegiatan,
    });
    expect(create?.body).not.toHaveProperty("slug");
    expect(String(create?.body?.body_html)).toContain("Seluruh alumni diundang hadir.");

    expect(await screen.findByRole("heading", { level: 1, name: "Edit Konten" })).toBeInTheDocument();
    expect(router.state.location.pathname).toMatch(/^\/content\/posts\/0199e100-/);
    await user.click(within(panel()).getByRole("button", { name: "Terbitkan sekarang" }));
    await confirmIn(user, /Terbitkan berita sekarang\?/, "Terbitkan sekarang");
    await findToast("success", "Berita diterbitkan dan tampil di aplikasi.");
    const publish = lastRequest("POST", "/publish");
    expect(publish?.body).toEqual({ published_at: null });
    expect(publish?.ifMatch).toBe("1");
    expect(publish?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(within(panel()).getByText("Terbit")).toBeInTheDocument();
    // Berita yang sudah tampil: slug terkunci agar tautan /news/<slug> tetap berlaku.
    expect(screen.getByRole("textbox", { name: /^Slug tautan/ })).toHaveAttribute("readonly");
  });

  it("AC F08-1: jadwalkan terbit dengan jam dinding WIB; waktu lampau ditolak sebelum dikirim", async () => {
    const user = userEvent.setup();
    await openEditor(user, CONTENT_IDS.postDraft);
    await user.click(within(panel()).getByRole("radio", { name: /Jadwalkan/ }));
    const when = within(panel()).getByLabelText(/^Tanggal & jam terbit/);

    fireEvent.change(when, { target: { value: "2020-01-01T08:00" } });
    await user.click(within(panel()).getByRole("button", { name: "Jadwalkan terbit" }));
    expect(await within(panel()).findByText(/Waktu terbit harus di masa depan/)).toBeInTheDocument();
    expect(contentRequests.some((r) => r.path.endsWith("/publish"))).toBe(false);

    fireEvent.change(when, { target: { value: "2030-01-15T09:30" } });
    await user.click(within(panel()).getByRole("button", { name: "Jadwalkan terbit" }));
    await confirmIn(user, /Jadwalkan berita\?/, "Jadwalkan terbit");
    await findToast("success", "Berita dijadwalkan terbit 15 Jan 2030, 09.30 WIB.");
    // 09.30 WIB = 02.30 UTC (ARCHITECTURE §2.6).
    expect(lastRequest("POST", "/publish")?.body).toEqual({ published_at: "2030-01-15T02:30:00.000Z" });
    expect(within(panel()).getByText("Terjadwal")).toBeInTheDocument();
    expect(mockContent.post(CONTENT_IDS.postDraft)?.state).toBe("scheduled");
  });

  it("AC F15-5: berita terjadwal dapat dibatalkan jadwalnya, lalu diarsipkan dan dipulihkan tanpa hidup kembali", async () => {
    const user = userEvent.setup();
    await openEditor(user, CONTENT_IDS.postScheduled);
    expect(within(panel()).getByText(/akan terbit otomatis pada/)).toBeInTheDocument();

    await user.click(within(panel()).getByRole("button", { name: "Batalkan jadwal" }));
    await confirmIn(user, /Batalkan jadwal terbit\?/, "Batalkan jadwal");
    await findToast("success", "Jadwal dibatalkan; berita kembali menjadi draf.");
    expect(lastRequest("POST", "/unschedule")?.ifMatch).toBe("1");
    expect(mockContent.post(CONTENT_IDS.postScheduled)).toMatchObject({ state: "draft", published_at: null });

    await user.click(await within(panel()).findByRole("button", { name: "Arsipkan" }));
    await confirmIn(user, /Arsipkan berita\?/, "Arsipkan berita", true);
    await findToast("success", "Berita diarsipkan dan tidak tampil di aplikasi.");
    expect(within(panel()).getByText(/tidak akan diterbitkan lagi oleh jadwal lama/)).toBeInTheDocument();

    await user.click(within(panel()).getByRole("button", { name: "Pulihkan ke draf" }));
    await confirmIn(user, /Pulihkan ke draf\?/, "Pulihkan ke draf");
    await findToast("success", "Berita dipulihkan sebagai draf.");
    expect(mockContent.post(CONTENT_IDS.postScheduled)?.state).toBe("draft");
  });

  it("draf hasil restore yang pernah tampil hanya dapat diterbitkan ulang sekarang dengan tanggal aslinya", async () => {
    const user = userEvent.setup();
    await openEditor(user, CONTENT_IDS.postRestored);
    expect(within(panel()).queryByRole("radio", { name: /Jadwalkan/ })).toBeNull();
    expect(screen.getByRole("textbox", { name: /^Slug tautan/ })).toHaveAttribute("readonly");
    await user.click(within(panel()).getByRole("button", { name: "Terbitkan ulang sekarang" }));
    await confirmIn(user, /Terbitkan ulang berita\?/, "Terbitkan ulang");
    await findToast("success", "Berita tampil kembali dengan tanggal publikasi aslinya.");
    expect(mockContent.post(CONTENT_IDS.postRestored)).toMatchObject({
      state: "published",
      published_at: "2026-05-10T02:00:00Z",
    });
  });

  it("AC F15-4: simpan formulir lama → pemberitahuan konflik, isian tidak ditimpa, simpan ditahan sampai muat ulang", async () => {
    const user = userEvent.setup();
    await openEditor(user, CONTENT_IDS.postDraft);
    const title = screen.getByRole("textbox", { name: /^Judul konten/ });
    await user.clear(title);
    await user.type(title, "Rapat pengurus November");
    // Aksi penerbitan ditahan selama ada perubahan yang belum disimpan.
    expect(within(panel()).getByRole("button", { name: "Terbitkan sekarang" })).toBeDisabled();

    mockContent.editPostElsewhere(CONTENT_IDS.postDraft);
    await user.click(screen.getByRole("button", { name: "Simpan draf" }));
    const notice = (await screen.findByText(/Berita ini sudah diubah pengurus lain/)).closest<HTMLElement>(
      '[role="alert"]',
    )!;
    expect(notice).toHaveTextContent("Berita ini sudah diubah pengurus lain");
    // `author` adalah pembuat berita, bukan pengubah terakhir: tidak disebut sebagai pelaku perubahan.
    expect(notice).not.toHaveTextContent(/ oleh /);
    expect(notice).not.toHaveTextContent(mockContent.post(CONTENT_IDS.postDraft)!.author!.display_name);
    // Status terbaru dari `current` ditampilkan (PRD 4.5).
    expect(notice).toHaveTextContent("Status terbaru:");
    expect(within(notice).getByText("Draf")).toBeInTheDocument();
    await waitFor(() => expect(notice).toHaveFocus());
    expect(lastRequest("PATCH", CONTENT_IDS.postDraft)).toMatchObject({
      ifMatch: "1",
      body: { title: "Rapat pengurus November" },
    });
    // Tidak menimpa diam-diam: isian admin tetap, simpan dan terbit ditahan.
    expect(title).toHaveValue("Rapat pengurus November");
    expect(screen.getByRole("button", { name: "Simpan draf" })).toHaveAttribute("aria-disabled", "true");
    expect(mockContent.post(CONTENT_IDS.postDraft)?.title).toBe("Judul diubah pengurus lain");

    await user.click(within(notice).getByRole("button", { name: "Muat ulang versi terbaru" }));
    await waitFor(() => expect(title).toHaveValue("Judul diubah pengurus lain"));
    expect(title).toHaveFocus();
    await user.type(title, " (revisi)");
    await user.click(screen.getByRole("button", { name: "Simpan draf" }));
    await findToast("success", "Perubahan disimpan.");
    expect(lastRequest("PATCH", CONTENT_IDS.postDraft)?.ifMatch).toBe("2");
    expect(mockContent.post(CONTENT_IDS.postDraft)?.title).toBe("Judul diubah pengurus lain (revisi)");
  });

  it("AC F15-5: jadwal tiba saat editor terbuka → batalkan jadwal ditolak; pemberitahuan menyebut status terbaru, bukan pengurus lain", async () => {
    const user = userEvent.setup();
    await openEditor(user, CONTENT_IDS.postScheduled);
    // Job menerbitkan berita tepat waktunya; tidak ada pengurus yang menyunting (versi tetap).
    mockContent.makeScheduledDue(CONTENT_IDS.postScheduled);
    await user.click(within(panel()).getByRole("button", { name: "Batalkan jadwal" }));
    await confirmIn(user, /Batalkan jadwal terbit\?/, "Batalkan jadwal");

    const notice = (await screen.findByText(/Status berita ini sudah berubah/)).closest<HTMLElement>(
      '[role="alert"]',
    )!;
    expect(notice).not.toHaveTextContent(/pengurus lain/);
    expect(notice).toHaveTextContent(/Tindakan Anda tidak dijalankan/);
    expect(within(notice).getByText("Terbit")).toBeInTheDocument();
    expect(lastRequest("POST", "/unschedule")?.ifMatch).toBe("1");
    expect(mockContent.post(CONTENT_IDS.postScheduled)).toMatchObject({ state: "published", version: "1" });

    await user.click(within(notice).getByRole("button", { name: "Muat ulang versi terbaru" }));
    await waitFor(() => expect(screen.queryByText(/Status berita ini sudah berubah/)).toBeNull());
    expect(within(panel()).getByText("Terbit")).toBeInTheDocument();
    expect(within(panel()).queryByRole("button", { name: "Batalkan jadwal" })).toBeNull();
    expect(screen.getByRole("textbox", { name: /^Slug tautan/ })).toHaveAttribute("readonly");
  });

  it("PRD 4.5: simpan dan terbit ditahan selama cover diunggah, sehingga cover pilihan admin tidak hilang", async () => {
    const user = userEvent.setup();
    renderApp("/content/posts/new");
    await signIn(user);
    await screen.findByRole("heading", { level: 1, name: "Tambah Konten Baru" }, { timeout: 8000 });
    const title = screen.getByRole("textbox", { name: /^Judul konten/ });
    await user.type(title, "Bakti sosial");
    const editor = await screen.findByRole("textbox", { name: /^Isi berita/ }, { timeout: 8000 });
    editor.focus();
    await user.paste("Ayo ikut bakti sosial.");
    await waitFor(() => expect(editor).toHaveTextContent("Ayo ikut bakti sosial."));

    const release = mockContent.holdUploads();
    await user.upload(screen.getByTestId("content-image-input-post_cover"), pngFile());
    const save = screen.getByRole("button", { name: "Simpan draf" });
    await waitFor(() => expect(save).toHaveAttribute("aria-disabled", "true"));
    expect(save).toHaveAccessibleDescription("Tunggu unggahan gambar cover selesai sebelum menyimpan.");
    await user.click(save);
    await user.type(title, "{Enter}");
    expect(contentRequests.some((r) => r.method === "POST" && r.path === "/admin/content/posts")).toBe(false);

    release();
    expect(await screen.findByRole("img", { name: "Cover Bakti sosial" })).toBeInTheDocument();
    await waitFor(() => expect(save).not.toHaveAttribute("aria-disabled"));
    await user.click(save);
    await findToast("success", "Draf berita disimpan.");
    const created = lastRequest("POST", "/admin/content/posts");
    expect(created?.body?.cover_file_id).toEqual(expect.stringMatching(/^0199e100-0000-7000-9000-/));
    await screen.findByRole("heading", { level: 1, name: "Edit Konten" });
    expect(screen.getByRole("img", { name: "Cover Bakti sosial" })).toBeInTheDocument();

    // Mengganti cover berita tersimpan: aksi penerbitan juga ditahan selama unggahan berjalan.
    const releaseAgain = mockContent.holdUploads();
    await user.upload(screen.getByTestId("content-image-input-post_cover"), pngFile("cover-baru.png"));
    expect(
      await within(panel()).findByText(/Tunggu unggahan gambar cover selesai, lalu simpan/),
    ).toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: "Terbitkan sekarang" })).toBeDisabled();
    releaseAgain();
    // Cover baru menjadi perubahan yang harus disimpan sebelum terbit.
    expect(await within(panel()).findByText(/Simpan perubahan terlebih dahulu/)).toBeInTheDocument();
  });

  it("PRD 4.5: pilihan kategori sedang dimuat atau gagal dimuat → kategori berita tetap tampil, dengan pesan dan muat ulang", async () => {
    const release = mockContent.holdCategoryList(true);
    const user = userEvent.setup();
    await openEditor(user, CONTENT_IDS.postDonasi);
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Kategori" });
    expect(select).toBeDisabled();
    expect(select).toHaveValue(CONTENT_IDS.categoryEventBulanan);
    expect(select.selectedOptions[0]?.textContent).toBe("Event Bulanan");
    expect(select).toHaveAccessibleDescription("Memuat pilihan kategori...");

    release();
    const retry = await screen.findByRole("button", { name: "Muat ulang pilihan kategori" });
    expect(select).toBeEnabled();
    expect(select).toHaveValue(CONTENT_IDS.categoryEventBulanan);
    expect(select).toHaveAccessibleDescription(/Pilihan kategori gagal dimuat/);
    // Kategori yang tersimpan tidak dianggap berubah.
    expect(screen.getByText("Belum ada perubahan untuk disimpan.")).toBeInTheDocument();

    await user.click(retry);
    await waitFor(() =>
      expect(within(select).getByRole("option", { name: "Pengumuman" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Muat ulang pilihan kategori" })).toBeNull();
    expect(select).toHaveValue(CONTENT_IDS.categoryEventBulanan);
  });

  it("pratinjau menampilkan isi seperti aplikasi anggota dengan tautan luar ditandai", async () => {
    const user = userEvent.setup();
    await openEditor(user, CONTENT_IDS.postDonasi);
    // Isi bertautan dari server tidak membuat formulir dianggap berubah saat dimuat (AC F15-4).
    await screen.findByRole("textbox", { name: /^Isi berita/ });
    expect(screen.getByText("Belum ada perubahan untuk disimpan.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Simpan perubahan" })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("button", { name: "Pratinjau" }));
    const dialog = await screen.findByRole("dialog", { name: "Pratinjau berita" });
    const article = within(dialog).getByRole("article", { name: "Pratinjau Donasi korban bencana" });
    expect(within(article).getByRole("heading", { name: "Donasi korban bencana" })).toBeInTheDocument();
    expect(within(article).getByText("Event Bulanan")).toBeInTheDocument();
    expect(within(article).getByRole("link", { name: /situs resmi.*tautan luar/ })).toHaveAttribute(
      "rel",
      "noopener noreferrer nofollow",
    );
  });

  it("perubahan belum disimpan: meninggalkan editor meminta konfirmasi", async () => {
    const user = userEvent.setup();
    const { router } = await openEditor(user, CONTENT_IDS.postDraft);
    await user.type(screen.getByRole("textbox", { name: /^Judul konten/ }), " revisi");
    await user.click(screen.getByRole("link", { name: "Daftar berita" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Tinggalkan tanpa menyimpan\?/ });
    await user.click(within(dialog).getByRole("button", { name: "Tetap di sini" }));
    expect(router.state.location.pathname).toBe(`/content/posts/${CONTENT_IDS.postDraft}`);
    await user.click(screen.getByRole("link", { name: "Daftar berita" }));
    await user.click(
      within(await screen.findByRole("alertdialog", { name: /Tinggalkan/ })).getByRole("button", {
        name: "Tinggalkan",
      }),
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Manajemen Konten" })).toBeInTheDocument();
  });

  it("berita yang sudah dihapus menampilkan keadaan tidak ditemukan", async () => {
    const user = userEvent.setup();
    renderApp("/content/posts/0199e100-0000-7000-8000-00000000ffff");
    await signIn(user);
    expect(await screen.findByText("Data tidak ditemukan", undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Kembali ke daftar berita" })).toBeInTheDocument();
  });
});
