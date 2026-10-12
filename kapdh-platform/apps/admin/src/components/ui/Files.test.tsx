import type { components } from "@kapdh/contracts";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { MOCK_PROOF_FILE_ID } from "../../api/mocks/payments";
import { renderWithProviders, signInViaApi } from "../../test/utils";
import { FilePreview, FileUpload } from "./Files";

type FileRef = components["schemas"]["FileRef"];

// jsdom tidak menyediakan object URL; pratinjau lokal cukup memakai URL tiruan.
URL.createObjectURL = vi.fn(() => "blob:pratinjau");
URL.revokeObjectURL = vi.fn();

function Harness({
  purpose,
  onChange,
}: {
  purpose: FileRef["purpose"];
  onChange: (f: FileRef | null) => void;
}) {
  const [value, setValue] = useState<FileRef | null>(null);
  return (
    <FileUpload
      purpose={purpose}
      label="Sampul"
      value={value}
      onChange={(f) => {
        setValue(f);
        onChange(f);
      }}
      previewAlt="Pratinjau sampul berita"
    />
  );
}

describe("FileUpload (N-10)", () => {
  it("menolak PDF untuk purpose selain bukti bayar di klien, dengan aturan yang berlaku", async () => {
    await signInViaApi();
    const user = userEvent.setup({ applyAccept: false });
    const onChange = vi.fn();
    renderWithProviders(<Harness purpose="cover" onChange={onChange} />);
    const input = screen.getByTestId("file-input");
    await user.upload(input, new File(["%PDF-1.7"], "proposal.pdf", { type: "application/pdf" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Tipe berkas tidak diterima. Gunakan JPG/PNG maksimal 5 MB.",
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Pilih berkas: Sampul" })).toHaveAccessibleDescription(
      /Tipe berkas tidak diterima/,
    );
  });

  it("menolak gambar lebih dari 5 MB tanpa mengunggah", async () => {
    await signInViaApi();
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<Harness purpose="cover" onChange={onChange} />);
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "besar.png", { type: "image/png" });
    await user.upload(screen.getByTestId("file-input"), big);
    expect(await screen.findByRole("alert")).toHaveTextContent("Gambar maksimal 5 MB.");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("mengunggah lewat POST /files lalu menampilkan pratinjau dan FileRef", async () => {
    await signInViaApi();
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<Harness purpose="cover" onChange={onChange} />);
    await user.upload(
      screen.getByTestId("file-input"),
      new File([new Uint8Array([137, 80, 78, 71])], "sampul.png", { type: "image/png" }),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // Isi berkas tidak terbawa lintas realm jsdom→undici di lingkungan uji; cukup periksa metadata FileRef.
    expect(onChange.mock.calls[0]![0]).toMatchObject({ purpose: "cover", mime: "image/png" });
    expect(screen.getByRole("img", { name: "Pratinjau sampul berita" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ganti berkas: Sampul" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hapus berkas" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe("FilePreview (PRD 5.4)", () => {
  it("memuat URL bertanda tangan GET /files/{id}/access dan menyediakan tautan buka", async () => {
    await signInViaApi();
    renderWithProviders(
      <FilePreview fileId={MOCK_PROOF_FILE_ID} alt="Bukti transfer Siti" caption="versi 1" />,
    );
    const img = await screen.findByRole("img", { name: "Bukti transfer Siti" });
    expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByRole("link", { name: /Buka ukuran penuh/ })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
  });

  it("berkas tidak ditemukan menampilkan pesan dan tombol coba lagi", async () => {
    await signInViaApi();
    renderWithProviders(<FilePreview fileId="0199e000-0000-7000-8000-00000000dead" alt="Bukti" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Berkas tidak ditemukan.");
    expect(screen.getByRole("button", { name: "Coba lagi" })).toBeInTheDocument();
  });
});
