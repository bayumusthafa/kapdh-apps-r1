import { ImageOff, Upload } from "lucide-react";
import { type DragEvent, useEffect, useId, useRef, useState } from "react";
import { toApiError } from "../../api/errors";
import { IMAGE_MAX_BYTES } from "../../api/files";
import { Button } from "../../components/ui/Button";
import { formatBytes } from "../../components/ui/Files";
import { cn } from "../../lib/cn";
import { uploadEventCover } from "./api";

const TYPES = ["image/jpeg", "image/png"];
export const COVER_RULES = "JPG/PNG maksimal 5 MB. Gambar tampil publik di aplikasi; jangan memuat data pribadi.";

/** Pesan galat bila berkas jelas ditolak server (N-10); null bila layak dikirim. */
export function validateCoverFile(file: File): string | null {
  if (!TYPES.includes(file.type)) return "Tipe berkas tidak diterima. Gunakan JPG atau PNG.";
  if (file.size > IMAGE_MAX_BYTES) return "Gambar maksimal 5 MB.";
  if (file.size === 0) return "Berkas kosong.";
  return null;
}

type UploadState = { kind: "idle" } | { kind: "uploading"; name: string } | { kind: "error"; message: string };

export interface CoverValue {
  fileId: string;
  url: string | null;
  caption?: string;
}

/**
 * Kolom "Gambar" guideline p14: unggah cover event lewat POST /admin/event-covers (izin events.manage, N-10).
 * Berkas divalidasi di klien lebih dulu agar aturan langsung terlihat; server tetap memeriksa magic bytes,
 * dimensi dan kuota unggah. Pemasangan cover baru tercatat saat event disimpan (audit event.created/updated).
 */
export function EventCoverField({
  value,
  onChange,
  error,
  disabled,
}: {
  value: CoverValue | null;
  onChange: (value: CoverValue | null) => void;
  error?: string | null;
  disabled?: boolean;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<UploadState>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [broken, setBroken] = useState(false);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => setBroken(false), [value?.url]);

  async function handleFile(file: File) {
    const invalid = validateCoverFile(file);
    if (invalid) {
      setState({ kind: "error", message: invalid });
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ kind: "uploading", name: file.name });
    try {
      const media = await uploadEventCover(file, controller.signal);
      if (controller.signal.aborted) return;
      setState({ kind: "idle" });
      onChange({ fileId: media.file_id, url: media.url, caption: `${file.name} | ${formatBytes(media.bytes)}` });
    } catch (e) {
      if (controller.signal.aborted) return;
      const err = toApiError(e);
      setState({
        kind: "error",
        message:
          err.code === "FILE_INVALID"
            ? `${err.message} Gunakan JPG/PNG maksimal 5 MB.`
            : err.retryAfterSeconds
              ? `${err.message} Coba lagi dalam ${err.retryAfterSeconds} detik.`
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
  const rulesId = `${id}-rules`;
  const errId = shownError ? `${id}-err` : undefined;
  const label = "Gambar cover";

  return (
    <div role="group" aria-labelledby={`${id}-label`} className="flex flex-col gap-1.5">
      <span id={`${id}-label`} className="text-sm font-medium text-text">
        {label}
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
          <figure className="flex flex-col gap-1.5">
            {value.url && !broken ? (
              <img
                src={value.url}
                alt="Pratinjau gambar cover event"
                referrerPolicy="no-referrer"
                onError={() => setBroken(true)}
                className="aspect-video w-full max-w-md rounded-md bg-neutral-50 object-cover"
              />
            ) : (
              <span className="flex aspect-video w-full max-w-md flex-col items-center justify-center gap-2 rounded-md bg-neutral-100 text-sm text-text-muted">
                <ImageOff aria-hidden="true" className="size-8" />
                Pratinjau tidak tersedia
              </span>
            )}
            {value.caption ? <figcaption className="text-xs text-text-muted">{value.caption}</figcaption> : null}
          </figure>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            aria-label={`${state.kind === "uploading" ? "Mengunggah" : value ? "Ganti gambar" : "Pilih gambar"}: ${label}`}
            disabled={disabled}
            loading={state.kind === "uploading"}
            loadingText="Mengunggah..."
            leftIcon={<Upload aria-hidden="true" className="size-4" />}
            aria-describedby={[errId, rulesId].filter(Boolean).join(" ")}
            onClick={() => inputRef.current?.click()}
          >
            {value ? "Ganti gambar" : "Pilih gambar"}
          </Button>
          {value && state.kind !== "uploading" ? (
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(null)}>
              Hapus gambar
            </Button>
          ) : null}
          <span className="text-xs text-text-muted">atau tarik gambar ke sini</span>
        </div>
        <p id={rulesId} className="text-xs text-text-muted">
          {COVER_RULES}
        </p>
        <input
          ref={inputRef}
          type="file"
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
          accept={TYPES.join(",")}
          data-testid="cover-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleFile(file);
          }}
        />
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {state.kind === "uploading" ? `Mengunggah ${state.name}...` : value ? "Gambar cover siap disimpan." : null}
      </span>
      {shownError ? (
        <p id={errId} role="alert" className="text-xs font-medium text-danger">
          {shownError}
        </p>
      ) : null}
    </div>
  );
}
