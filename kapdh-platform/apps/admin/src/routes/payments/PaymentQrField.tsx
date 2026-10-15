import { ImageOff, Upload } from "lucide-react";
import { type DragEvent, type Ref, useEffect, useId, useRef, useState } from "react";
import { toApiError } from "../../api/errors";
import { IMAGE_MAX_BYTES } from "../../api/files";
import { Button } from "../../components/ui/Button";
import { formatBytes } from "../../components/ui/Files";
import { cn } from "../../lib/cn";
import { uploadPaymentQrImage } from "./queries";

const TYPES = ["image/png", "image/jpeg"];
export const QR_LABEL = "Gambar QRIS";
export const QR_HINT =
  "Gunakan QRIS statis resmi organisasi (tanpa nominal), PNG/JPG minimal 512 px, maksimal 5 MB. Gambar ini ditampilkan ke alumni.";
const QR_RULES = "PNG/JPG, sisi terpendek minimal 512 px, maksimal 5 MB.";
const QR_LOCKED =
  "Gambar QRIS metode yang sudah dipakai pembayaran tidak dapat diganti atau dihapus. Nonaktifkan metode ini lalu tambah metode QRIS baru.";

/** Pesan galat bila berkas jelas ditolak server (N-10); null bila layak dikirim. Dimensi diperiksa server. */
export function validateQrFile(file: File): string | null {
  if (!TYPES.includes(file.type)) return "Tipe berkas tidak diterima. Gunakan gambar PNG atau JPG.";
  if (file.size > IMAGE_MAX_BYTES) return "Gambar maksimal 5 MB.";
  if (file.size === 0) return "Berkas kosong.";
  return null;
}

export interface QrImageValue {
  fileId: string;
  url: string | null;
  /** Nama berkas dan ukuran hasil proses, hanya untuk unggahan baru. */
  caption?: string;
}

type UploadState =
  { kind: "idle" } | { kind: "uploading"; name: string } | { kind: "error"; message: string };

/**
 * Isian "Gambar QRIS" metode bayar qris (ADR-026, N-10): unggah lewat POST /admin/payment-qr-images (settings.manage).
 * Berkas diperiksa di klien lebih dulu (PNG/JPG <= 5 MB) agar aturannya langsung terlihat; server tetap memeriksa
 * magic bytes, sisi terpendek >= 512 piksel, membuang EXIF dan memperkecil gambar > 2048 piksel. Unggahan memakai
 * AbortController: memilih berkas lain atau menutup formulir membatalkan unggahan yang sedang berjalan, dan statusnya
 * dilaporkan ke formulir (`onUploadingChange`) agar Simpan ditahan sampai gambar selesai diunggah. Gambar baru
 * dilampirkan saat metode disimpan (audit payment_method.* mencatat id + sha256).
 *
 * Pratinjau berlatar putih, `object-contain` dan `pixelated` agar modul QR tetap tajam seperti yang dilihat alumni.
 * Gambar metode yang sudah dipakai pembayaran terkunci (`locked`): Ganti/Hapus nonaktif dan alasannya dibacakan.
 */
