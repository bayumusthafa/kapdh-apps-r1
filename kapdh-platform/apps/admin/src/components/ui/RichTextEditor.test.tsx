import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RichTextEditor } from "./RichTextEditor";

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
});
