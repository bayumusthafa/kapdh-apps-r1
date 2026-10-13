import { RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "../../components/ui/Button";
import { formatDateTime } from "../../lib/format";

/**
 * Pemberitahuan konflik versi (AC F15-4, PRD 4.5 "Objek telah diubah admin lain: tampil status terbaru dan tombol
 * muat ulang"). Formulir lama TIDAK ditimpa diam-diam: isian admin tetap terlihat (dapat disalin) sampai admin
 * memilih memuat versi terbaru, dan tombol simpan/terbit ditahan pemanggil selama konflik belum diselesaikan.
 * Fokus dipindah ke pemberitahuan agar pengguna keyboard/pembaca layar langsung mengetahuinya (N-11).
 */
export function ConflictNotice({
  subject,
  updatedAt,
  updatedBy,
  onReload,
}: {
  /** Objek yang berubah, mis. "Berita ini". */
  subject: string;
  updatedAt?: string | null;
  updatedBy?: string | null;
  onReload: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const who = updatedBy ? ` oleh ${updatedBy}` : "";
  const when = updatedAt ? ` pada ${formatDateTime(updatedAt)}` : "";
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-bg p-4 text-sm sm:flex-row sm:items-start"
    >
      <TriangleAlert aria-hidden="true" className="size-5 shrink-0 text-warning" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-semibold text-text">
          {subject} sudah diubah pengurus lain{who}
          {when}.
        </p>
        <p className="text-text-muted">
          Perubahan Anda belum disimpan agar tidak menimpa versi terbaru. Muat ulang untuk melihat versi
          terbaru; isian yang belum disimpan di formulir ini akan diganti, jadi salin dahulu bagian yang ingin
          dipertahankan.
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        leftIcon={<RefreshCw aria-hidden="true" className="size-4" />}
        onClick={onReload}
      >
        Muat ulang versi terbaru
      </Button>
    </div>
  );
}
