import type { components } from "@kapdh/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { api } from "../../api/client";
import { useApiMutation, useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";
import { Badge, PAYMENT_STATUS, PaymentStageBadge, TicketStatusBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Checkbox } from "../../components/ui/Choice";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { KeyValueList, type KeyValueItem } from "../../components/ui/DataDisplay";
import { FilePreview } from "../../components/ui/Files";
import { Field, FormError } from "../../components/ui/FormField";
import { Textarea } from "../../components/ui/Input";
import { ErrorState, Loading } from "../../components/ui/States";
import { cn } from "../../lib/cn";
import { formatDate, formatDateTime, formatRupiah } from "../../lib/format";
import { PAYMENT_TYPE_LABEL } from "../../lib/labels";
import { memberName, memberSubtitle, METHOD_KIND_LABEL } from "./labels";
import { PaymentAdjustmentsSection } from "./PaymentAdjustmentsSection";
import { PaymentHistory } from "./PaymentHistory";
import { PAYMENTS_KEY, paymentDetailKey } from "./queries";

export { paymentDetailKey } from "./queries";

type Detail = components["schemas"]["AdminPaymentDetail"];

/** Pesan di region live panel: hasil tindakan sendiri (success) atau perubahan oleh pihak lain (warning). */
interface Notice {
  tone: "success" | "warning";
  message: string;
  seq: number;
}

/** Nama pemilik untuk judul dan teks; "Akun dihapus" bila datanya sudah dianonimkan (AC F14-4). */
export function ownerName(p: Pick<Detail, "member">): string {
  return memberName(p.member);
}

/** Polling detail yang sedang dibuka (sama dengan antrean); hanya refetch berkala berlabel latar (AC F02-5). */
export const DETAIL_POLL_MS = 60_000;

export const REASON_MIN = 3;
export const REASON_MAX = 500;

/**
 * Panel detail dan keputusan pembayaran (F-04, AC F04-2..F04-4, prototipe screen_8).
 * - Bentuk data AdminPaymentDetail final (C3): bukti aktif di objek `proof` (gambar atau PDF lewat URL bertanda
 *   tangan), tahap `stage` dari server, tombol mengikuti `actions` (`can_decide`, `can_cancel`, `can_adjust`),
 *   pemilik terhapus tampil "Akun dihapus" tanpa berkas bukti (AC F14-4), dan tiket/event yang sudah dibatalkan
 *   menampilkan akibat persetujuan termasuk refund otomatis D6.
 * - Histori lengkap memuat alasan penolakan sebelumnya dan berkas bukti versi lama (U-02, AC F03-3); snapshot
 *   rekening tujuan dan versi biaya ditampilkan apa adanya (AC F03-5, F15-3).
 * - Bila antrean melihat versi bukti lebih baru, detail langsung dimuat ulang. Detail juga di-polling (header
 *   latar, AC F02-5) karena bukti pengganti memperbarui `submitted_at` sehingga baris dapat pindah halaman.
 * - Formulir keputusan diberi key `id:proof_version:version` sehingga centang "dana sudah masuk" dan alasan SELALU
 *   direset saat bukti ATAU versi data berubah; admin wajib memeriksa ulang (AC F04-4).
 * - Konflik (bukti diganti/admin lain lebih dulu) → data terbaru dimuat ulang, tidak menimpa diam-diam (AC F04-3).
 * - Fokus dan pengumuman (N-11, PRD 4.5): setelah admin memilih baris, fokus pindah ke judul detail begitu detail
 *   termuat. Setelah tindakan berhasil, atau setelah data terbaru dimuat ulang karena konflik/bukti diganti
 *   (formulir dipasang ulang sehingga tombol yang difokus hilang), fokus dipindah ke judul dan alasannya
 *   diumumkan lewat region live yang selalu ada.
 */
export function PaymentDecisionPanel({
  paymentId,
  listProofVersion,
  focusRequest = 0,
}: {
  paymentId: string;
  listProofVersion?: number;
  /** Naik setiap admin memilih baris; > 0 berarti fokus dipindah ke judul detail setelah detail termuat. */
  focusRequest?: number;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** Versi hasil tindakan admin ini sendiri; perubahan data ke versi itu bukan "diubah pihak lain". */
  const ownActionVersion = useRef<string | null>(null);
  /** Versi terakhir yang ditampilkan, untuk mendeteksi data yang berubah setelah dimuat ulang. */
  const shown = useRef<{ version: string; proof: number; status: Detail["status"] } | null>(null);
  const detail = useApiQuery({
    queryKey: paymentDetailKey(paymentId),
    pollMs: DETAIL_POLL_MS,
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

  // Judul baru ada setelah detail termuat; fokus dipindah saat itu (bukan saat klik, ketika panel masih memuat).
  const loaded = detail.data !== undefined;
  useEffect(() => {
    if (focusRequest === 0 || !loaded) return;
    const heading = headingRef.current;
    heading?.focus();
    if (typeof heading?.scrollIntoView === "function") heading.scrollIntoView({ block: "nearest" });
  }, [focusRequest, loaded]);

  // Data berubah setelah dimuat ulang (konflik keputusan, bukti baru, atau versi data naik): umumkan alasannya.
  // Formulir keputusan memakai key id:proof_version:version sehingga dipasang ulang; bila fokus ikut hilang
  // (jatuh ke <body>), kembalikan ke judul panel agar pengguna keyboard tidak tersesat.
  const data = detail.data;
  useEffect(() => {
    if (!data) return;
    const prev = shown.current;
    shown.current = { version: data.version, proof: data.proof_version, status: data.status };
    if (!prev || (prev.version === data.version && prev.proof === data.proof_version)) return;
    if (ownActionVersion.current === data.version) return;
    const message =
      data.proof_version !== prev.proof
        ? `Bukti transfer diganti alumni (versi ${data.proof_version}). Centang dana dan alasan dikosongkan; periksa ulang bukti sebelum memutus.`
        : data.status !== prev.status
          ? data.status === "cancelled"
            ? "Pembayaran ini sudah dibatalkan."
            : `Pembayaran ini sudah diputus admin lain: ${PAYMENT_STATUS[data.status].label}.`
          : data.stage === "awaiting_review"
            ? "Data pembayaran diperbarui. Centang dana dan alasan dikosongkan; periksa ulang sebelum memutus."
            : "Data pembayaran diperbarui.";
    setNotice((n) => ({ tone: "warning", message, seq: (n?.seq ?? 0) + 1 }));
    const active = document.activeElement;
    if (!active || active === document.body) headingRef.current?.focus();
  }, [data]);

  // Tindakan berhasil: tombol yang difokus ikut hilang bersama formulir, jadi fokus dipindah ke judul panel.
  // Efek pasif berjalan setelah dialog konfirmasi selesai ditutup (pemulihan fokusnya gagal karena pemicu hilang).
  const doneSeq = notice?.tone === "success" ? notice.seq : 0;
  useEffect(() => {
    if (doneSeq > 0) headingRef.current?.focus();
  }, [doneSeq]);

  function onDone(message: string, version?: string) {
    if (version) ownActionVersion.current = version;
    setNotice((n) => ({ tone: "success", message, seq: (n?.seq ?? 0) + 1 }));
  }

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
  const name = ownerName(p);
  // Berkas bukti terhapus bersama akun pemilik walau versi bukti >= 1 (D2, AC F14-4).
  const proofDeleted = p.proof === null && p.proof_version > 0;
  const awaitingDecision = p.stage === "awaiting_review";
  // Hanya sebelum keputusan: tiket yang ditolak juga menjadi cancelled (AC F09-4) dan tidak perlu peringatan ini.
  const ticketCancelled = awaitingDecision && p.ticket !== null && p.ticket.ticket_status === "cancelled";

  return (
    <Card as="article" aria-labelledby="detail-pembayaran" className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2
            ref={headingRef}
            id="detail-pembayaran"
            tabIndex={-1}
            className="font-heading text-h3 font-semibold outline-none"
          >
            {name}
          </h2>
          <p className="text-xs text-text-muted">
            {[
              memberSubtitle(p.member),
              p.member ? `Angkatan ${p.member.cohort}` : null,
              p.type === "ticket" && p.event_title ? `Tiket: ${p.event_title}` : PAYMENT_TYPE_LABEL[p.type],
            ]
              .filter(Boolean)
              .join(" | ")}
          </p>
        </div>
        <PaymentStageBadge stage={p.stage} />
      </div>

      {proofDeleted ? (
        <p role="note" className="rounded-md bg-neutral-bg p-3 text-sm text-text">
          Akun pemilik sudah dihapus sehingga berkas bukti dan catatan transfer ikut dihapus.
          {awaitingDecision
            ? " Cocokkan nominal, tanggal dan referensi pembayaran ini dengan mutasi rekening tujuan sebelum memutus."
            : ""}
        </p>
      ) : (
        <FilePreview
          fileId={p.proof?.file_id ?? null}
          mime={p.proof?.mime}
          alt={`Bukti transfer ${name}, versi ${p.proof_version}`}
          caption={`Bukti transfer | versi bukti ${p.proof_version}`}
        />
      )}

      {ticketCancelled ? (
        <p role="note" className="rounded-md bg-warning-bg p-3 text-sm text-warning">
          {p.ticket?.event_status === "cancelled"
            ? "Event sudah dibatalkan pengurus."
            : "Tiket sudah dibatalkan."}{" "}
          Menyetujui berarti dana diterima; tiket tidak diaktifkan kembali dan QR tidak diterbitkan.
          {p.refund_on_approve
            ? ` Persetujuan otomatis mencatat refund penuh ${formatRupiah(p.amount)} sebagai penyesuaian (D6).`
            : ""}
        </p>
      ) : null}

      <KeyValueList items={detailItems(p)} />

      <PaymentHistory events={p.events} ownerLabel={name} activeProofVersion={p.proof_version} />

      {p.conflict_of_interest ? (
        <p role="note" className="rounded-md bg-warning-bg p-3 text-sm text-warning">
          Pembayaran ini milik akun alumni yang tertaut ke akun admin Anda. Mintalah pengurus lain untuk
          memutus atau memproses penyesuaiannya.
        </p>
      ) : null}

      <DecisionSection
        key={`${p.id}:${p.proof_version}:${p.version}`}
        payment={p}
        onReload={() => void detail.refetch()}
        onDecided={onDone}
      />

      <CancelInstruction payment={p} onReload={() => void detail.refetch()} onCancelled={onDone} />

      <PaymentAdjustmentsSection
        payment={p}
        onReload={() => void detail.refetch()}
        onCreated={(message) => onDone(message)}
      />

      {/* Region live selalu ada (awalnya kosong) agar hasil tindakan dan muat ulang pasti diumumkan. */}
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

      <p className="text-xs leading-relaxed text-text-muted">
        Jika alumni mengganti bukti atau admin lain memutus lebih dulu, keputusan ini ditolak dan data terbaru
        dimuat ulang.
      </p>
    </Card>
  );
}

/** Butir ringkasan detail (prototipe screen_8 + snapshot, versi dan histori keputusan). */
function detailItems(p: Detail): KeyValueItem[] {
  const items: KeyValueItem[] = [
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
          {METHOD_KIND_LABEL[p.method.kind]} {p.method.provider}
          <span className="block text-xs font-normal text-text-muted">
            {p.method.account_number} a.n. {p.method.account_holder}
          </span>
          {!p.method_active ? (
            <span className="block text-xs font-normal text-text-muted">
              Metode asal sudah nonaktif; snapshot ini tetap berlaku untuk pembayaran ini.
            </span>
          ) : null}
        </>
      ),
    },
    {
      label: "Dikirim",
      value: p.submitted_at ? formatDateTime(p.submitted_at) : "Belum ada bukti",
    },
    {
      label: "Riwayat",
      value: p.rejection_count === 0 ? "Belum pernah ditolak" : `Pernah ditolak ${p.rejection_count} kali`,
    },
    {
      label: "Versi bukti",
      value: p.proof_version === 0 ? "Belum ada bukti" : `Versi ${p.proof_version}`,
    },
  ];
  if (p.settings_version !== null)
    items.push({
      label: "Versi biaya",
      value: (
        <>
          Versi {p.settings_version}
          <span className="block text-xs font-normal text-text-muted">
            Nominal mengikuti biaya saat tagihan dibuat.
          </span>
        </>
      ),
    });
  if (p.review_due_at && p.stage === "awaiting_review")
    items.push({
      label: "Batas review",
      value: (
        <span className="flex flex-wrap items-center gap-1.5">
          {formatDateTime(p.review_due_at)}
          {p.overdue ? <Badge tone="warning">Lewat batas</Badge> : null}
        </span>
      ),
    });
  if (p.ticket)
    items.push({
      label: "Event",
      value: (
        <>
          {p.ticket.event_title}
          <span className="block text-xs font-normal text-text-muted">
            {formatDateTime(p.ticket.event_starts_at, p.ticket.event_timezone)}
          </span>
          <span className="mt-1 block">
            <TicketStatusBadge status={p.ticket.ticket_status} />
          </span>
        </>
      ),
    });
  if (p.decided_at)
    items.push({
      label: "Diputus",
      value: `${formatDateTime(p.decided_at)}${p.decided_by ? ` oleh ${p.decided_by.display_name}` : ""}`,
    });
  if (p.period)
    items.push({
      label: "Masa keanggotaan",
      value: `${formatDate(p.period.starts_at)} sampai ${formatDate(p.period.expires_at)}`,
    });
  if (p.cancelled_at)
    items.push({
      label: "Dibatalkan",
      value: `${formatDateTime(p.cancelled_at)}${p.cancel_reason ? ` | Alasan: ${p.cancel_reason}` : ""}`,
      wide: true,
    });
  if (p.transfer_note) items.push({ label: "Catatan transfer", value: p.transfer_note, wide: true });
  if (p.rejection_reason)
    items.push({
      label: p.status === "rejected" ? "Alasan penolakan" : "Alasan penolakan sebelumnya",
      value: p.rejection_reason,
      wide: true,
    });
  return items;
}

/** Akibat penolakan yang ditampilkan sebelum konfirmasi (PRD 4.3, 4.5, AC F03-3, F09-4, F14-4). */
function rejectConsequence(p: Pick<Detail, "member" | "type">): string {
  if (!p.member) return "Pemilik akun sudah tidak ada sehingga tidak ada notifikasi yang dikirim.";
  if (p.type === "ticket")
    return "Alasan berikut dikirim ke alumni. Tiket dibatalkan dan pembayaran tiket tidak dapat dikirim ulang.";
  return "Alasan berikut dikirim ke alumni agar dapat mengunggah bukti baru.";
}

/** Pesan hasil keputusan untuk region live panel; refund sistem disebut bila tercatat (D6). */
function decidedMessage(before: Pick<Detail, "member" | "refund_on_approve">, after: Detail): string {
  if (after.status === "paid")
    return before.refund_on_approve
      ? "Pembayaran disetujui. Refund penuh tercatat sebagai penyesuaian (D6)."
      : "Pembayaran disetujui.";
  return before.member ? "Pembayaran ditolak dan alasan dikirim ke alumni." : "Pembayaran ditolak.";
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

function DecisionSection({
  payment: p,
  onReload,
  onDecided,
}: {
  payment: Detail;
  onReload: () => void;
  /** Keputusan admin ini berhasil; `version` = versi pembayaran setelah keputusan. */
  onDecided: (message: string, version: string) => void;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [confirmReject, setConfirmReject] = useState(false);
  /** Naik saat server menolak alasan (VALIDATION_ERROR); fokus ke isian alasan setelah dialog tertutup. */
  const [reasonErrorSeq, setReasonErrorSeq] = useState(0);
  const form = useForm<DecisionValues>({ defaultValues: { funds_verified: false, reason: "" } });
  const fundsVerified = form.watch("funds_verified");
  const reason = form.watch("reason");

  // Dialog konfirmasi mengembalikan fokus ke tombol Tolak saat ditutup; galat alasan dari server baru dapat
  // difokus setelahnya (latar dialog inert), agar pembaca layar langsung membacakan galatnya (N-11).
  const { setFocus } = form;
  useEffect(() => {
    if (reasonErrorSeq > 0 && !confirmReject) setFocus("reason");
  }, [reasonErrorSeq, confirmReject, setFocus]);

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
      void queryClient.invalidateQueries({ queryKey: PAYMENTS_KEY });
    },
    onSuccess: (data) => {
      setConfirmReject(false);
      queryClient.setQueryData(paymentDetailKey(data.id), data);
      void queryClient.invalidateQueries({ queryKey: PAYMENTS_KEY });
      onDecided(decidedMessage(p, data), data.version);
    },
    onError: (error) => {
      setConfirmReject(false);
      if (error.fieldErrors.reason) setReasonErrorSeq((n) => n + 1);
    },
  });

  // Server menghitung `actions.can_decide` (pending berbukti, izin payments.decide, tanpa konflik kepentingan);
  // izin di UI ikut diperiksa agar izin yang dicabut saat panel terbuka langsung menutup formulir (AC F16-3).
  const canDecide = p.actions.can_decide && auth.can("payments.decide");
  if (!canDecide)
    return !auth.can("payments.decide") && p.stage === "awaiting_review" ? (
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
      <ConfirmDialog
        open={confirmReject}
        onCancel={() => setConfirmReject(false)}
        onConfirm={() => decide.mutate(vars("reject"))}
        pending={decide.isPending}
        title="Tolak pembayaran?"
        description={`Pembayaran ${ownerName(p)} sebesar ${formatRupiah(p.amount)} akan ditolak. ${rejectConsequence(p)}`}
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

interface CancelVars {
  paymentId: string;
  version: string;
  reason: string;
}

/**
 * Batalkan instruksi pending TANPA bukti atas kebijakan pengurus (PRD 4.3 "pending ke cancelled: kebijakan
 * admin", kontrak adminCancelPayment). Payment berbukti wajib diputus, bukan dibatalkan; tombol hanya muncul bila
 * server mengizinkan (`actions.can_cancel`). Alasan wajib dan konfirmasi dua langkah (PRD 4.5); If-Match versi
 * yang dilihat, konflik memuat ulang data terbaru (AC F15-4).
 */
function CancelInstruction({
  payment: p,
  onReload,
  onCancelled,
}: {
  payment: Detail;
  onReload: () => void;
  onCancelled: (message: string, version: string) => void;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  /** Versi payment saat dialog dibuka (If-Match); perubahan selama dialog terbuka ditolak 409, bukan ditimpa. */
  const [openVersion, setOpenVersion] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  const cancel = useApiMutation<Detail, CancelVars>({
    request: (v, ctx) =>
      api.POST("/admin/payments/{paymentId}/cancel", {
        params: {
          path: { paymentId: v.paymentId },
          header: { "If-Match": v.version, "Idempotency-Key": ctx.idempotencyKey },
        },
        body: { reason: v.reason },
      }),
    onReloadLatest: () => {
      setOpenVersion(null);
      onReload();
      void queryClient.invalidateQueries({ queryKey: PAYMENTS_KEY });
    },
    onSuccess: (data) => {
      setOpenVersion(null);
      queryClient.setQueryData(paymentDetailKey(data.id), data);
      void queryClient.invalidateQueries({ queryKey: PAYMENTS_KEY });
      onCancelled(
        p.member
          ? "Instruksi pembayaran dibatalkan dan pemilik diberi notifikasi."
          : "Instruksi pembayaran dibatalkan.",
        data.version,
      );
    },
    onError: (error) => {
      const message = error.fieldErrors.reason?.join(" ");
      if (message) setReasonError(message);
    },
  });

  if (!p.actions.can_cancel || !auth.can("payments.decide")) return null;

  function confirm() {
    if (openVersion === null) return;
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN) {
      setReasonError(`Alasan pembatalan minimal ${REASON_MIN} karakter dan tidak boleh hanya spasi.`);
      return;
    }
    setReasonError(null);
    cancel.mutate({ paymentId: p.id, version: openVersion, reason: trimmed });
  }

  return (
    <div className="flex flex-col gap-2 border-t border-divider pt-4">
      <p className="text-sm text-text-muted">
        Belum ada bukti transfer. Instruksi yang ditinggalkan dapat dibatalkan agar alumni dapat membuat instruksi
        baru; tindakan ini tidak membuka akses apa pun.
      </p>
      <Button
        variant="danger"
        onClick={() => {
          setReason("");
          setReasonError(null);
          setOpenVersion(p.version);
        }}
      >
        Batalkan instruksi
      </Button>
      <ConfirmDialog
        open={openVersion !== null}
        onCancel={() => setOpenVersion(null)}
        onConfirm={confirm}
        pending={cancel.isPending}
        title="Batalkan instruksi pembayaran?"
        description={`Instruksi ${PAYMENT_TYPE_LABEL[p.type].toLowerCase()} ${ownerName(p)} sebesar ${formatRupiah(p.amount)} dibatalkan. Alasan terlihat oleh pemilik dan tercatat di histori.`}
        confirmLabel="Batalkan instruksi"
        acknowledgement="Saya memastikan belum ada dana yang ditransfer untuk instruksi ini."
      >
        <Field label="Alasan pembatalan" required error={reasonError}>
          {(a11y) => (
            <Textarea
              {...a11y}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={REASON_MAX}
              disabled={cancel.isPending}
            />
          )}
        </Field>
      </ConfirmDialog>
    </div>
  );
}
