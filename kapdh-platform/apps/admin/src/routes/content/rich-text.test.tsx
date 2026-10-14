import { render, screen } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { RichTextEditor } from "../../components/ui/RichTextEditor";

const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);

/** Isi tersanitasi server dengan tautan luar; urutan atribut berbeda dari serialisasi TipTap. */
const SERVER_HTML =
  '<p>KAPDH membuka donasi. Informasi di <a href="https://kapdh.or.id/donasi" target="_blank" rel="noopener noreferrer nofollow">situs resmi</a>.</p>';

function Host({ onChange, disabled }: { onChange: (v: string) => void; disabled: boolean }) {
  const [value, setValue] = useState(SERVER_HTML);
  return (
    <RichTextEditor
      label="Isi berita"
      value={value}
      disabled={disabled}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

describe("editor isi konten di dalam formulir konten (AC F15-4)", () => {
  it("memuat isi bertautan dan mengubah status nonaktif tidak memancarkan perubahan (formulir tidak menjadi kotor)", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <StrictMode>
        <Host onChange={onChange} disabled={false} />
      </StrictMode>,
    );
    const editor = await screen.findByRole("textbox", { name: "Isi berita" }, { timeout: 8000 });
    expect(editor).toHaveTextContent("situs resmi");
    // Simpan berjalan: editor dinonaktifkan lalu diaktifkan lagi.
    rerender(
      <StrictMode>
        <Host onChange={onChange} disabled />
      </StrictMode>,
    );
    rerender(
      <StrictMode>
        <Host onChange={onChange} disabled={false} />
      </StrictMode>,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(onChange).not.toHaveBeenCalled();
  });
});
