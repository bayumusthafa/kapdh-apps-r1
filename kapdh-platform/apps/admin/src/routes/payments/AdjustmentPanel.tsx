import { zodResolver } from "@hookform/resolvers/zod";
import type { components } from "@kapdh/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import type { ApiError } from "../../api/errors";
import { useApiMutation, useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Checkbox } from "../../components/ui/Choice";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { KeyValueList, type KeyValueItem } from "../../components/ui/DataDisplay";
import { Dialog } from "../../components/ui/Dialog";
import { FilePreview, FileUpload } from "../../components/ui/Files";
import { MoneyField } from "../../components/ui/FormatFields";
import { Field, FormError, FormField } from "../../components/ui/FormField";
import { Textarea } from "../../components/ui/Input";
import { ErrorState, Loading } from "../../components/ui/States";
import { cn } from "../../lib/cn";
import { formatDate, formatDateTime, formatRupiah } from "../../lib/format";
import { moneySchema, requiredText } from "../../lib/validation";
import { ADJUSTMENT_REASON_MAX, DestinationFields } from "./CreateAdjustmentDialog";
import {
  ADJUSTMENT_KIND_LABEL,
  AdjustmentStatusBadge,
  memberName,
  memberSubtitle,
  paymentTypeText,
} from "./labels";
import { compareMoney } from "./money";
import { adjustmentDetailKey, invalidateAdjustments, paymentDetailKey } from "./queries";

type Adjustment = components["schemas"]["AdminPaymentAdjustment"];
type FileRef = components["schemas"]["FileRef"];

export const ADJUSTMENT_DETAIL_POLL_MS = 60_000;

interface Notice {
  tone: "success" | "warning";
  message: string;
  seq: number;
}

/** `current` pada 409 berbentuk AdminPaymentAdjustment (kontrak penyesuaian). */
function asAdjustment(value: unknown): Adjustment | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Partial<Adjustment>;
  return typeof v.id === "string" && typeof v.version === "string" && typeof v.status === "string"
    ? (value as Adjustment)
    : null;
}

/**
 * Detail dan pemrosesan penyesuaian (D6, D2, PRD 3.4, 3.9):
 * - Rekening tujuan refund tampil HANYA selama pending dan hanya bila server mengirimnya (pemegang
 *   payments.decide tanpa konflik kepentingan); setelah selesai/dibatalkan rekening dihapus server (D2).
 * - Tandai selesai: refund wajib melampirkan bukti transfer (purpose adjustment_evidence); koreksi boleh tanpa
 *   bukti. Batalkan: alasan wajib dan konfirmasi dua langkah (PRD 4.5). Ubah: nominal, alasan dan rekening tujuan
 *   yang diterima lewat kontak dukungan resmi.
 * - Semua perubahan memakai If-Match `version`; konflik (mis. pemilik baru saja mengirim rekening tujuan) memuat
 *   data terbaru dan diumumkan, tidak menimpa diam-diam (AC F15-4).
 */
