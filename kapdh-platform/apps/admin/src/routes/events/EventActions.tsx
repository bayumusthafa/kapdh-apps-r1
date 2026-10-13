import type { components } from "@kapdh/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Ban, CircleCheck, Lock, LockOpen, Pencil, Send, Trash } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { api } from "../../api/client";
import type { ApiError } from "../../api/errors";
import { useApiMutation } from "../../api/query";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Field } from "../../components/ui/FormField";
import { Textarea } from "../../components/ui/Input";
import { useToast } from "../../components/ui/Toast";
import { formatRupiah } from "../../lib/format";
import { type AdminEventDetail, currentEventDetail, eventKeys, storeEventDetail, useEventStats } from "./api";

type CancelResult = components["schemas"]["AdminEventCancelResult"];
type TargetStatus = "open" | "closed";

export const CANCEL_REASON_MIN = 3;
export const CANCEL_REASON_MAX = 500;

/** Teks galat untuk toast: rincian field server (mis. `field_errors.status`) bila ada, selain itu pesan server. */
export function errorText(err: ApiError): string {
  const first = Object.values(err.fieldErrors)[0];
  return first && first.length > 0 ? first.join(" ") : err.message;
}

interface StatusCopy {
  label: string;
  icon: ReactNode;
  title: string;
  body: string;
  confirm: string;
  success: string;
}

const STATUS_COPY: Record<"publish" | "close" | "reopen", StatusCopy & { target: TargetStatus }> = {
  publish: {
    target: "open",
    label: "Terbitkan",
    icon: <Send aria-hidden="true" className="size-4" />,
    title: "Terbitkan event?",
    body: "Event akan terlihat oleh anggota aktif dan pemesanan dibuka sesuai periode pendaftaran.",
    confirm: "Terbitkan",
    success: "Event diterbitkan dan terlihat oleh anggota.",
  },
  close: {
    target: "closed",
    label: "Tutup pendaftaran",
    icon: <Lock aria-hidden="true" className="size-4" />,
    title: "Tutup pendaftaran sekarang?",
    body: "Pemesanan baru ditutup lebih awal. Reservasi yang sedang ditahan tetap dapat mengirim bukti sampai batas waktunya, dan tiket lunas tetap berlaku untuk check-in.",
    confirm: "Tutup pendaftaran",
    success: "Pendaftaran event ditutup.",
  },
  reopen: {
    target: "open",
    label: "Buka kembali",
    icon: <LockOpen aria-hidden="true" className="size-4" />,
    title: "Buka kembali pendaftaran?",
    body: "Anggota dapat memesan lagi sampai waktu tutup daftar.",
    confirm: "Buka kembali",
    success: "Pendaftaran event dibuka kembali.",
  },
};

/**
 * Aksi event pada halaman detail, hanya yang diizinkan server (`allowed_actions`, kontrak AdminEventAction):
 * terbitkan/tutup/buka kembali (adminSetEventStatus), batalkan dengan alasan (adminCancelEvent, AC F09-7) dan hapus
 * event tanpa tiket (adminDeleteEvent, AC F15-2). Semua aksi memakai If-Match versi yang ditampilkan; konflik memuat
 * versi terbaru tanpa menimpa (AC F15-4). Konfirmasi wajib untuk setiap aksi (PRD 4.5).
 */