export function PaymentQrField({
  value,
  onChange,
  error,
  locked,
  disabled,
  buttonRef,
  onUploadingChange,
}: {
  value: QrImageValue | null;
  onChange: (value: QrImageValue | null) => void;
  error?: string | null;
  /** Metode sudah dipakai pembayaran: gambar bagian dari identitas metode (D4). */
  locked?: boolean;
  /** Mis. saat formulir sedang menyimpan. */
  disabled?: boolean;
  /** Ref tombol pilih gambar, agar galat `qr_image_file_id` memfokusnya (N-11). */
  buttonRef?: Ref<HTMLButtonElement>;
  /** Dipanggil saat unggahan mulai (true) dan selesai, gagal atau dibatalkan (false). */
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<UploadState>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [broken, setBroken] = useState(false);
  /** Pengumuman pembaca layar setelah tindakan admin (bukan saat formulir dibuka). */
  const [announcement, setAnnouncement] = useState("");
  const reportRef = useRef(onUploadingChange);
  reportRef.current = onUploadingChange;
  const uploading = state.kind === "uploading";
  const inactive = Boolean(locked || disabled);

  useEffect(() => {
    reportRef.current?.(uploading);
  }, [uploading]);
  useEffect(
    () => () => {
      abortRef.current?.abort();
      reportRef.current?.(false);
    },
    [],
  );
  useEffect(() => setBroken(false), [value?.url]);

  async function handleFile(file: File) {
    const invalid = validateQrFile(file);
    if (invalid) {
      setState({ kind: "error", message: invalid });
      setAnnouncement("");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ kind: "uploading", name: file.name });
    setAnnouncement(`Mengunggah ${file.name}...`);
    try {
      const image = await uploadPaymentQrImage(file, controller.signal);
      if (controller.signal.aborted) return;
      setState({ kind: "idle" });
      setAnnouncement(`${QR_LABEL} ${file.name} terunggah. Simpan metode untuk memakainya.`);
      onChange({
        fileId: image.file_id,
        url: image.url,
        caption: `${file.name} | ${image.width} x ${image.height} px | ${formatBytes(image.bytes)}`,
      });
    } catch (e) {
      if (controller.signal.aborted) return;
      const err = toApiError(e);
      setAnnouncement("");
      setState({
        kind: "error",
        message:
          err.code === "FILE_INVALID"
            ? `${err.message} Ketentuan: ${QR_RULES}`
            : err.retryAfterSeconds
              ? `${err.message} Coba lagi dalam ${Math.ceil(err.retryAfterSeconds / 60)} menit.`
              : err.message,
      });
    }
  }

  function remove() {
    setState({ kind: "idle" });
    setAnnouncement(`${QR_LABEL} dihapus dari isian.`);
    onChange(null);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (inactive || uploading) return;
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  }

  const shownError = state.kind === "error" ? state.message : error;
  const labelId = `${id}-label`;
  const rulesId = `${id}-rules`;
  const lockedId = locked ? `${id}-locked` : undefined;
  const errId = shownError ? `${id}-err` : undefined;
  const describedBy = [errId, lockedId, rulesId].filter(Boolean).join(" ");

  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1.5">
      <span id={labelId} className="text-sm font-medium text-text">
        {QR_LABEL}
        <span aria-hidden="true" className="ml-0.5 text-danger">
          *
        </span>
        <span className="sr-only"> (wajib)</span>
      </span>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!inactive && !uploading) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col gap-3 rounded-md border border-dashed p-4",
          dragging ? "border-primary bg-green-50" : "border-border bg-surface",
          shownError && "border-danger",
        )}
      >
        {value ? (
          <figure className="flex flex-col gap-1.5">
            {value.url && !broken ? (
              <img
                src={value.url}
                alt="Pratinjau gambar QRIS"
                referrerPolicy="no-referrer"
                onError={() => setBroken(true)}
                style={{ imageRendering: "pixelated" }}
                className="size-56 rounded-md border border-divider bg-white object-contain p-2"
              />
            ) : (
              <span className="flex size-56 flex-col items-center justify-center gap-2 rounded-md bg-neutral-100 text-center text-sm text-text-muted">
                <ImageOff aria-hidden="true" className="size-8" />
                Pratinjau tidak tersedia
              </span>
            )}
            {value.caption ? (
              <figcaption className="text-xs text-text-muted">{value.caption}</figcaption>
            ) : null}
          </figure>
        ) : (
          <div className="flex h-28 flex-col items-center justify-center gap-1 rounded-md bg-neutral-100 text-sm text-text-muted">
            <ImageOff aria-hidden="true" className="size-6" />
            <span>Belum ada gambar QRIS</span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            ref={buttonRef}
            variant="outline"
            size="sm"
            disabled={inactive}
            loading={uploading}
            loadingText="Mengunggah..."
            aria-label={`${uploading ? "Mengunggah" : value ? "Ganti gambar" : "Pilih gambar"}: ${QR_LABEL}`}
            aria-describedby={describedBy}
            aria-invalid={shownError ? true : undefined}
            leftIcon={<Upload aria-hidden="true" className="size-4" />}
            onClick={() => inputRef.current?.click()}
          >
            {value ? "Ganti gambar" : "Pilih gambar"}
          </Button>
          {value && !uploading ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={inactive}
              aria-label={`Hapus gambar: ${QR_LABEL}`}
              aria-describedby={lockedId}
              onClick={remove}
            >
              Hapus gambar
            </Button>
          ) : null}
          {!inactive ? <span className="text-xs text-text-muted">atau tarik gambar ke sini</span> : null}
        </div>
        {locked ? (
          <p id={lockedId} className="text-xs text-text-muted">
            {QR_LOCKED}
          </p>
        ) : null}
        <p id={rulesId} className="text-xs text-text-muted">
          {QR_HINT}
        </p>
        <input
          ref={inputRef}
          type="file"
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
          accept={TYPES.join(",")}
          disabled={inactive}
          data-testid="payment-qr-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleFile(file);
          }}
        />
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      {shownError ? (
        <p id={errId} role="alert" className="text-xs font-medium text-danger">
          {shownError}
        </p>
      ) : null}
    </div>
  );
}
