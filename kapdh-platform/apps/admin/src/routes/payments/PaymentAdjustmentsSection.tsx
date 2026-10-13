import type { components } from "@kapdh/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Plus } from "lucide-react";
import { useState } from "react";
import { useAuth } from "../../auth/session";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { formatDate, formatRupiah } from "../../lib/format";
import { CreateAdjustmentDialog } from "./CreateAdjustmentDialog";
import { ADJUSTMENT_KIND_LABEL, AdjustmentStatusBadge } from "./labels";

type Detail = components["schemas"]["AdminPaymentDetail"];

/**
 * Penyesuaian atas payment ini (D6, PRD 3.4): daftar refund/koreksi beserta status dan tenggat, tautan ke tab
 * Penyesuaian untuk memprosesnya, dan "Catat penyesuaian" bila server mengizinkan (`actions.can_adjust`: paid,
 * payments.decide, tanpa konflik kepentingan). Status lunas tidak pernah diubah (ARCHITECTURE §2 butir 13).
 */
export function PaymentAdjustmentsSection({
  payment: p,
  onReload,
  onCreated,
}: {
  payment: Detail;
  onReload: () => void;
  onCreated: (message: string) => void;
}) {
  const auth = useAuth();
  const navigate = useNavigate({ from: "/payments" });
  const [open, setOpen] = useState(false);
  const canAdjust = p.actions.can_adjust && auth.can("payments.decide");
  if (p.adjustments.length === 0 && !canAdjust) return null;

  return (
    <section
      aria-labelledby="penyesuaian-pembayaran"
      className="flex flex-col gap-3 border-t border-divider pt-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="penyesuaian-pembayaran" className="text-sm font-semibold">
          Penyesuaian ({p.adjustments.length})
        </h3>
        {canAdjust ? (
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Plus aria-hidden="true" className="size-4" />}
            onClick={() => setOpen(true)}
          >
            Catat penyesuaian
          </Button>
        ) : null}
      </div>
      {p.adjustments.length === 0 ? (
        <p className="text-sm text-text-muted">
          Belum ada refund atau koreksi. Pembayaran lunas tidak pernah diubah; koreksi dan refund dicatat di
          sini.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-divider rounded-md border border-divider">
          {p.adjustments.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="flex min-w-0 flex-col gap-1 text-sm">
                <span className="font-medium">
                  {ADJUSTMENT_KIND_LABEL[a.kind]} {formatRupiah(a.amount)}
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <AdjustmentStatusBadge status={a.status} />
                  {a.due_at && a.status === "pending" ? (
                    <span className="text-xs text-text-muted">Tenggat {formatDate(a.due_at)}</span>
                  ) : null}
                  {a.overdue ? <Badge tone="danger">Lewat tenggat</Badge> : null}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="flex-row-reverse"
                leftIcon={<ArrowRight aria-hidden="true" className="size-4" />}
                aria-label={`Buka ${ADJUSTMENT_KIND_LABEL[a.kind].toLowerCase()} ${formatRupiah(a.amount)} di tab Penyesuaian`}
                onClick={() => void navigate({ search: { tab: "adjustments", adjustment: a.id } })}
              >
                Buka
              </Button>
            </li>
          ))}
        </ul>
      )}
      {canAdjust ? (
        <CreateAdjustmentDialog
          open={open}
          payment={p}
          onClose={() => setOpen(false)}
          onCreated={(_a, message) => onCreated(message)}
          onConflict={onReload}
        />
      ) : null}
    </section>
  );
}