export function AdjustmentPanel({
  adjustmentId,
  focusRequest = 0,
}: {
  adjustmentId: string;
  focusRequest?: number;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: "/payments" });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  /**
   * Dialog yang terbuka beserta snapshot penyesuaian saat dibuka: If-Match dan isi dialog memakai versi yang
   * dilihat admin, sehingga perubahan pihak lain selama dialog terbuka (polling) ditolak 409, bukan ditimpa.
   */
  const [dialog, setDialog] = useState<{ type: "edit" | "complete" | "cancel"; base: Adjustment } | null>(
    null,
  );
  const ownVersion = useRef<string | null>(null);
  const shown = useRef<{ version: string; status: Adjustment["status"] } | null>(null);

  const detail = useApiQuery({
    queryKey: adjustmentDetailKey(adjustmentId),
    pollMs: ADJUSTMENT_DETAIL_POLL_MS,
    request: ({ signal, headers }) =>
      api.GET("/admin/payment-adjustments/{adjustmentId}", {
        params: { path: { adjustmentId } },
        signal,
        headers,
      }),
  });

  // Payment asal untuk `conflict_of_interest` yang dihitung server (PRD 2.3: pengurus tidak dapat menyesuaikan
  // payment milik alumni yang tertaut ke akunnya). Hanya diperlukan bila admin dapat memproses penyesuaian pending.
  const paymentId = detail.data?.payment_id ?? "";
  const payment = useApiQuery({
    queryKey: paymentDetailKey(paymentId),
    enabled: paymentId !== "" && detail.data?.status === "pending" && auth.can("payments.decide"),
    request: ({ signal, headers }) =>
      api.GET("/admin/payments/{paymentId}", { params: { path: { paymentId } }, signal, headers }),
  });

  const loaded = detail.data !== undefined;
  useEffect(() => {
    if (focusRequest === 0 || !loaded) return;
    headingRef.current?.focus();
  }, [focusRequest, loaded]);

  // Data berubah oleh pihak lain (pemilik mengirim rekening, admin lain memproses): umumkan dan jaga fokus.
  const data = detail.data;
  useEffect(() => {
    if (!data) return;
    const prev = shown.current;
    shown.current = { version: data.version, status: data.status };
    if (!prev || prev.version === data.version) return;
    if (ownVersion.current === data.version) return;
    const message =
      data.status !== prev.status
        ? `Penyesuaian ini sudah diproses pengurus lain: ${data.status === "completed" ? "selesai" : "dibatalkan"}.`
        : "Penyesuaian diperbarui pihak lain (mis. rekening tujuan baru dikirim pemilik). Periksa data terbaru.";
    setNotice((n) => ({ tone: "warning", message, seq: (n?.seq ?? 0) + 1 }));
    const active = document.activeElement;
    if (!active || active === document.body) headingRef.current?.focus();
  }, [data]);

  const doneSeq = notice?.tone === "success" ? notice.seq : 0;
  useEffect(() => {
    if (doneSeq > 0) headingRef.current?.focus();
  }, [doneSeq]);

  /** Hasil mutasi sendiri: cache diperbarui, daftar dan ringkasan dimuat ulang, hasil diumumkan. */
  function onDone(result: Adjustment, message: string) {
    ownVersion.current = result.version;
    queryClient.setQueryData(adjustmentDetailKey(result.id), result);
    invalidateAdjustments(queryClient, result.payment_id);
    setDialog(null);
    setNotice((n) => ({ tone: "success", message, seq: (n?.seq ?? 0) + 1 }));
  }

  /** 409 (status/versi berubah): tampilkan keadaan terbaru dari `current`, tutup dialog. */
  function onConflict(error: ApiError) {
    setDialog(null);
    const current = asAdjustment(error.current);
    if (current) queryClient.setQueryData(adjustmentDetailKey(current.id), current);
    else void detail.refetch();
    invalidateAdjustments(queryClient);
  }

  if (detail.isPending)
    return (
      <Card className="p-2">
        <Loading label="Memuat detail penyesuaian..." rows={6} />
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

  const a = detail.data;
  const pending = a.status === "pending";
  const mayDecide = pending && auth.can("payments.decide");
  // Konflik kepentingan (PRD 2.3) dihitung server pada payment asal (`conflict_of_interest`); selama belum
  // diketahui tombol proses tidak ditampilkan agar admin tertaut tidak mengisi dialog yang pasti ditolak.
  const conflict = payment.data?.conflict_of_interest ?? null;
  const canProcess = mayDecide && (conflict === false || payment.isError);

  return (
    <Card as="article" aria-labelledby="detail-penyesuaian" className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2
            ref={headingRef}
            id="detail-penyesuaian"
            tabIndex={-1}
            className="font-heading text-h3 font-semibold outline-none"
          >
            {ADJUSTMENT_KIND_LABEL[a.kind]} {formatRupiah(a.amount)}
          </h2>
          <p className="text-xs text-text-muted">
            {memberName(a.payment.member)} | {memberSubtitle(a.payment.member)} | {paymentTypeText(a.payment)}
          </p>
        </div>
        <AdjustmentStatusBadge status={a.status} />
      </div>

      <KeyValueList items={adjustmentItems(a)} />

      {a.kind === "refund" && pending ? <RefundDestination a={a} /> : null}

      {a.evidence_file_id ? (
        <FilePreview
          fileId={a.evidence_file_id}
          alt={`Bukti penyelesaian ${ADJUSTMENT_KIND_LABEL[a.kind].toLowerCase()} ${memberName(a.payment.member)}`}
          caption="Bukti penyelesaian"
          heightClass="h-40"
        />
      ) : null}

      {canProcess ? (
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => setDialog({ type: "complete", base: a })}>Tandai selesai</Button>
          <Button variant="outline" onClick={() => setDialog({ type: "edit", base: a })}>
            Ubah
          </Button>
          <Button variant="danger" onClick={() => setDialog({ type: "cancel", base: a })}>
            Batalkan
          </Button>
        </div>
      ) : mayDecide && conflict === true ? (
        <p role="note" className="rounded-md bg-warning-bg p-3 text-sm text-warning">
          Pembayaran asal milik akun alumni yang tertaut ke akun admin Anda. Mintalah pengurus lain untuk
          memproses penyesuaian ini.
        </p>
      ) : mayDecide ? (
        <p className="text-sm text-text-muted">Memeriksa pembayaran asal...</p>
      ) : pending && !auth.can("payments.decide") ? (
        <p className="text-sm text-text-muted">
          Akun Anda hanya dapat melihat penyesuaian. Memproses refund memerlukan izin memutus pembayaran.
        </p>
      ) : null}

      <Button
        variant="ghost"
        size="sm"
        className="flex-row-reverse self-start"
        leftIcon={<ArrowRight aria-hidden="true" className="size-4" />}
        onClick={() => void navigate({ search: { tab: "verify", payment: a.payment_id } })}
      >
        Buka pembayaran asal
      </Button>

      <p
        role="status"
        aria-live="polite"
        className={
          notice
            ? cn(
                "rounded-md p-3 text-sm font-medium",
                notice.tone === "success" ? "bg-success-bg text-success" : "bg-warning-bg text-warning",
              )
            : undefined
        }
      >
        {notice?.message ?? ""}
      </p>

      {canProcess || dialog ? (
        <>
          <CompleteDialog
            open={dialog?.type === "complete"}
            adjustment={dialog?.base ?? a}
            onClose={() => setDialog(null)}
            onDone={onDone}
            onConflict={onConflict}
          />
          <EditDialog
            open={dialog?.type === "edit"}
            adjustment={dialog?.base ?? a}
            onClose={() => setDialog(null)}
            onDone={onDone}
            onConflict={onConflict}
          />
          <CancelDialog
            open={dialog?.type === "cancel"}
            adjustment={dialog?.base ?? a}
            onClose={() => setDialog(null)}
            onDone={onDone}
            onConflict={onConflict}
          />
        </>
      ) : null}
    </Card>
  );
}

