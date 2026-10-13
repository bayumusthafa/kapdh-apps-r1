import { Copy, Download, KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/Choice";
import { formatDateTime } from "../../lib/format";

/**
 * Backup code sekali pakai (F-02, PRD 8.2 langkah 5): ditampilkan SEKALI setelah pendaftaran TOTP atau pembuatan
 * ulang di halaman Akun; server hanya menyimpan hash. Kode hanya berada di state komponen ini (tidak di
 * localStorage, URL, log maupun cache query) dan hilang saat admin melanjutkan. Admin wajib menyatakan sudah
 * menyimpan sebelum tombol lanjut aktif.
 */
export function BackupCodesPanel({
  codes,
  generatedAt,
  doneLabel,
  onDone,
  pending = false,
}: {
  codes: readonly string[];
  generatedAt: string;
  doneLabel: string;
  onDone: () => void;
  pending?: boolean;
}) {
  const [saved, setSaved] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const text = [
    "Backup code KAPDH Admin",
    `Dibuat: ${formatDateTime(generatedAt)}`,
    "Setiap kode hanya dapat dipakai sekali. Simpan di tempat aman.",
    "",
    ...codes,
  ].join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("Backup code disalin ke papan klip.");
    } catch {
      setCopyStatus("Gagal menyalin otomatis. Pilih dan salin kode secara manual.");
    }
  }

  function download() {
    if (typeof URL.createObjectURL !== "function") {
      setCopyStatus("Peramban tidak mendukung unduhan. Salin kode secara manual.");
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `kapdh-backup-code-${generatedAt.slice(0, 10).replace(/-/g, "")}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setCopyStatus("Berkas backup code diunduh.");
  }

  return (
    <section aria-labelledby="judul-backup-code" className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-md bg-warning-bg p-3 text-sm text-warning">
        <KeyRound aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
        <div className="flex flex-col gap-1">
          <h2 id="judul-backup-code" className="font-semibold">
            Simpan backup code sekarang
          </h2>
          <p className="text-text">
            Kode ini hanya ditampilkan sekali. Pakai salah satunya bila aplikasi autentikator tidak tersedia;
            setiap kode hanya berlaku satu kali. Backup code lama tidak berlaku lagi.
          </p>
        </div>
      </div>
      <ol
        aria-label="Daftar backup code"
        className="grid grid-cols-2 gap-2 rounded-md border border-divider bg-neutral-50 p-3 font-mono text-sm"
      >
        {codes.map((code, i) => (
          <li key={code} className="flex items-center gap-2">
            <span aria-hidden="true" className="w-5 text-right text-xs text-text-muted">
              {i + 1}.
            </span>
            <span className="select-all tracking-wider">{code}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          leftIcon={<Copy aria-hidden="true" className="size-4" />}
          onClick={() => void copy()}
        >
          Salin semua
        </Button>
        <Button
          variant="outline"
          size="sm"
          leftIcon={<Download aria-hidden="true" className="size-4" />}
          onClick={download}
        >
          Unduh .txt
        </Button>
      </div>
      <p role="status" aria-live="polite" className="text-xs text-text-muted">
        {copyStatus}
      </p>
      <Checkbox
        boxed
        label="Saya sudah menyimpan backup code di tempat yang aman."
        checked={saved}
        onCheckedChange={setSaved}
        disabled={pending}
      />
      <Button disabled={!saved} loading={pending} loadingText="Memproses..." onClick={onDone}>
        {doneLabel}
      </Button>
    </section>
  );
}
