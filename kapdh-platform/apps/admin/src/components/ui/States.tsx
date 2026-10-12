import {
  Construction,
  Inbox,
  Lock,
  RefreshCw,
  SearchX,
  ServerCrash,
  Timer,
  WifiOff,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { type ApiError, toApiError } from "../../api/errors";
import { cn } from "../../lib/cn";
import { Button } from "./Button";

/**
 * Keadaan layar baku (PRD 4.5: loading, kosong, error, sukses dan izin ditolak memiliki pesan dan tindakan
 * spesifik). Semua teks berbahasa Indonesia dan tidak bergantung pada warna saja.
 */
function StateFrame({
  icon,
  title,
  description,
  action,
  tone = "neutral",
  role,
  className,
  compact,
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "danger" | "warning";
  role?: "alert" | "status";
  className?: string;
  compact?: boolean;
}) {
  const toneCls = {
    neutral: "bg-green-50 text-primary",
    danger: "bg-danger-bg text-danger",
    warning: "bg-warning-bg text-warning",
  }[tone];
  return (
    <div
      role={role}
      className={cn(
        "flex flex-col items-center justify-center gap-3 text-center",
        compact ? "px-4 py-8" : "px-6 py-14",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("flex size-12 items-center justify-center rounded-pill [&_svg]:size-6", toneCls)}
      >
        {icon}
      </span>
      <div className="flex max-w-md flex-col gap-1">
        <p className="font-heading text-h3 font-semibold text-text">{title}</p>
        {description ? <div className="text-sm text-text-muted">{description}</div> : null}
      </div>
      {action ? <div className="flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon = <Inbox />,
  compact,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <StateFrame
      icon={icon}
      title={title}
      description={description}
      action={action}
      compact={compact}
      className={className}
    />
  );
}

export function ForbiddenState({ description, compact }: { description?: ReactNode; compact?: boolean }) {
  return (
    <StateFrame
      role="alert"
      tone="warning"
      icon={<Lock />}
      title="Akses ditolak"
      compact={compact}
      description={
        description ??
        "Akun Anda tidak memiliki izin untuk halaman atau tindakan ini. Hubungi Super Admin bila Anda memerlukannya."
      }
    />
  );
}

export function NotFoundState({ description, action }: { description?: ReactNode; action?: ReactNode }) {
  return (
    <StateFrame
      icon={<SearchX />}
      title="Data tidak ditemukan"
      description={description ?? "Data mungkin sudah dihapus atau Anda membuka tautan yang salah."}
      action={action}
    />
  );
}

/**
 * Keadaan galat yang dipetakan dari katalog ERROR_UI (@kapdh/shared): offline, izin ditolak, tidak ditemukan,
 * maintenance, batas percobaan, konflik versi, atau galat umum dengan kode referensi untuk bantuan.
 */
export function ErrorState({
  error,
  onRetry,
  title,
  compact,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  compact?: boolean;
  className?: string;
}) {
  const e: ApiError = toApiError(error);
  const retry = onRetry ? (
    <Button
      variant="outline"
      size="sm"
      leftIcon={<RefreshCw aria-hidden="true" className="size-4" />}
      onClick={onRetry}
    >
      Coba lagi
    </Button>
  ) : null;
  const reference = e.requestId ? (
    <span className="mt-1 block text-xs">Kode referensi: {e.requestId}</span>
  ) : null;

  switch (e.ui.action) {
    case "show_forbidden":
      return <ForbiddenState compact={compact} />;
    case "show_not_found":
      return <NotFoundState description={e.message} />;
    case "show_offline":
      return (
        <StateFrame
          role="alert"
          tone="warning"
          icon={<WifiOff />}
          title="Tidak dapat terhubung"
          description={e.message}
          action={retry}
          compact={compact}
          className={className}
        />
      );
    case "show_maintenance":
      return (
        <StateFrame
          role="alert"
          tone="warning"
          icon={<Wrench />}
          title="Layanan sedang dalam pemeliharaan"
          description={e.message}
          action={retry}
          compact={compact}
          className={className}
        />
      );
    case "show_countdown":
      return (
        <StateFrame
          role="alert"
          tone="warning"
          icon={<Timer />}
          title="Terlalu banyak permintaan"
          description={
            e.retryAfterSeconds ? `${e.message} Coba lagi dalam ${e.retryAfterSeconds} detik.` : e.message
          }
          action={retry}
          compact={compact}
          className={className}
        />
      );
    default:
      return (
        <StateFrame
          role="alert"
          tone="danger"
          icon={<ServerCrash />}
          title={title ?? "Data gagal dimuat"}
          description={
            <>
              {e.message}
              {reference}
            </>
          }
          action={retry}
          compact={compact}
          className={className}
        />
      );
  }
}

/** Blok pemuat dekoratif. Sertakan teks status untuk pembaca layar lewat `Loading`. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("block animate-pulse rounded-sm bg-neutral-200", className)} />
  );
}

/** Status memuat yang dibacakan pembaca layar dengan kerangka visual. */
export function Loading({
  label = "Memuat data...",
  rows = 4,
  className,
}: {
  label?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <div role="status" aria-live="polite" className={cn("flex flex-col gap-3 p-4", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("h-5", i % 3 === 2 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

/** Kerangka halaman saat potongan kode area dimuat (code splitting per area). */
export function PageSkeleton() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-5">
      <span className="sr-only">Memuat halaman...</span>
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <div className="flex flex-wrap gap-4">
        <Skeleton className="h-24 flex-[1_1_220px]" />
        <Skeleton className="h-24 flex-[1_1_220px]" />
        <Skeleton className="h-24 flex-[1_1_220px]" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/**
 * Penanda area yang belum dibangun (dibangun irisan halaman admin Phase C). Bukan stub fitur: rute, izin dan
 * menu sudah aktif sehingga perilaku akses dapat diuji sejak fondasi.
 */
export function UnderConstruction({ feature, items }: { feature: string; items?: string[] }) {
  return (
    <StateFrame
      role="status"
      icon={<Construction />}
      title="Sedang dibangun"
      description={
        <>
          <p>{feature} sedang dibangun dan akan tersedia pada pembaruan berikutnya.</p>
          {items && items.length > 0 ? (
            <ul className="mt-3 list-inside list-disc text-left">
              {items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          ) : null}
        </>
      }
    />
  );
}