function adjustmentItems(a: Adjustment): KeyValueItem[] {
  const items: KeyValueItem[] = [
    {
      label: "Pembayaran asal",
      value: (
        <>
          {paymentTypeText(a.payment)} {formatRupiah(a.payment.amount)}
          <span className="block text-xs font-normal text-text-muted">
            Lunas{a.payment.decided_at ? ` ${formatDate(a.payment.decided_at)}` : ""}; status lunas tidak
            berubah.
          </span>
        </>
      ),
    },
    {
      label: "Tenggat",
      value: a.due_at ? (
        <span className="flex flex-wrap items-center gap-1.5">
          {formatDate(a.due_at)}
          {a.overdue ? <Badge tone="danger">Lewat tenggat</Badge> : null}
        </span>
      ) : (
        "Tanpa tenggat (koreksi)"
      ),
    },
    {
      label: "Dicatat",
      value: `${formatDateTime(a.created_at)} oleh ${a.created_by ? a.created_by.display_name : "sistem (otomatis, D6)"}`,
      wide: true,
    },
    { label: "Alasan (internal)", value: a.reason, wide: true },
  ];
  if (a.completed_at)
    items.push({
      label: "Selesai",
      value: `${formatDateTime(a.completed_at)}${a.completed_by ? ` oleh ${a.completed_by.display_name}` : ""}`,
      wide: true,
    });
  if (a.cancelled_at)
    items.push({
      label: "Dibatalkan",
      value: `${formatDateTime(a.cancelled_at)}${a.cancelled_by ? ` oleh ${a.cancelled_by.display_name}` : ""}${
        a.cancel_reason ? ` | Alasan: ${a.cancel_reason}` : ""
      }`,
      wide: true,
    });
  return items;
}

/**
 * Rekening tujuan refund selama pending (D6). Nilainya hanya dikirim server kepada pemegang payments.decide tanpa
 * konflik kepentingan; selain itu hanya penanda `has_refund_destination` (D2). Tidak pernah disalin ke log/audit.
 */
