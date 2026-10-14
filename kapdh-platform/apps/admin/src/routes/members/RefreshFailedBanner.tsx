import { RefreshCw, TriangleAlert } from "lucide-react";
import { toApiError } from "../../api/errors";
import { Button } from "../../components/ui/Button";

/**
 * Muat ulang di latar gagal (mis. saat kembali online) padahal data sebelumnya sudah tampil: data dan formulir
 * yang sedang diisi tetap dipertahankan, galat ditampilkan sebaris dengan tombol coba lagi (PRD 4.5, N-11).
 * Keadaan galat satu halaman penuh hanya dipakai bila belum ada data sama sekali.
 */
export function RefreshFailedBanner({
  error,
  subject,
  onRetry,
  retrying = false,
}: {
  error: unknown;
  /** Mis. "Data anggota" atau "Daftar alumni". */
  subject: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  const e = toApiError(error);
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-warning-bg p-3 text-sm text-warning"
    >
      <span className="flex min-w-0 items-start gap-2">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>
          <span className="font-medium">
            {subject} terbaru gagal dimuat; yang tampil adalah data terakhir yang berhasil dimuat.
          </span>{" "}
          <span className="text-text">{e.message}</span>
        </span>
      </span>
      <Button
        variant="outline"
        size="sm"
        loading={retrying}
        leftIcon={<RefreshCw aria-hidden="true" className="size-4" />}
        onClick={onRetry}
      >
        Coba lagi
      </Button>
    </div>
  );
}
