import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RichTextEditor } from "./RichTextEditor";

// jsdom tidak mengimplementasikan geometri Range/teks; ProseMirror memakainya untuk menggulir ke kursor setelah
// perintah bilah alat.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);

describe("RichTextEditor (F-08, N-11)", () => {
  it("memuat editor terpisah, area isi berlabel, bilah alat dengan roving tabindex dan aria-pressed", async () => {
    const user = userEvent.setup();
    render(
      <RichTextEditor
        label="Isi berita"
        value="<p>Halo alumni</p>"
        onChange={vi.fn()}
        hint="Isi disanitasi server."
      />,
    );
    // Potongan kode editor dimuat lazy; beri waktu lebih saat suite berjalan paralel.
    const editor = await screen.findByRole("textbox", { name: "Isi berita" }, { timeout: 8000 });
    expect(editor).toHaveAttribute("aria-multiline", "true");
    expect(editor).toHaveAccessibleDescription("Isi disanitasi server.");
    expect(editor).toHaveTextContent("Halo alumni");

    const toolbar = screen.getByRole("toolbar", { name: "Format Isi berita" });
    const bold = within(toolbar).getByRole("button", { name: "Tebal" });
    expect(bold).toHaveAttribute("aria-pressed", "false");
    expect(bold).toHaveAttribute("tabindex", "0");
    expect(within(toolbar).getByRole("button", { name: "Miring" })).toHaveAttribute("tabindex", "-1");
    bold.focus();
    await user.keyboard("{ArrowRight}");
    expect(within(toolbar).getByRole("button", { name: "Miring" })).toHaveFocus();
  });

  it("roving tabindex tidak pernah jatuh ke tombol mati: tombol tak berlaku tetap dapat difokus (aria-disabled)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RichTextEditor label="Isi berita" value="<p>Halo</p>" onChange={onChange} />);
    const toolbar = await screen.findByRole("toolbar", { name: "Format Isi berita" }, { timeout: 8000 });
    const buttons = within(toolbar).getAllByRole("button");
    const tabStops = () => buttons.filter((b) => b.getAttribute("tabindex") === "0");

    // Panah kiri dari tombol pertama berputar ke "Ulangi" yang belum berlaku (belum ada riwayat).
    within(toolbar).getByRole("button", { name: "Tebal" }).focus();
    await user.keyboard("{ArrowLeft}");
    const redo = within(toolbar).getByRole("button", { name: "Ulangi" });
    expect(redo).toHaveFocus();
    expect(redo).toHaveAttribute("aria-disabled", "true");
    expect(redo).not.toHaveAttribute("disabled");
    // Tepat satu perhentian Tab, dan itu tombol yang sedang difokus.
    expect(tabStops()).toEqual([redo]);
    const callsBefore = onChange.mock.calls.length;
    await user.click(redo);
    // Klik tombol tak berlaku diabaikan: isi tidak berubah.
    expect(onChange).toHaveBeenCalledTimes(callsBefore);
    expect(redo).toHaveFocus();

    // Urungkan sampai riwayat habis: tombol yang menjadi perhentian Tab kini tidak berlaku, tetapi tetap dapat
    // difokus (bukan disabled native) sehingga bilah alat tidak hilang dari urutan Tab.
    await user.click(within(toolbar).getByRole("button", { name: "Daftar berpoin" }));
    const undo = within(toolbar).getByRole("button", { name: "Urungkan" });
    await waitFor(() => expect(undo).not.toHaveAttribute("aria-disabled"));
    await user.click(undo);
    await waitFor(() => expect(undo).toHaveAttribute("aria-disabled", "true"));
    expect(undo).not.toHaveAttribute("disabled");
    expect(tabStops()).toEqual([undo]);
    undo.focus();
    expect(undo).toHaveFocus();
  });

  it("HTML dimuat: tautan selain https/mailto kehilangan tautannya dan gambar non-https dibuang", async () => {
    render(
      <RichTextEditor
        label="Isi halaman"
        value={
          '<p><a href="https://kapdh.or.id">aman</a> <a href="http://kapdh.or.id">http</a> ' +
          '<a href="javascript:alert(1)">skrip</a> <a href="/relatif">relatif</a></p>' +
          '<img src="http://contoh.test/a.png" alt="tidak aman"><img src="https://contoh.test/b.png" alt="aman">'
        }
        onChange={vi.fn()}
      />,
    );
    const editor = await screen.findByRole("textbox", { name: "Isi halaman" }, { timeout: 8000 });
    const links = Array.from(editor.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(links).toEqual(["https://kapdh.or.id"]);
    expect(editor).toHaveTextContent("aman http skrip relatif");
    const images = Array.from(editor.querySelectorAll("img")).map((i) => i.getAttribute("src"));
    expect(images).toEqual(["https://contoh.test/b.png"]);
  });

  it("HTML yang ditempel: gambar tanpa teks alternatif atau non-https dibuang sebelum di-parse", async () => {
    const { sanitizePastedHtml } = await import("./RichTextEditorImpl");
    const out = sanitizePastedHtml(
      '<p>Teks</p><img src="https://a.test/1.png"><img src="https://a.test/2.png" alt="  ">' +
        '<img src="http://a.test/3.png" alt="ada"><img src="https://a.test/4.png" alt="Foto bersama">',
    );
    expect(out).toBe('<p>Teks</p><img src="https://a.test/4.png" alt="Foto bersama">');
  });

  it("tautan hanya https/mailto: alamat javascript: ditolak dengan pesan", async () => {
    const user = userEvent.setup();
    render(<RichTextEditor label="Isi halaman" value="<p>Teks</p>" onChange={vi.fn()} />);
    const toolbar = await screen.findByRole("toolbar", { name: "Format Isi halaman" }, { timeout: 8000 });
    await user.click(within(toolbar).getByRole("button", { name: "Sisipkan tautan" }));
    const dialog = await screen.findByRole("dialog", { name: "Sisipkan tautan" });
    await user.type(within(dialog).getByRole("textbox", { name: /Alamat tautan/ }), "javascript:alert(1)");
    await user.click(within(dialog).getByRole("button", { name: "Sisipkan" }));
    expect(within(dialog).getByRole("textbox", { name: /Alamat tautan/ })).toHaveAccessibleDescription(
      "Gunakan alamat yang diawali https:// atau mailto:.",
    );
  });

  it("N-07: editor tidak menyuntikkan <style> inline (CSP style-src 'self' infra/nginx-admin.conf)", async () => {
    render(<RichTextEditor label="Isi CSP" value="<p>Teks</p>" onChange={vi.fn()} />);
    await screen.findByRole("textbox", { name: "Isi CSP" }, { timeout: 8000 });
    // TipTap bawaan menambahkan <style data-tiptap-style> ke <head>; CSP tanpa 'unsafe-inline' memblokirnya.
    // Aturan dasar ProseMirror ada di components/ui/tiptap-base.css (berkas CSS dari origin sendiri).
    expect(document.querySelectorAll("style")).toHaveLength(0);
  });
});