export function EventActions({
  event,
  onEdit,
  onCancelled,
}: {
  event: AdminEventDetail;
  onEdit: () => void;
  onCancelled: (result: CancelResult) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [statusAction, setStatusAction] = useState<keyof typeof STATUS_COPY | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const allowed = new Set(event.allowed_actions);

  const reloadLatest = (err: ApiError) => {
    const latest = currentEventDetail(err.current);
    if (latest) storeEventDetail(queryClient, latest);
    else void queryClient.invalidateQueries({ queryKey: eventKeys.detail(event.id) });
  };

  const setStatus = useApiMutation<
    AdminEventDetail,
    { target: TargetStatus; version: string; success: string }
  >({
    intent: (v) => ({ target: v.target, version: v.version }),
    toastErrors: false,
    request: (v, ctx) =>
      api.POST("/admin/events/{eventId}/status", {
        params: {
          path: { eventId: event.id },
          header: { "If-Match": v.version, "Idempotency-Key": ctx.idempotencyKey },
        },
        body: { status: v.target },
      }),
    onSuccess: (saved, v) => {
      setStatusAction(null);
      storeEventDetail(queryClient, saved);
      toast.success(v.success);
    },
    onReloadLatest: reloadLatest,
    onError: (err) => {
      setStatusAction(null);
      toast.error(errorText(err));
    },
  });

  const remove = useApiMutation<void, { version: string }>({
    toastErrors: false,
    request: (v) =>
      api.DELETE("/admin/events/{eventId}", {
        params: { path: { eventId: event.id }, header: { "If-Match": v.version } },
      }),
    onSuccess: async () => {
      setDeleteOpen(false);
      toast.success(`Event "${event.title}" dihapus.`);
      queryClient.removeQueries({ queryKey: eventKeys.detail(event.id) });
      await queryClient.invalidateQueries({ queryKey: eventKeys.lists });
      await navigate({ to: "/events" });
    },
    onError: (err) => {
      setDeleteOpen(false);
      reloadLatest(err);
      toast.error(errorText(err));
    },
  });

  const copy = statusAction ? STATUS_COPY[statusAction] : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Aksi event">
        {allowed.has("edit") ? (
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Pencil aria-hidden="true" className="size-4" />}
            onClick={onEdit}
          >
            Ubah
          </Button>
        ) : null}
        {(["publish", "close", "reopen"] as const)
          .filter((a) => allowed.has(a))
          .map((a) => (
            <Button
              key={a}
              variant={a === "publish" ? "gradient" : "outline"}
              size="sm"
              leftIcon={STATUS_COPY[a].icon}
              onClick={() => setStatusAction(a)}
            >
              {STATUS_COPY[a].label}
            </Button>
          ))}
        {allowed.has("cancel") ? (
          <Button
            variant="danger"
            size="sm"
            leftIcon={<Ban aria-hidden="true" className="size-4" />}
            onClick={() => setCancelOpen(true)}
          >
            Batalkan event
          </Button>
        ) : null}
        {allowed.has("delete") ? (
          <Button
            variant="danger"
            size="sm"
            leftIcon={<Trash aria-hidden="true" className="size-4" />}
            onClick={() => setDeleteOpen(true)}
          >
            Hapus
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        open={copy !== null}
        tone="primary"
        onCancel={() => setStatusAction(null)}
        onConfirm={() => {
          if (copy) setStatus.mutate({ target: copy.target, version: event.version, success: copy.success });
        }}
        pending={setStatus.isPending}
        title={copy?.title ?? ""}
        confirmLabel={copy?.confirm ?? ""}
      >
        <p className="text-sm">{copy?.body}</p>
      </ConfirmDialog>

      <CancelEventDialog
        open={cancelOpen}
        event={event}
        onClose={() => setCancelOpen(false)}
        onCancelled={(result) => {
          setCancelOpen(false);
          onCancelled(result);
        }}
        onReloadLatest={reloadLatest}
      />

      <ConfirmDialog
        open={deleteOpen}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => remove.mutate({ version: event.version })}
        pending={remove.isPending}
        title="Hapus event?"
        description={`"${event.title}" akan dihapus permanen.`}
        confirmLabel="Hapus event"
        acknowledgement="Saya memahami event ini dihapus dan tidak dapat dikembalikan."
      >
        <p className="text-sm">
          Event ini belum pernah memiliki tiket sehingga dapat dihapus. Event yang sudah memiliki tiket hanya
          dapat dibatalkan (AC F15-2).
        </p>
      </ConfirmDialog>
    </>
  );
}

/**
 * Konfirmasi pembatalan event (AC F09-7, D6, PRD 4.5): alasan wajib (ditampilkan kepada peserta) dan penjelasan
 * akibatnya sebelum admin menyetujui: seluruh QR tidak berlaku, peserta diberi notifikasi, refund penuh dicatat untuk
 * tiket lunas berbayar dan diproses manual bendahara paling lambat 7 hari kerja, pembayaran berbukti tetap di
 * antrean verifikasi, dan riwayat event/transaksi tidak dihapus.
 */
