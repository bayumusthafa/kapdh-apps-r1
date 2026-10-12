import type { components } from "@kapdh/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { api } from "../../api/client";
import { useApiMutation, useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";
import { PaymentStatusBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Checkbox } from "../../components/ui/Choice";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { KeyValueList, Timeline, type TimelineItem } from "../../components/ui/DataDisplay";
import { FilePreview } from "../../components/ui/Files";
import { Field, FormError } from "../../components/ui/FormField";
import { Textarea } from "../../components/ui/Input";
import { ErrorState, Loading } from "../../components/ui/States";
import { formatDateTime, formatRupiah } from "../../lib/format";
import { PAYMENT_TYPE_LABEL } from "../../lib/labels";

type Detail = components["schemas"]["AdminPaymentDetail"];
type PaymentEvent = components["schemas"]["PaymentEvent"];

const EVENT_LABEL: Record<PaymentEvent["kind"], string> = {
  created: "Tagihan dibuat",
  proof_submitted: "Bukti dikirim",
  proof_replaced: "Bukti diganti",
  approved: "Disetujui",
  rejected: "Ditolak",
  cancelled: "Dibatalkan",
  adjusted: "Penyesuaian dicatat",
};

const EVENT_TONE: Record<PaymentEvent["kind"], TimelineItem["tone"]> = {
  created: "neutral",
  proof_submitted: "info",
  proof_replaced: "warning",
  approved: "success",
  rejected: "danger",
  cancelled: "neutral",
  adjusted: "info",
};

export const REASON_MIN = 3;
export const REASON_MAX = 500;

export function paymentDetailKey(paymentId: string) {
  return ["admin-payment", paymentId] as const;
}

/**
 * Panel detail dan keputusan pembayaran (F-04, AC F04-2..F04-4, prototipe screen_8).
 * - Detail dimuat tanpa polling; bila antrean melihat versi bukti lebih baru, detail dimuat ulang.
 * - Formulir keputusan diberi key `id:proof_version` sehingga centang "dana sudah masuk" dan alasan SELALU
 *   direset saat bukti diganti; admin wajib memeriksa ulang bukti baru (perbaikan audit, AC F04-4).
 * - Konflik (bukti diganti/admin lain lebih dulu) → data terbaru dimuat ulang, tidak menimpa diam-diam.
 */
export function PaymentDecisionPanel({
  paymentId,
  listProofVersion,
}: {
  paymentId: string;
  listProofVersion?: number;
}) {
  const detail = useApiQuery({
    queryKey: paymentDetailKey(paymentId),
    request: ({ signal, headers }) =>
      api.GET("/admin/payments/{paymentId}", { params: { path: { paymentId } }, signal, headers }),
  });

  // Antrean (polling) melihat bukti versi lebih baru: muat ulang detail agar admin tidak memutus bukti lama.
  const staleProof =
    detail.data !== undefined &&
    listProofVersion !== undefined &&
    listProofVersion > detail.data.proof_version;
  const refetchDetail = detail.refetch;
  useEffect(() => {
    if (staleProof) void refetchDetail();
  }, [staleProof, refetchDetail]);

  if (detail.isPending)
    return (
      <Card className="p-2">
        <Loading label="Memuat detail pembayaran..." rows={6} />
      </Card>
    );
  if (detail.isError)
    return (
      <Card>
        <ErrorState
          error={detail.error}
          onRetry={() => void detail.refetch()}
          compact
          title="Detail gagal dimuat"
        />
      </Card>
    );

  const p = detail.data;
  const rejections = p.events.filter((e) => e.kind === "rejected").length;
  const timeline: TimelineItem[] = p.events.map((e, i) => ({
    id: `${e.at}-${i}`,
    title: `${EVENT_LABEL[e.kind] ?? e.kind}${e.proof_version ? ` (versi ${e.proof_version})` : ""}`,
    time: formatDateTime(e.at),
    description: e.reason ? `Alasan: ${e.reason}` : undefined,
    tone: EVENT_TONE[e.kind] ?? "neutral",
  }));

  return (
    <Card as="article" aria-labelledby="detail-pembayaran" className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2
            id="detail-pembayaran"
            tabIndex={-1}
            className="font-heading text-h3 font-semibold outline-none"
          >
            {p.member.full_name}
          </h2>
          <p className="text-xs text-text-muted">
            {[
              p.member.member_number ?? "Belum bernomor",
              p.member.cohort ? `Angkatan ${p.member.cohort}` : null,
              p.type === "ticket" && p.event_title ? `Tiket: ${p.event_title}` : PAYMENT_TYPE_LABEL[p.type],
            ]
              .filter(Boolean)
              .join(" | ")}
          </p>
        </div>
        <PaymentStatusBadge status={p.status} />
      </div>

      <FilePreview
        fileId={p.proof_file_id}
        alt={`Bukti transfer ${p.member.full_name}, versi ${p.proof_version}`}
        caption={`Bukti transfer | versi bukti ${p.proof_version}`}
      />

      <KeyValueList
        items={[
          {
            label: "Nominal tagihan",
            value: (
              <>
                <span className="font-semibold">{formatRupiah(p.amount)}</span>
                {p.lines.length > 1 ? (
                  <span className="block text-xs font-normal text-text-muted">
                    {p.lines.map((l) => `${l.label} ${formatRupiah(l.amount)}`).join(" + ")}
                  </span>
                ) : null}
              </>
            ),
          },
          {
            label: "Rekening tujuan",
            value: (
              <>
                {p.method.provider}
                <span className="block text-xs font-normal text-text-muted">
                  {p.method.account_number} a.n. {p.method.account_holder}
                </span>
              </>
            ),
          },
          { label: "Dikirim", value: formatDateTime(p.submitted_at) },
          {
            label: "Riwayat",
            value: rejections === 0 ? "Belum pernah ditolak" : `Pernah ditolak ${rejections} kali`,
          },
          ...(p.transfer_note
            ? [{ label: "Catatan transfer dari alumni", value: p.transfer_note, wide: true }]
            : []),
        ]}
      />

      <details className="group rounded-md border border-divider px-3">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-primary">
          Riwayat lengkap ({p.events.length})
        </summary>
        <Timeline label="Riwayat pembayaran" items={timeline} className="pb-3" />
      </details>

      {p.conflict_of_interest ? (
        <p role="note" className="rounded-md bg-warning-bg p-3 text-sm text-warning">
          Pembayaran ini milik akun alumni yang tertaut ke akun admin Anda. Mintalah pengurus lain untuk
          memutus.
        </p>
      ) : null}

      <DecisionSection
        key={`${p.id}:${p.proof_version}`}
        payment={p}
        onReload={() => void detail.refetch()}
      />

      <p className="text-xs leading-relaxed text-text-muted">
        Jika alumni mengganti bukti atau admin lain memutus lebih dulu, keputusan ini ditolak dan data terbaru
        dimuat ulang.
      </p>
    </Card>
  );
}

interface DecisionValues {
  funds_verified: boolean;
  reason: string;
}

interface DecisionVars {
  paymentId: string;
  decision: "approve" | "reject";
  expected_proof_version: number;
  expected_version: string;
  reason?: string;
}

function DecisionSection({ payment: p, onReload }: { payment: Detail; onReload: () => void }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [confirmReject, setConfirmReject] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const form = useForm<DecisionValues>({ defaultValues: { funds_verified: false, reason: "" } });
  const fundsVerified = form.watch("funds_verified");
  const reason = form.watch("reason");

  const decide = useApiMutation<Detail, DecisionVars, DecisionValues>({
    // Satu Idempotency-Key per niat: keputusan + versi yang dilihat + alasan. Muat ulang (versi baru) = niat baru.
    intent: (v) => v,
    setError: form.setError,
    request: (v, ctx) =>
      api.POST("/admin/payments/{paymentId}/decision", {
        params: { path: { paymentId: v.paymentId }, header: { "Idempotency-Key": ctx.idempotencyKey } },
        body: {
          decision: v.decision,
          expected_proof_version: v.expected_proof_version,
          expected_version: v.expected_version,
          ...(v.decision === "approve" ? { funds_verified: true } : { reason: v.reason ?? "" }),
        },
      }),
    onReloadLatest: () => {
      setConfirmReject(false);
      onReload();
      void queryClient.invalidateQueries({ queryKey: ["admin-payments"] });
    },
    onSuccess: (data) => {
      setConfirmReject(false);
      queryClient.setQueryData(paymentDetailKey(data.id), data);
      void queryClient.invalidateQueries({ queryKey: ["admin-payments"] });
      setMessage(
        data.status === "paid" ? "Pembayaran disetujui." : "Pembayaran ditolak dan alasan dikirim ke alumni.",
      );
    },
    onError: () => setConfirmReject(false),
  });

  const canDecide = auth.can("payments.decide") && p.status === "pending" && !p.conflict_of_interest;
  if (!canDecide)
    return message ? (
      <p role="status" className="rounded-md bg-success-bg p-3 text-sm font-medium text-success">
        {message}
      </p>
    ) : !auth.can("payments.decide") && p.status === "pending" ? (
      <p role="note" className="text-sm text-text-muted">
        Akun Anda hanya dapat melihat antrean. Keputusan memerlukan izin memutus pembayaran.
      </p>
    ) : null;

  const vars = (decision: DecisionVars["decision"]): DecisionVars => ({
    paymentId: p.id,
    decision,
    expected_proof_version: p.proof_version,
    expected_version: p.version,
    ...(decision === "reject" ? { reason: reason.trim() } : {}),
  });

  function startReject() {
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN) {
      form.setError("reason", {
        type: "manual",
        message: `Alasan penolakan minimal ${REASON_MIN} karakter dan tidak boleh hanya spasi.`,
      });
      form.setFocus("reason");
      return;
    }
    form.clearErrors("reason");
    setConfirmReject(true);
  }

  const errors = form.formState.errors;
  return (
    <form noValidate className="flex flex-col gap-4" onSubmit={(e) => e.preventDefault()}>
      <FormError message={errors.root?.server?.message} />
      <Checkbox
        boxed
        label={`Saya sudah memeriksa mutasi rekening ${p.method.provider} dan dana ${formatRupiah(p.amount)} sudah masuk.`}
        checked={fundsVerified}
        onCheckedChange={(v) => form.setValue("funds_verified", v, { shouldDirty: true })}
        error={errors.funds_verified?.message}
      />
      <Field label="Alasan penolakan (wajib bila menolak)" error={errors.reason?.message}>
        {(a11y) => (
          <Textarea
            {...a11y}
            {...form.register("reason")}
            rows={3}
            maxLength={REASON_MAX}
            placeholder="Contoh: nominal tidak sesuai, foto buram"
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Button variant="danger" disabled={decide.isPending} onClick={startReject}>
          Tolak
        </Button>
        <Button
          disabled={!fundsVerified}
          loading={decide.isPending && decide.variables?.decision === "approve"}
          loadingText="Menyimpan..."
          onClick={() => decide.mutate(vars("approve"))}
        >
          Setujui
        </Button>
      </div>
      {message ? (
        <p role="status" className="text-sm font-medium">
          {message}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmReject}
        onCancel={() => setConfirmReject(false)}
        onConfirm={() => decide.mutate(vars("reject"))}
        pending={decide.isPending}
        title="Tolak pembayaran?"
        description={`Pembayaran ${p.member.full_name} sebesar ${formatRupiah(p.amount)} akan ditolak. Alasan berikut dikirim ke alumni agar dapat mengunggah bukti baru.`}
        confirmLabel="Tolak pembayaran"
        acknowledgement="Saya sudah memeriksa bukti dan alasan penolakan sudah benar."
      >
        <blockquote className="rounded-md border-l-4 border-danger bg-danger-bg px-3 py-2 text-sm text-text">
          {reason.trim()}
        </blockquote>
      </ConfirmDialog>
    </form>
  );
}