function RefundDestination({ a }: { a: Adjustment }) {
  const d = a.refund_destination;
  return (
    <section
      aria-labelledby="rekening-refund"
      className="flex flex-col gap-2 rounded-md border border-divider p-3"
    >
      <h3 id="rekening-refund" className="text-sm font-semibold">
        Rekening tujuan refund
      </h3>
      {d ? (
        <>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex flex-col">
              <dt className="text-xs text-text-muted">Bank atau e-wallet</dt>
              <dd className="font-medium">{d.provider}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-xs text-text-muted">Nomor rekening</dt>
              <dd className="font-medium">{d.account_number}</dd>
            </div>
            <div className="flex flex-col sm:col-span-2">
              <dt className="text-xs text-text-muted">Atas nama</dt>
              <dd className="font-medium">{d.account_holder}</dd>
            </div>
          </dl>
          <p className="text-xs text-text-muted">
            Rekening ini dihapus otomatis setelah refund ditandai selesai atau dibatalkan (D2).
          </p>
        </>
      ) : a.has_refund_destination ? (
        <p className="text-sm text-text-muted">
          Rekening tujuan sudah dikirim pemilik. Rinciannya hanya terlihat oleh pengurus berizin memutus
          pembayaran yang tidak berkonflik kepentingan.
        </p>
      ) : a.payment.member ? (
        <p className="text-sm text-text-muted">
          Menunggu rekening tujuan dari pemilik. Pemilik sudah diberi notifikasi untuk mengirim rekening lewat
          aplikasi; rekening yang diterima lewat kontak dukungan resmi dapat dicatat lewat Ubah.
        </p>
      ) : (
        <p className="text-sm text-text-muted">
          Akun pemilik sudah dihapus. Catat rekening pengirim yang terlihat di mutasi lewat Ubah.
        </p>
      )}
    </section>
  );
}

interface DialogProps {
  open: boolean;
  adjustment: Adjustment;
  onClose: () => void;
  onDone: (result: Adjustment, message: string) => void;
  onConflict: (error: ApiError) => void;
}

interface CompleteVars {
  id: string;
  version: string;
  evidenceFileId: string | null;
}

