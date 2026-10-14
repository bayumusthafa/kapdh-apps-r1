import { ImageOff, Upload } from "lucide-react";
import { type DragEvent, type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";
import { toApiError } from "../../api/errors";
import { acceptedTypes, fileRulesText, validateFileForPurpose } from "../../api/files";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { type ContentImage, type S, uploadContentMedia } from "./contentApi";

type UploadState =
  { kind: "idle" } | { kind: "uploading"; name: string } | { kind: "error"; message: string };

/**
 * Unggah gambar konten (cover berita / gambar banner) lewat POST /admin/content/media (N-10, PRD 2.5). Berkas
 * diperiksa dulu di klien (JPG/PNG <= 5 MB) agar admin langsung tahu aturannya (PRD 4.5 "Bukti tidak valid");
 * server tetap memeriksa magic bytes, membuang EXIF, meng-encode ulang dan membatasi 10 unggahan per 24 jam.
 * Gambar yang tidak dilampirkan dalam 24 jam dibersihkan job berkas, jadi formulir baru melampirkannya saat disimpan.
 * Status unggah dilaporkan ke formulir induk (`onUploadingChange`) agar simpan/terbit ditahan selama unggahan
 * berjalan: menyimpan lebih dahulu akan mengirim gambar lama dan, bila halaman berpindah, membatalkan unggahan
 * sehingga gambar pilihan admin hilang diam-diam (PRD 4.5).
 */
export function ContentImageField({
  purpose,
  value,
  onChange,
  label,
  hint,
  error,
  required,
  disabled,
  previewAlt,
  buttonRef,
  onBlur,
  onUploadingChange,
}: {
  purpose: S["ContentMediaPurpose"];
  value: ContentImage | null;
  onChange: (image: ContentImage | null) => void;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  previewAlt: string;
  /** Ref tombol pilih (react-hook-form memfokuskannya saat galat server, N-11). */
  buttonRef?: Ref<HTMLButtonElement>;
  onBlur?: () => void;
  /** Dipanggil saat unggahan mulai (true) dan selesai, gagal atau dibatalkan (false). */
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<UploadState>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const uploading = state.kind === "uploading";
  const reportRef = useRef(onUploadingChange);
  reportRef.current = onUploadingChange;

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

  async function handleFile(file: File) {
    const invalid = validateFileForPurpose(file, purpose);
    if (invalid) {
      setState({ kind: "error", message: invalid });
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ kind: "uploading", name: file.name });
    try {
      const media = await uploadContentMedia(purpose, file, controller.signal);
      if (controller.signal.aborted) return;
      setState({ kind: "idle" });
      onChange({ file_id: media.file_id, url: media.url });
    } catch (e) {
      if (controller.signal.aborted) return;
      const err = toApiError(e);
      setState({
        kind: "error",
        message:
          err.code === "FILE_INVALID"
            ? `${err.message} Ketentuan: ${fileRulesText(purpose)}`
            : err.retryAfterSeconds
              ? `${err.message} Coba lagi dalam ${Math.ceil(err.retryAfterSeconds / 60)} menit.`
              : err.message,
      });
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  }

  const shownError = state.kind === "error" ? state.message : error;
  const labelId = `${id}-label`;
  const rulesId = `${id}-rules`;
  const errId = shownError ? `${id}-err` : undefined;

  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1.5">
      <span id={labelId} className="text-sm font-medium text-text">
        {label}
        {required ? (
          <>
            <span aria-hidden="true" className="ml-0.5 text-danger">
              *
            </span>
            <span className="sr-only"> (wajib)</span>
          </>
        ) : null}
      </span>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
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
          <img
            src={value.url}
            alt={previewAlt}
            referrerPolicy="no-referrer"
            className="h-40 w-full rounded-md bg-neutral-50 object-contain"
          />
        ) : (
          <div className="flex h-28 flex-col items-center justify-center gap-1 rounded-md bg-neutral-100 text-sm text-text-muted">
            <ImageOff aria-hidden="true" className="size-6" />
            <span>Belum ada gambar</span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            ref={buttonRef}
            variant="outline"
            size="sm"
            disabled={disabled}
            loading={uploading}
            loadingText="Mengunggah..."
            aria-label={`${uploading ? "Mengunggah" : value ? "Ganti gambar" : "Pilih gambar"}: ${label}`}
            aria-describedby={[errId, rulesId].filter(Boolean).join(" ")}
            aria-invalid={shownError ? true : undefined}
            leftIcon={<Upload aria-hidden="true" className="size-4" />}
            onClick={() => inputRef.current?.click()}
            onBlur={onBlur}
          >
            {value ? "Ganti gambar" : "Pilih gambar"}
          </Button>
          {value && !uploading && !required ? (
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(null)}>
              Lepas gambar
            </Button>
          ) : null}
          <span className="text-xs text-text-muted">atau tarik gambar ke sini</span>
        </div>
        <p id={rulesId} className="text-xs text-text-muted">
          {hint ? <>{hint} </> : null}Ketentuan: {fileRulesText(purpose)} Jangan memuat data pribadi; gambar
          ini publik.
        </p>
        <input
          ref={inputRef}
          type="file"
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
          accept={acceptedTypes(purpose).join(",")}
          data-testid={`content-image-input-${purpose}`}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleFile(file);
          }}
        />
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {uploading ? `Mengunggah ${state.name}...` : value ? "Gambar siap dilampirkan." : null}
      </span>
      {shownError ? (
        <p id={errId} role="alert" className="text-xs font-medium text-danger">
          {shownError}
        </p>
      ) : null}
    </div>
  );
}
