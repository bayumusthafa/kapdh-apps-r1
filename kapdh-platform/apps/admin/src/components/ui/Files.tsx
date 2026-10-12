import type { components } from "@kapdh/contracts";
import { ExternalLink, FileText, ImageOff, Upload } from "lucide-react";
import { type DragEvent, type MouseEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { toApiError } from "../../api/errors";
import {
  acceptedTypes,
  fileRulesText,
  isAccessExpired,
  uploadFile,
  useFileAccess,
  validateFileForPurpose,
} from "../../api/files";
import { cn } from "../../lib/cn";
import { Button } from "./Button";
import { Skeleton } from "./States";

type FilePurpose = components["schemas"]["FilePurpose"];
type FileRef = components["schemas"]["FileRef"];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

type PreviewKind = "image" | "pdf" | "unknown";

/**
 * Jenis berkas untuk pratinjau. `mime` dari FileRef diutamakan; bila tidak ada (mis. detail pembayaran admin hanya
 * membawa `proof_file_id`), ditebak dari URL: data URL membawa tipe, URL bertanda tangan biasanya berakhiran
 * ekstensi objek. Tebakan hanya memilih tampilan; berkas tetap dibuka lewat URL yang sama.
 */
export function previewKind(mime: string | null | undefined, url: string): PreviewKind {
  if (mime) return mime === "application/pdf" ? "pdf" : mime.startsWith("image/") ? "image" : "unknown";
  const data = /^data:([^;,]+)/i.exec(url);
  if (data) return previewKind(data[1]!.toLowerCase(), "");
  try {
    const path = new URL(url, window.location.origin).pathname.toLowerCase();
    if (path.endsWith(".pdf")) return "pdf";
    if (/\.(jpe?g|png)$/.test(path)) return "image";
  } catch {
    // URL tidak valid: tampilkan sebagai berkas tak dikenal.
  }
  return "unknown";
}

/**
 * Pratinjau berkas privat lewat URL bertanda tangan GET /files/{id}/access (berlaku <= 10 menit, PRD 5.4).
 * - Gambar ditampilkan langsung; PDF (bukti bayar boleh PDF, N-10) ditampilkan sebagai bingkai "Dokumen PDF" dengan
 *   tautan buka di tab baru.
 * - Jenis tak dikenal dicoba sebagai gambar; bila gagal dimuat padahal URL belum kedaluwarsa, berkas mungkin bukan
 *   gambar (mis. PDF) sehingga ditampilkan bingkai netral "Buka berkas", bukan kesan bukti rusak.
 * - URL diminta ulang hanya bila memang kedaluwarsa; tautan yang diklik setelah kedaluwarsa (mis. laptop tidur)
 *   meminta URL baru lebih dulu.
 */
export function FilePreview({
  fileId,
  mime,
  alt,
  caption,
  className,
  heightClass = "h-56",
}: {
  fileId: string | null | undefined;
  mime?: string | null;
  alt: string;
  caption?: ReactNode;
  className?: string;
  heightClass?: string;
}) {
  const access = useFileAccess(fileId);
  const [broken, setBroken] = useState(false);
  const [opening, setOpening] = useState(false);
  const retried = useRef(false);
  useEffect(() => {
    setBroken(false);
    retried.current = false;
  }, [fileId]);

  const frame = cn(
    "flex flex-col items-center justify-center gap-2 overflow-hidden rounded-md border border-divider bg-neutral-100 text-sm text-text-muted",
    heightClass,
    className,
  );

  if (!fileId)
    return (
      <div className={frame}>
        <ImageOff aria-hidden="true" className="size-8" />
        <span>Belum ada berkas</span>
      </div>
    );
  if (access.isPending)
    return (
      <div className={frame} role="status" aria-live="polite">
        <Skeleton className="h-full w-full" />
        <span className="sr-only">Memuat pratinjau berkas...</span>
      </div>
    );
  if (access.isError)
    return (
      <div className={frame} role="alert">
        <ImageOff aria-hidden="true" className="size-8" />
        <span>{access.error.message}</span>
        <Button size="sm" variant="outline" onClick={() => void access.refetch()}>
          Coba lagi
        </Button>
      </div>
    );

  const url = access.data.url;
  const kind = previewKind(mime, url);
  const showImage = kind !== "pdf" && !broken;

  async function openFresh(e: MouseEvent<HTMLAnchorElement>) {
    if (!isAccessExpired(access.data)) return;
    // URL sudah kedaluwarsa (mis. laptop tertidur): minta yang baru dulu, lalu buka.
    e.preventDefault();
    setOpening(true);
    const fresh = await access.refetch();
    setOpening(false);
    if (fresh.data) window.open(fresh.data.url, "_blank", "noopener,noreferrer");
  }

  return (
    <figure className="flex flex-col gap-1.5">
      {showImage ? (
        <div className={cn(frame, "bg-neutral-50")}>
          <img
            src={url}
            alt={alt}
            referrerPolicy="no-referrer"
            className="h-full w-full object-contain"
            onError={() => {
              // URL kedaluwarsa: minta sekali lagi. Bila belum kedaluwarsa, berkas memang tidak dapat ditampilkan
              // sebagai gambar (mis. PDF tanpa info tipe): tampilkan bingkai netral tanpa permintaan ulang.
              if (!retried.current && isAccessExpired(access.data)) {
                retried.current = true;
                void access.refetch();
              } else setBroken(true);
            }}
          />
        </div>
      ) : (
        <div className={frame}>
          <FileText aria-hidden="true" className="size-8" />
          <span>
            {kind === "pdf"
              ? "Dokumen PDF"
              : kind === "unknown"
                ? "Pratinjau tidak dapat ditampilkan di sini. Buka berkas untuk memeriksanya."
                : "Gambar tidak dapat dimuat. Buka berkas untuk memeriksanya."}
          </span>
        </div>
      )}
      <figcaption className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
        <span>{caption}</span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          aria-busy={opening || undefined}
          onClick={(e) => void openFresh(e)}
          className="inline-flex min-h-11 items-center gap-1 font-semibold text-primary hover:underline"
        >
          {kind === "pdf" ? "Buka PDF" : showImage ? "Buka ukuran penuh" : "Buka berkas"}
          <ExternalLink aria-hidden="true" className="size-3.5" />
          <span className="sr-only">(tab baru)</span>
        </a>
      </figcaption>
    </figure>
  );
}

type UploadState =
  { kind: "idle" } | { kind: "uploading"; name: string } | { kind: "error"; message: string };

/**
 * Unggah berkas bertujuan (POST /files) dengan pratinjau. Berkas divalidasi dulu di klien (tipe/ukuran sesuai
 * purpose) agar admin langsung tahu aturan yang berlaku (PRD 4.5 "Bukti tidak valid"). Hasilnya FileRef yang
 * kemudian dilampirkan ke objek (banner, post, event) oleh formulir pemanggil.
 */
export function FileUpload({
  purpose,
  value,
  onChange,
  label,
  hint,
  error,
  required,
  disabled,
  previewAlt,
}: {
  purpose: FilePurpose;
  value: FileRef | null;
  onChange: (file: FileRef | null) => void;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  previewAlt?: string;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<UploadState>({ kind: "idle" });
  const [localPreview, setLocalPreview] = useState<{ url: string; name: string } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Batalkan unggahan yang masih berjalan saat komponen dilepas.
  useEffect(() => () => abortRef.current?.abort(), []);
  // Lepaskan object URL pratinjau lama agar memori tidak bocor.
  useEffect(
    () => () => {
      if (localPreview?.url) URL.revokeObjectURL(localPreview.url);
    },
    [localPreview],
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
      const ref = await uploadFile(purpose, file, controller.signal);
      if (controller.signal.aborted) return;
      setLocalPreview(
        file.type.startsWith("image/")
          ? { url: URL.createObjectURL(file), name: file.name }
          : { url: "", name: file.name },
      );
      setState({ kind: "idle" });
      onChange(ref);
    } catch (e) {
      if (controller.signal.aborted) return;
      const err = toApiError(e);
      setState({
        kind: "error",
        message:
          err.code === "FILE_INVALID"
            ? `${err.message} ${fileRulesText(purpose)}`
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
  const statusId = `${id}-status`;

  return (
    <div role="group" aria-labelledby={`${id}-label`} className="flex flex-col gap-1.5">
      <span id={`${id}-label`} className="text-sm font-medium text-text">
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
          localPreview?.url ? (
            <figure className="flex flex-col gap-1.5">
              <img
                src={localPreview.url}
                alt={previewAlt ?? `Pratinjau ${localPreview.name}`}
                className="h-40 w-full rounded-md bg-neutral-50 object-contain"
              />
              <figcaption className="text-xs text-text-muted">
                {localPreview.name} | {formatBytes(value.bytes)}
              </figcaption>
            </figure>
          ) : localPreview ? (
            <p className="flex items-center gap-2 text-sm">
              <FileText aria-hidden="true" className="size-5 text-primary" />
              {localPreview.name} | {formatBytes(value.bytes)}
            </p>
          ) : (
            <FilePreview
              fileId={value.id}
              mime={value.mime}
              alt={previewAlt ?? "Pratinjau berkas"}
              heightClass="h-40"
              caption={formatBytes(value.bytes)}
            />
          )
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            aria-label={`${state.kind === "uploading" ? "Mengunggah" : value ? "Ganti berkas" : "Pilih berkas"}: ${label}`}
            size="sm"
            disabled={disabled}
            loading={state.kind === "uploading"}
            loadingText="Mengunggah..."
            leftIcon={<Upload aria-hidden="true" className="size-4" />}
            aria-describedby={[errId, rulesId].filter(Boolean).join(" ")}
            onClick={() => inputRef.current?.click()}
          >
            {value ? "Ganti berkas" : "Pilih berkas"}
          </Button>
          {value && state.kind !== "uploading" ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setLocalPreview(null);
                onChange(null);
              }}
            >
              Hapus berkas
            </Button>
          ) : null}
          <span className="text-xs text-text-muted">atau tarik berkas ke sini</span>
        </div>
        <p id={rulesId} className="text-xs text-text-muted">
          {hint ? <>{hint} </> : null}Ketentuan: {fileRulesText(purpose)}
        </p>
        <input
          ref={inputRef}
          type="file"
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
          accept={acceptedTypes(purpose).join(",")}
          data-testid="file-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleFile(file);
          }}
        />
      </div>
      <span id={statusId} role="status" aria-live="polite" className="sr-only">
        {state.kind === "uploading"
          ? `Mengunggah ${state.name}...`
          : value
            ? "Berkas siap dilampirkan."
            : null}
      </span>
      {shownError ? (
        <p id={errId} role="alert" className="text-xs font-medium text-danger">
          {shownError}
        </p>
      ) : null}
    </div>
  );
}