/** Tandai selesai (kontrak adminCompletePaymentAdjustment): refund wajib bukti transfer (D6). */
function CompleteDialog({ open, adjustment: a, onClose, onDone, onConflict }: DialogProps) {
  const [evidence, setEvidence] = useState<FileRef | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [transferred, setTransferred] = useState(false);
  useEffect(() => {
    if (open) {
      setEvidence(null);
      setEvidenceError(null);
      setTransferred(false);
    }
  }, [open]);

  const complete = useApiMutation<Adjustment, CompleteVars>({
    request: (v, ctx) =>
      api.POST("/admin/payment-adjustments/{adjustmentId}/complete", {
        params: {
          path: { adjustmentId: v.id },
          header: { "If-Match": v.version, "Idempotency-Key": ctx.idempotencyKey },
        },
        body: v.evidenceFileId ? { evidence_file_id: v.evidenceFileId } : {},
      }),
    onReloadLatest: (error) => onConflict(error),
    onError: (error) => {
      const message = error.fieldErrors.evidence_file_id?.join(" ");
      if (message) setEvidenceError(message);
      else if (error.code === "FILE_INVALID") setEvidenceError(error.message);
    },
    onSuccess: (result) =>
      onDone(
        result,
        result.kind === "refund"
          ? "Refund ditandai selesai. Rekening tujuan dihapus dan pemilik diberi notifikasi."
          : "Koreksi ditandai selesai.",
      ),
  });

  const refund = a.kind === "refund";
  const needsEvidence = refund && !a.evidence_file_id && evidence === null;
  const d = a.refund_destination;

  function submit() {
    if (needsEvidence) {
      setEvidenceError("Lampirkan bukti transfer refund sebelum menandai selesai.");
      return;
    }
    complete.mutate({ id: a.id, version: a.version, evidenceFileId: evidence?.id ?? null });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissable={!complete.isPending}
      title={refund ? "Tandai refund selesai" : "Tandai koreksi selesai"}
      description={
        refund
          ? `Refund ${formatRupiah(a.amount)} untuk ${memberName(a.payment.member)}. Setelah selesai, rekening tujuan dihapus (D2) dan tidak dapat dibuka lagi.`
          : `Koreksi ${formatRupiah(a.amount)} untuk ${memberName(a.payment.member)}.`
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={complete.isPending}>
            Batal
          </Button>
          <Button
            loading={complete.isPending}
            loadingText="Menyimpan..."
            disabled={refund && !transferred}
            onClick={submit}
          >
            Tandai selesai
          </Button>
        </>
      }
    >
      {refund && d ? (
        <p className="rounded-md bg-green-50 p-3 text-sm">
          Transfer {formatRupiah(a.amount)} ke {d.provider} {d.account_number} a.n. {d.account_holder}.
        </p>
      ) : refund ? (
        <p role="note" className="rounded-md bg-warning-bg p-3 text-sm text-warning">
          {a.has_refund_destination
            ? "Rincian rekening tujuan tidak ditampilkan untuk akun Anda. Pastikan dana ditransfer ke rekening yang dikirim pemilik."
            : `Belum ada rekening tujuan yang tercatat. Catat rekening lewat Ubah bila diterima lewat kontak dukungan resmi. Setelah refund ditandai selesai, ${a.payment.member ? "pemilik tidak dapat lagi mengirim rekening tujuan" : "rekening tujuan tidak dapat dicatat lagi"}.`}
        </p>
      ) : null}
      {a.evidence_file_id ? (
        <p className="text-sm text-text-muted">
          Bukti penyelesaian sudah terlampir. Unggah berkas baru hanya bila ingin menggantinya.
        </p>
      ) : null}
      <FileUpload
        purpose="adjustment_evidence"
        label={refund ? "Bukti transfer refund" : "Bukti pendukung (opsional)"}
        required={needsEvidence || (refund && !a.evidence_file_id)}
        value={evidence}
        onChange={(f) => {
          setEvidence(f);
          if (f) setEvidenceError(null);
        }}
        error={evidenceError}
        previewAlt="Pratinjau bukti penyelesaian"
      />
      {refund ? (
        <Checkbox
          label={
            d
              ? "Dana refund sudah saya transfer ke rekening tujuan di atas."
              : "Dana refund sudah saya transfer ke rekening yang sudah saya pastikan benar, walau rekeningnya tidak tercatat di sini."
          }
          checked={transferred}
          onCheckedChange={setTransferred}
          disabled={complete.isPending}
        />
      ) : null}
    </Dialog>
  );
}

interface CancelVars {
  id: string;
  version: string;
  reason: string;
}

/** Batalkan penyesuaian pending (kontrak adminCancelPaymentAdjustment): alasan wajib, konfirmasi dua langkah. */
function CancelDialog({ open, adjustment: a, onClose, onDone, onConflict }: DialogProps) {
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  /** Alasan ditolak: fokus ke isian alasan setelah galat dirender dan permintaan selesai (N-11, PRD 4.5). */
  const [focusReason, setFocusReason] = useState(false);
  useEffect(() => {
    if (open) {
      setReason("");
      setReasonError(null);
      setFocusReason(false);
    }
  }, [open]);

  const cancel = useApiMutation<Adjustment, CancelVars>({
    request: (v, ctx) =>
      api.POST("/admin/payment-adjustments/{adjustmentId}/cancel", {
        params: {
          path: { adjustmentId: v.id },
          header: { "If-Match": v.version, "Idempotency-Key": ctx.idempotencyKey },
        },
        body: { reason: v.reason },
      }),
    onReloadLatest: (error) => onConflict(error),
    onError: (error) => {
      const message = error.fieldErrors.reason?.join(" ");
      if (message) {
        setReasonError(message);
        setFocusReason(true);
      }
    },
    onSuccess: (result) =>
      onDone(
        result,
        result.kind === "refund"
          ? "Refund dibatalkan. Rekening tujuan dihapus dan pemilik diberi notifikasi dengan arahan ke kontak dukungan."
          : "Koreksi dibatalkan.",
      ),
  });

  const cancelPending = cancel.isPending;
  useEffect(() => {
    if (!focusReason || cancelPending) return;
    setFocusReason(false);
    reasonRef.current?.focus();
  }, [focusReason, cancelPending]);

  function confirm() {
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      setReasonError("Alasan pembatalan minimal 3 karakter dan tidak boleh hanya spasi.");
      setFocusReason(true);
      return;
    }
    setReasonError(null);
    cancel.mutate({ id: a.id, version: a.version, reason: trimmed });
  }

  return (
    <ConfirmDialog
      open={open}
      onCancel={onClose}
      onConfirm={confirm}
      pending={cancel.isPending}
      title={`Batalkan ${ADJUSTMENT_KIND_LABEL[a.kind].toLowerCase()}?`}
      description={`${ADJUSTMENT_KIND_LABEL[a.kind]} ${formatRupiah(a.amount)} untuk ${memberName(a.payment.member)} dibatalkan. Alasan bersifat internal; pemilik hanya menerima pemberitahuan baku.`}
      confirmLabel="Batalkan penyesuaian"
      acknowledgement="Saya memahami penyesuaian ini tidak dapat diproses lagi setelah dibatalkan."
    >
      <Field label="Alasan pembatalan" required error={reasonError}>
        {(a11y) => (
          <Textarea
            {...a11y}
            ref={reasonRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={ADJUSTMENT_REASON_MAX}
            disabled={cancel.isPending}
          />
        )}
      </Field>
    </ConfirmDialog>
  );
}

