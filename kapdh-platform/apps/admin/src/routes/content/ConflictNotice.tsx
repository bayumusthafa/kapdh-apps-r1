import { RefreshCw, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { Button } from "../../components/ui/Button";
import { formatDateTime } from "../../lib/format";
import type { ConflictCause } from "./contentApi";

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** Kalimat utama pemberitahuan sesuai penyebab; tidak pernah menuduh "pengurus lain" bila penyebabnya bukan itu. */
export function conflictHeadline(
  cause: ConflictCause,
  subject: string,
  updatedAt?: string | null,
  updatedBy?: string | null,
): string {
  switch (cause) {
    case "edited": {
      const who = updatedBy ? ` oleh ${updatedBy}` : "";
      const when = updatedAt ? ` pada ${formatDateTime(updatedAt)}` : "";
      return `${subject} sudah diubah pengurus lain${who}${when}.`;
    }
    case "state_changed":
      return `Status ${lowerFirst(subject)} sudah berubah sejak halaman ini dimuat.`;
    case "unconfirmed":
      return `Permintaan untuk ${lowerFirst(subject)} tidak dijalankan.`;
  }
}

const EXPLANATION: Record<ConflictCause, string> = {
  edited:
    "Perubahan Anda belum disimpan agar tidak menimpa versi terbaru. Muat ulang untuk melihat versi terbaru; isian yang belum disimpan di formulir ini akan diganti, jadi salin dahulu bagian yang ingin dipertahankan.",
  state_changed:
    "Tindakan Anda tidak dijalankan karena tidak berlaku lagi untuk status terbaru. Muat ulang untuk melihat keadaan terbaru sebelum melanjutkan; isian yang belum disimpan di formulir ini akan diganti.",
  unconfirmed:
    "Permintaan bertabrakan dengan permintaan sebelumnya sehingga server menolaknya. Muat ulang untuk melihat keadaan terbaru sebelum mencoba lagi; isian yang belum disimpan di formulir ini akan diganti.",
};

/**
 * Pemberitahuan konflik (AC F15-4, PRD 4.5 "Objek telah diubah admin lain: tampil status terbaru dan tombol muat
 * ulang"). Formulir lama TIDAK ditimpa diam-diam: isian admin tetap terlihat (dapat disalin) sampai admin memilih
 * memuat versi terbaru, dan tombol simpan/terbit ditahan pemanggil selama konflik belum diselesaikan. Kalimatnya
 * mengikuti penyebab (`ConflictCause`) dan status terbaru dari `current` ditampilkan bila ada. Fokus dipindah ke
 * pemberitahuan agar pengguna keyboard/pembaca layar langsung mengetahuinya (N-11).
 */
export function ConflictNotice({
  subject,
  cause,
  updatedAt,
  updatedBy,
  latestStatus,
  onReload,
}: {
  /** Objek yang berubah, mis. "Berita ini". */
  subject: string;
  cause: ConflictCause;
  /** Waktu perubahan terakhir dari `current` (hanya dipakai untuk penyebab `edited`). */
  updatedAt?: string | null;
  /** Pengubah terakhir, hanya bila kontrak menyediakannya (mis. `updated_by` halaman). */
  updatedBy?: string | null;
  /** Status terbaru dari `current`, mis. lencana keadaan berita. */
  latestStatus?: ReactNode;
  onReload: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-bg p-4 text-sm sm:flex-row sm:items-start"
    >
      <TriangleAlert aria-hidden="true" className="size-5 shrink-0 text-warning" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-semibold text-text">{conflictHeadline(cause, subject, updatedAt, updatedBy)}</p>
        {latestStatus ? (
          <p className="flex flex-wrap items-center gap-2 text-text">
            <span>Status terbaru:</span>
            {latestStatus}
          </p>
        ) : null}
        <p className="text-text-muted">{EXPLANATION[cause]}</p>
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