function CancelEventDialog({
  open,
  event,
  onClose,
  onCancelled,
  onReloadLatest,
}: {
  open: boolean;
  event: AdminEventDetail;
  onClose: () => void;
  onCancelled: (result: CancelResult) => void;
  onReloadLatest: (err: ApiError) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const reasonId = useId();
  const stats = useEventStats(event.id);
  // Money string: berbayar bila ada digit bukan nol (tanpa aritmetika floating point, ARCHITECTURE §2).
  const paidEvent = /[1-9]/.test(event.price);

  const cancel = useApiMutation<CancelResult, { reason: string; version: string }>({
    intent: (v) => v,
    toastErrors: false,
    request: (v, ctx) =>
      api.POST("/admin/events/{eventId}/cancel", {
        params: {
          path: { eventId: event.id },
          header: { "If-Match": v.version, "Idempotency-Key": ctx.idempotencyKey },
        },
        body: { reason: v.reason },
      }),
    onSuccess: (result) => {
      storeEventDetail(queryClient, result.event);
      setReason("");
      onCancelled(result);
    },
    onReloadLatest: (err) => {
      onClose();
      onReloadLatest(err);
      toast.error(err.message);
    },
    onError: (err) => {
      if (err.ui.action === "reload_latest") return;
      const fieldReason = err.fieldErrors.reason?.join(" ");
      if (fieldReason) setReasonError(fieldReason);
      else toast.error(errorText(err));
    },
  });

  function confirm() {
    const trimmed = reason.trim();
    if (trimmed.length < CANCEL_REASON_MIN) {
      setReasonError(`Alasan wajib diisi, minimal ${CANCEL_REASON_MIN} karakter.`);
      document.getElementById(reasonId)?.focus();
      return;
    }
    setReasonError(null);
    cancel.mutate({ reason: trimmed, version: event.version });
  }

  const s = stats.data;
  return (
    <ConfirmDialog
      open={open}
      onCancel={() => {
        setReasonError(null);
        onClose();
      }}
      onConfirm={confirm}
      pending={cancel.isPending}
      title="Batalkan event?"
      description={`"${event.title}" akan dibatalkan untuk seluruh peserta.`}
      confirmLabel="Batalkan event"
      acknowledgement="Saya memahami pembatalan tidak dapat diurungkan dan peserta akan diberi tahu."
    >
      <div className="flex flex-col gap-2 rounded-md bg-danger-bg/60 p-3 text-sm">
        <p className="font-semibold">Yang akan terjadi:</p>
        <ul className="list-inside list-disc space-y-1">
          <li>Pemesanan dan check-in ditutup; QR seluruh tiket tidak berlaku lagi.</li>
          <li>
            Pemegang tiket aktif diberi notifikasi beserta alasan di bawah
            {s
              ? ` (${s.paid_count} lunas, ${s.awaiting_review_count + s.awaiting_payment_count} masih ditahan)`
              : ""}
            .
          </li>
          {paidEvent ? (
            <>
              <li>
                Setiap tiket lunas mendapat refund penuh ({formatRupiah(event.price)}) yang dicatat untuk
                diproses manual oleh bendahara paling lambat 7 hari kerja (D6).
              </li>
              <li>
                Reservasi tanpa bukti dibatalkan. Pembayaran yang buktinya sedang ditinjau tetap di antrean
                verifikasi; bila disetujui, refund penuh dibuat otomatis.
              </li>
            </>
          ) : (
            <li>Event gratis: tidak ada refund; kursi peserta dilepas.</li>
          )}
          <li>Data event, tiket, pembayaran dan audit tetap tersimpan sebagai riwayat.</li>
        </ul>
      </div>
      <Field
        id={reasonId}
        label="Alasan pembatalan"
        required
        error={reasonError}
        hint="Ditampilkan kepada peserta pada notifikasi dan detail tiket."
      >
        {(a11y) => (
          <Textarea
            {...a11y}
            rows={3}
            value={reason}
            maxLength={CANCEL_REASON_MAX}
            showCount
            disabled={cancel.isPending}
            onChange={(e) => {
              setReason(e.target.value);
              if (reasonError) setReasonError(null);
            }}
          />
        )}
      </Field>
    </ConfirmDialog>
  );
}

/** Ringkasan dampak pembatalan event (AdminEventCancelResult) yang diumumkan setelah berhasil. */
export function CancelResultNotice({ result }: { result: CancelResult }) {
  return (
    <div
      role="status"
      className="flex flex-col gap-1 rounded-lg border border-success/30 bg-success-bg p-4 text-sm"
    >
      <p className="flex items-center gap-2 font-semibold text-success">
        <CircleCheck aria-hidden="true" className="size-4" />
        Event dibatalkan. Notifikasi peserta dijadwalkan.
      </p>
      <ul className="list-inside list-disc text-text">
        <li>{result.tickets_cancelled} tiket aktif dibatalkan.</li>
        <li>{result.payments_cancelled} pembayaran tanpa bukti dibatalkan.</li>
        <li>
          {result.payments_in_review} pembayaran berbukti tetap di antrean verifikasi (persetujuan membuat
          refund otomatis).
        </li>
        <li>
          {result.refunds_created} refund senilai {formatRupiah(result.refund_total)} dicatat untuk bendahara.
        </li>
      </ul>
    </div>
  );
}
