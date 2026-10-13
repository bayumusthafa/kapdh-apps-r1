import type { components } from "@kapdh/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { isAccessExpired } from "../../api/files";
import { MOCK_PROOF_FILE_ID } from "../../api/mocks/payments";
import { renderWithProviders, signInViaApi } from "../../test/utils";
import { FilePreview, FileUpload, previewKind } from "./Files";

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
    renderWithProviders(<Harness purpose="adjustment_evidence" onChange={onChange} />);
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
    renderWithProviders(<Harness purpose="adjustment_evidence" onChange={onChange} />);
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "besar.png", { type: "image/png" });
    await user.upload(screen.getByTestId("file-input"), big);
    expect(await screen.findByRole("alert")).toHaveTextContent("Gambar maksimal 5 MB.");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("mengunggah lewat POST /files lalu menampilkan pratinjau dan FileRef", async () => {
    await signInViaApi();
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<Harness purpose="adjustment_evidence" onChange={onChange} />);
    await user.upload(
      screen.getByTestId("file-input"),
      new File([new Uint8Array([137, 80, 78, 71])], "sampul.png", { type: "image/png" }),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // Isi berkas tidak terbawa lintas realm jsdom→undici di lingkungan uji; cukup periksa metadata FileRef.
    expect(onChange.mock.calls[0]![0]).toMatchObject({ purpose: "adjustment_evidence", mime: "image/png" });
    expect(screen.getByRole("img", { name: "Pratinjau sampul berita" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ganti berkas: Sampul" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hapus berkas" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe("previewKind (bukti bayar boleh PDF, N-10)", () => {
  it("memakai mime bila ada, lalu tipe data URL, lalu ekstensi URL bertanda tangan", () => {
    expect(previewKind("application/pdf", "https://x.test/a")).toBe("pdf");
    expect(previewKind("image/png", "https://x.test/a.pdf")).toBe("image");
    expect(previewKind(null, "data:application/pdf;base64,AAAA")).toBe("pdf");
    expect(previewKind(undefined, "https://cdn.test/bukti/abc.PDF?X-Amz-Expires=600")).toBe("pdf");
    expect(previewKind(undefined, "https://cdn.test/bukti/abc.jpeg?sig=1")).toBe("image");
    expect(previewKind(undefined, "https://cdn.test/objek/abc?sig=1")).toBe("unknown");
  });
});

describe("FilePreview (PRD 5.4)", () => {
  it("URL akses kedaluwarsa dianggap tidak layak dibuka; masih lama = layak", () => {
    const now = Date.parse("2026-10-13T08:00:00Z");
    expect(isAccessExpired({ url: "u", expires_at: "2026-10-13T08:00:03Z", mime: "image/png" }, now)).toBe(
      true,
    );
    expect(isAccessExpired({ url: "u", expires_at: "2026-10-13T08:09:00Z", mime: "image/png" }, now)).toBe(
      false,
    );
    // Berkas publik: URL tetap tanpa kedaluwarsa.
    expect(isAccessExpired({ url: "u", expires_at: null, mime: "image/png" }, now)).toBe(false);
    expect(isAccessExpired(undefined, now)).toBe(true);
  });

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

  it("pratinjau gagal dimuat padahal URL masih berlaku: bingkai netral 'Buka berkas' tanpa meminta URL ulang", async () => {
    await signInViaApi();
    const { queryClient } = renderWithProviders(
      <FilePreview fileId={MOCK_PROOF_FILE_ID} alt="Bukti transfer Siti" caption="versi 1" />,
    );
    const img = await screen.findByRole("img", { name: "Bukti transfer Siti" });
    // Mis. bukti PDF tanpa info tipe dimuat sebagai <img>.
    fireEvent.error(img);
    expect(await screen.findByText(/Buka berkas untuk memeriksanya/)).toBeInTheDocument();
    expect(screen.queryByText("Pratinjau tidak tersedia")).toBeNull();
    expect(screen.getByRole("link", { name: /Buka berkas/ })).toHaveAttribute("target", "_blank");
    // URL belum kedaluwarsa: tidak ada permintaan URL ulang yang sia-sia.
    expect(queryClient.getQueryState(["file-access", MOCK_PROOF_FILE_ID])?.dataUpdateCount).toBe(1);
  });

  it("berkas tidak ditemukan menampilkan pesan dan tombol coba lagi", async () => {
    await signInViaApi();
    renderWithProviders(<FilePreview fileId="0199e000-0000-7000-8000-00000000dead" alt="Bukti" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Berkas tidak ditemukan.");
    expect(screen.getByRole("button", { name: "Coba lagi" })).toBeInTheDocument();
  });
});
