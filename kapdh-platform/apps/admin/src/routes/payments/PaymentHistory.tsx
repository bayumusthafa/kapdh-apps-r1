import type { components } from "@kapdh/contracts";
import { FileSearch } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Timeline, type TimelineItem } from "../../components/ui/DataDisplay";
import { Dialog } from "../../components/ui/Dialog";
import { FilePreview } from "../../components/ui/Files";
import { formatDateTime } from "../../lib/format";

type PaymentEvent = components["schemas"]["AdminPaymentEvent"];

export const EVENT_LABEL: Record<PaymentEvent["kind"], string> = {
  created: "Tagihan dibuat",
  method_changed: "Rekening tujuan diganti",
  proof_submitted: "Bukti dikirim",
  proof_replaced: "Bukti diganti",
  approved: "Disetujui",
  rejected: "Ditolak",
  cancelled: "Dibatalkan",
  adjusted: "Penyesuaian dicatat",
};

const EVENT_TONE: Record<PaymentEvent["kind"], TimelineItem["tone"]> = {
  created: "neutral",
  method_changed: "neutral",
  proof_submitted: "info",
  proof_replaced: "warning",
  approved: "success",
  rejected: "danger",
  cancelled: "neutral",
  adjusted: "info",
};

/** Pelaku entri histori untuk akuntabilitas pengurus (F-17); identitas admin hanya di histori pengurus. */
function eventActor(e: PaymentEvent): string {
  if (e.actor === "admin") return e.actor_admin ? `Pengurus: ${e.actor_admin.display_name}` : "Pengurus";
  return e.actor === "system" ? "Sistem" : "Alumni";
}

/** Label alasan per jenis entri: penolakan, pembatalan, atau catatan verifikasi pengurus (D13). */
function reasonLabel(kind: PaymentEvent["kind"]): string {
  if (kind === "rejected") return "Alasan penolakan";
  if (kind === "cancelled") return "Alasan pembatalan";
  if (kind === "created") return "Catatan pengurus";
  return "Catatan";
}

interface ProofView {
  fileId: string;
  version: number | null;
}

/**
 * Histori lengkap pembayaran untuk pengurus (U-02, AC F03-3, F04-2): setiap entri dengan pelaku, alasan penolakan
 * sebelumnya, dan tombol membuka berkas bukti versi mana pun (termasuk versi lama yang sudah diganti) lewat URL
 * bertanda tangan (PRD 5.4). Berkas yang sudah dihapus bersama akun pemilik tidak memiliki tombol (D2).
 */
export function PaymentHistory({
  events,
  ownerLabel,
  activeProofVersion,
}: {
  events: PaymentEvent[];
  ownerLabel: string;
  activeProofVersion: number;
}) {
  const [view, setView] = useState<ProofView | null>(null);
  const items: TimelineItem[] = events.map((e, i) => {
    const detail = [eventActor(e), e.reason ? `${reasonLabel(e.kind)}: ${e.reason}` : null]
      .filter(Boolean)
      .join(" | ");
    const fileId = e.proof_file_id;
    return {
      id: `${e.at}-${i}`,
      title: `${EVENT_LABEL[e.kind] ?? e.kind}${e.proof_version ? ` (versi ${e.proof_version})` : ""}`,
      time: formatDateTime(e.at),
      description: (
        <>
          <span className="block">{detail}</span>
          {fileId ? (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-3"
              leftIcon={<FileSearch aria-hidden="true" className="size-4" />}
              onClick={() => setView({ fileId, version: e.proof_version ?? null })}
            >
              {e.proof_version === activeProofVersion
                ? `Lihat bukti versi ${e.proof_version} (aktif)`
                : `Lihat bukti versi ${e.proof_version ?? "lama"}`}
            </Button>
          ) : null}
        </>
      ),
      tone: EVENT_TONE[e.kind] ?? "neutral",
    };
  });

  return (
    <>
      <details className="group rounded-md border border-divider px-3">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-primary">
          Riwayat lengkap ({events.length})
        </summary>
        <Timeline label="Riwayat pembayaran" items={items} className="pb-3" />
      </details>
      <Dialog
        open={view !== null}
        onClose={() => setView(null)}
        size="lg"
        title={`Bukti transfer versi ${view?.version ?? "-"}`}
        description={
          view && view.version !== activeProofVersion
            ? "Versi ini sudah diganti alumni. Keputusan selalu atas versi bukti aktif."
            : "Versi bukti aktif."
        }
      >
        {view ? (
          <FilePreview
            fileId={view.fileId}
            alt={`Bukti transfer ${ownerLabel}, versi ${view.version ?? "lama"}`}
            caption={`Bukti transfer | versi bukti ${view.version ?? "-"}`}
            heightClass="h-80"
          />
        ) : null}
      </Dialog>
    </>
  );
}