const destinationSchema = z.object({
  provider: z.string().max(80, "Maksimal 80 karakter."),
  account_number: z.string().max(64, "Maksimal 64 karakter."),
  account_holder: z.string().max(120, "Maksimal 120 karakter."),
});

function editSchema(kind: Adjustment["kind"], paymentAmount: string) {
  return z
    .object({
      amount: moneySchema,
      reason: requiredText("Alasan", 3, ADJUSTMENT_REASON_MAX),
      with_destination: z.boolean(),
      refund_destination: destinationSchema,
    })
    .superRefine((v, ctx) => {
      if (kind !== "refund") return;
      if (compareMoney(v.amount, "0.00") === 0)
        ctx.addIssue({ code: "custom", path: ["amount"], message: "Nominal refund harus lebih dari 0." });
      if (compareMoney(v.amount, paymentAmount) === 1)
        ctx.addIssue({
          code: "custom",
          path: ["amount"],
          message: `Melebihi nominal pembayaran (${formatRupiah(paymentAmount)}).`,
        });
      if (!v.with_destination) return;
      for (const key of ["provider", "account_number", "account_holder"] as const)
        if (v.refund_destination[key].trim() === "")
          ctx.addIssue({ code: "custom", path: ["refund_destination", key], message: "Wajib diisi." });
    });
}

type EditValues = z.infer<ReturnType<typeof editSchema>>;

interface EditVars {
  id: string;
  version: string;
  body: components["schemas"]["UpdatePaymentAdjustmentRequest"];
}

function editDefaults(a: Adjustment): EditValues {
  return {
    amount: a.amount,
    reason: a.reason,
    with_destination: a.refund_destination !== null,
    refund_destination: a.refund_destination ?? { provider: "", account_number: "", account_holder: "" },
  };
}

/**
 * Ubah penyesuaian pending (kontrak adminUpdatePaymentAdjustment, PATCH): hanya field yang berubah dikirim.
 * Rekening tujuan dapat dicatat dari kontak dukungan resmi atau dihapus (null); server memeriksa ulang batas total
 * refund terhadap penyesuaian lain atas payment yang sama.
 */
function EditDialog({ open, adjustment: a, onClose, onDone, onConflict }: DialogProps) {
  const schema = useMemo(() => editSchema(a.kind, a.payment.amount), [a.kind, a.payment.amount]);
  const form = useForm<EditValues>({ resolver: zodResolver(schema), defaultValues: editDefaults(a) });
  const { reset } = form;
  // Hanya saat dibuka: data terbaru yang datang saat dialog terbuka tidak menimpa isian admin (konflik versi
  // tetap ditolak server lewat If-Match).
  const latest = useRef(a);
  latest.current = a;
  /**
   * Perubahan yang akan MENGHAPUS rekening tujuan tersimpan (refund_destination null) menunggu konfirmasi dua
   * langkah: rekening kiriman pemilik hilang permanen dan pemilik harus mengirim ulang (PRD 4.5, D2).
   */
  const [removal, setRemoval] = useState<EditVars["body"] | null>(null);
  useEffect(() => {
    if (!open) return;
    reset(editDefaults(latest.current));
    setRemoval(null);
  }, [open, reset]);

  const save = useApiMutation<Adjustment, EditVars, EditValues>({
    setError: form.setError,
    request: (v) =>
      api.PATCH("/admin/payment-adjustments/{adjustmentId}", {
        params: { path: { adjustmentId: v.id }, header: { "If-Match": v.version } },
        body: v.body,
      }),
    onReloadLatest: (error) => {
      setRemoval(null);
      onConflict(error);
    },
    // Galat lain (mis. VALIDATION_ERROR): konfirmasi ditutup agar galat isian di formulir terlihat.
    onError: () => setRemoval(null),
    onSuccess: (result, v) => {
      setRemoval(null);
      onDone(
        result,
        v.body.refund_destination === null
          ? "Penyesuaian diperbarui. Rekening tujuan refund dihapus."
          : "Penyesuaian diperbarui.",
      );
    },
  });

  function submit(v: EditValues) {
    const body: EditVars["body"] = {};
    if (compareMoney(v.amount, a.amount) !== 0) body.amount = v.amount;
    if (v.reason !== a.reason) body.reason = v.reason;
    if (a.kind === "refund") {
      if (v.with_destination) {
        const next = {
          provider: v.refund_destination.provider.trim(),
          account_number: v.refund_destination.account_number.trim(),
          account_holder: v.refund_destination.account_holder.trim(),
        };
        const prev = a.refund_destination;
        if (
          !prev ||
          prev.provider !== next.provider ||
          prev.account_number !== next.account_number ||
          prev.account_holder !== next.account_holder
        )
          body.refund_destination = next;
      } else if (a.refund_destination) body.refund_destination = null;
    }
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    if (body.refund_destination === null) {
      setRemoval(body);
      return;
    }
    save.mutate({ id: a.id, version: a.version, body });
  }

  const withDestination = form.watch("with_destination");
  const errors = form.formState.errors;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissable={!save.isPending}
      title={`Ubah ${ADJUSTMENT_KIND_LABEL[a.kind].toLowerCase()}`}
      description="Hanya penyesuaian yang masih menunggu proses yang dapat diubah. Perubahan tercatat di audit tanpa isi rekening."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Batal
          </Button>
          <Button type="submit" form="ubah-penyesuaian" loading={save.isPending} loadingText="Menyimpan...">
            Simpan perubahan
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form
          id="ubah-penyesuaian"
          noValidate
          className="flex flex-col gap-4"
          onSubmit={form.handleSubmit(submit)}
        >
          <FormError message={errors.root?.server?.message} />
          <FormField<EditValues, "amount"> name="amount" label="Nominal" required>
            {(field, a11y) => (
              <MoneyField
                {...a11y}
                name={field.name}
                ref={field.ref}
                value={field.value}
                onValueChange={field.onChange}
                onBlur={field.onBlur}
              />
            )}
          </FormField>
          <FormField<EditValues, "reason"> name="reason" label="Alasan (internal pengurus)" required>
            {(field, a11y) => (
              <Textarea {...field} {...a11y} rows={3} maxLength={ADJUSTMENT_REASON_MAX} showCount />
            )}
          </FormField>
          {a.kind === "refund" ? (
            <>
              <Checkbox
                label="Catat rekening tujuan refund"
                description={
                  a.refund_destination
                    ? "Hapus centang untuk menghapus rekening tujuan yang tersimpan."
                    : "Gunakan hanya untuk rekening yang diterima lewat kontak dukungan resmi."
                }
                checked={withDestination}
                onCheckedChange={(v) => form.setValue("with_destination", v, { shouldDirty: true })}
              />
              {withDestination ? <DestinationFields /> : null}
            </>
          ) : null}
        </form>
      </FormProvider>
      <ConfirmDialog
        open={removal !== null}
        onCancel={() => setRemoval(null)}
        onConfirm={() => {
          if (removal) save.mutate({ id: a.id, version: a.version, body: removal });
        }}
        pending={save.isPending}
        title="Hapus rekening tujuan refund?"
        description={`Rekening tujuan refund ${formatRupiah(a.amount)} untuk ${memberName(a.payment.member)} dihapus permanen dan tidak dapat dipulihkan. Pemilik perlu mengirim ulang rekening lewat aplikasi, atau pengurus mencatatnya lagi dari kontak dukungan resmi.`}
        confirmLabel="Hapus rekening dan simpan"
        acknowledgement="Saya memahami rekening tujuan yang tersimpan dihapus permanen."
      />
    </Dialog>
  );
}
