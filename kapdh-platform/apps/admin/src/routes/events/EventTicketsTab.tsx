import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Ban } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { api } from "../../api/client";
import { useApiMutation } from "../../api/query";
import { useAuth } from "../../auth/session";
import { Badge, TICKET_STATUS, TicketStatusBadge } from "../../components/ui/Badge";
import { Button, buttonClass } from "../../components/ui/Button";
import { RadioGroup } from "../../components/ui/Choice";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Avatar } from "../../components/ui/DataDisplay";
import { DataTable, useCursorPaging } from "../../components/ui/DataTable";
import { Field } from "../../components/ui/FormField";
import { Select, Textarea } from "../../components/ui/Input";
import { SearchInput } from "../../components/ui/SearchInput";
import { EmptyState } from "../../components/ui/States";
import { useToast } from "../../components/ui/Toast";
import { cn } from "../../lib/cn";
import { formatDateTime, formatRupiah, formatShortDateTime } from "../../lib/format";
import { DELETED_ACCOUNT_LABEL } from "../../lib/labels";
import {
  type AdminEventDetail,
  type AdminEventTicket,
  type AdminEventTicketSort,
  eventKeys,
  TICKET_PAGE_SIZE,
  type TicketFilters,
  type TicketStatus,
  useEventTickets,
} from "./api";
import { CANCEL_REASON_MAX, CANCEL_REASON_MIN, errorText } from "./EventActions";
import {
  CANCELLED_BY_LABEL,
  REFUND_STATUS_LABEL,
  TICKET_PAYMENT_STATUS_LABEL,
  TICKET_SORT_OPTIONS,
} from "./labels";

const STATUS_OPTIONS: { value: TicketStatus | "all"; label: string }[] = [
  { value: "all", label: "Semua status" },
  ...(Object.keys(TICKET_STATUS) as TicketStatus[]).map((s) => ({ value: s, label: TICKET_STATUS[s].label })),
];

const CHECKIN_OPTIONS: { value: TicketFilters["checkedIn"]; label: string }[] = [
  { value: "all", label: "Semua" },
  { value: "true", label: "Sudah check-in" },
  { value: "false", label: "Belum check-in" },
];

/** Tiket yang dapat dibatalkan pengurus (kontrak adminCancelTicket): belum check-in, menunggu bayar atau lunas. */
export function ticketCancellable(t: AdminEventTicket, event: AdminEventDetail): boolean {
  return (
    event.status !== "cancelled" &&
    t.checked_in_at === null &&
    (t.status === "awaiting_payment" || t.status === "paid")
  );
}

/** Waktu sel tabel dua baris (tanggal lalu jam, WIB pada judul kolom) agar kolom tetap sempit tanpa terpotong. */
function CellDateTime({ iso }: { iso: string }) {
  const [date, time] = formatShortDateTime(iso).split(", ");
  return (
    <span className="flex flex-col whitespace-nowrap">
      <span>{date}</span>
      {time ? <span className="text-xs text-text-muted">{time}</span> : null}
    </span>
  );
}

function holderName(t: AdminEventTicket): string {
  return t.holder.full_name ?? DELETED_ACCOUNT_LABEL;
}

/**
 * Peserta dan tiket event (F-09, F-15): status tiket, pembayaran (penunjuk ke antrean verifikasi, batas review,
 * refund D6) dan check-in (waktu dan petugas, AC F09-5). Filter status, check-in dan pencarian nama/nomor anggota
 * memakai paging server. Pemegang yang akunnya dihapus tampil anonim (AC F14-4). Pembatalan per tiket meminta
 * alasan; pilihan refund hanya muncul bila server mengizinkan pemanggil (`can_refund`: payments.decide dan bukan
 * akun alumni tertautnya sendiri, PRD 2.3).
 */
export function EventTicketsTab({ event }: { event: AdminEventDetail }) {
  const auth = useAuth();
  const [filters, setFilters] = useState<TicketFilters>({
    q: "",
    status: "all",
    checkedIn: "all",
    sort: "created_at_desc",
  });
  const [toCancel, setToCancel] = useState<AdminEventTicket | null>(null);
  const paging = useCursorPaging(filters, TICKET_PAGE_SIZE);
  const list = useEventTickets(event.id, filters, paging.cursor);
  const set = <K extends keyof TicketFilters>(key: K, value: TicketFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));
  const canSeePayments = auth.can("payments.read");

  const columns = useMemo<ColumnDef<AdminEventTicket>[]>(
    () => [
      {
        id: "holder",
        header: "Pemegang",
        meta: { rowHeader: true },
        cell: ({ row }) => {
          const t = row.original;
          return (
            <span className="flex items-center gap-2.5 text-left">
              <Avatar name={holderName(t)} src={t.holder.avatar_url} size="sm" />
              <span className="flex min-w-0 flex-col">
                <span className="font-semibold">{holderName(t)}</span>
                <span className="text-xs text-text-muted">
                  {t.holder.full_name === null
                    ? "Data pemegang sudah dihapus"
                    : [t.holder.member_number ?? "Belum bernomor", t.holder.cohort_code]
                        .filter(Boolean)
                        .join(" | ")}
                </span>
                {!t.holder_eligible && t.holder.full_name !== null ? (
                  <Badge tone="danger" className="mt-1 w-auto whitespace-normal">
                    Tidak memenuhi syarat
                  </Badge>
                ) : null}
              </span>
            </span>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => {
          const t = row.original;
          return (
            <span className="flex flex-col items-start gap-1">
              <TicketStatusBadge status={t.status} />
              {t.status === "awaiting_payment" && t.hold_expires_at ? (
                <span className="text-xs text-text-muted">
                  Batas bayar {formatShortDateTime(t.hold_expires_at)} WIB
                </span>
              ) : null}
              {t.status === "cancelled" && t.cancelled_by ? (
                <span className="max-w-44 text-xs text-text-muted">
                  {CANCELLED_BY_LABEL[t.cancelled_by]}
                  {t.cancel_reason ? `: ${t.cancel_reason}` : ""}
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "payment",
        header: "Pembayaran",
        cell: ({ row }) => {
          const t = row.original;
          if (!t.payment)
            return <span className="text-text-muted">{/[1-9]/.test(t.total) ? "-" : "Gratis"}</span>;
          const p = t.payment;
          return (
            <span className="flex flex-col items-start gap-1">
              <span className="font-medium">
                {formatRupiah(p.amount)} | {TICKET_PAYMENT_STATUS_LABEL[p.status]}
              </span>
              <span className="text-xs text-text-muted" title={p.id}>
                ID {p.id.slice(-8)}
                {p.proof_version > 0 ? ` | bukti v${p.proof_version}` : " | belum ada bukti"}
                {p.submitted_at ? ` | dikirim ${formatShortDateTime(p.submitted_at)}` : ""}
              </span>
              {t.review_overdue ? <Badge tone="warning">Lewat batas review</Badge> : null}
              {p.status === "pending" && p.submitted_at && canSeePayments ? (
                // Tautan membuka payment ini langsung di panel keputusan (?payment=), bukan antrean bawaan.
                <Link
                  to="/payments"
                  search={{ tab: "verify", payment: p.id }}
                  className="text-xs font-semibold text-primary hover:underline"
                >
                  Putuskan di Verifikasi Pembayaran
                </Link>
              ) : canSeePayments ? (
                // Payment lain (menunggu bukti, lunas, ditolak, dibatalkan) dibuka langsung untuk histori dan bukti.
                <Link
                  to="/payments"
                  search={{ tab: "verify", payment: p.id }}
                  aria-label={`Lihat pembayaran tiket ${holderName(t)}`}
                  className="text-xs font-semibold text-primary hover:underline"
                >
                  Lihat pembayaran
                </Link>
              ) : null}
              {t.refunds.map((r) => (
                <Badge
                  key={r.id}
                  className="w-auto whitespace-normal"
                  tone={r.status === "completed" ? "success" : r.status === "pending" ? "info" : "neutral"}
                >
                  {REFUND_STATUS_LABEL[r.status]} {formatRupiah(r.amount)}
                  {r.status === "pending" && r.due_at ? `, tenggat ${formatShortDateTime(r.due_at)}` : ""}
                </Badge>
              ))}
            </span>
          );
        },
      },
      {
        id: "checkin",
        header: "Check-in (WIB)",
        cell: ({ row }) => {
          const t = row.original;
          if (!t.checked_in_at) return <span className="text-text-muted">Belum</span>;
          return (
            <span className="flex flex-col">
              <span className="whitespace-nowrap font-medium">{formatShortDateTime(t.checked_in_at)}</span>
              <span className="text-xs text-text-muted">
                oleh {t.checked_in_by?.display_name ?? "petugas"}
              </span>
            </span>
          );
        },
      },
      {
        id: "created_at",
        header: "Dipesan (WIB)",
        cell: ({ row }) => <CellDateTime iso={row.original.created_at} />,
      },
    ],
    [canSeePayments],
  );

  const filtered = filters.q !== "" || filters.status !== "all" || filters.checkedIn !== "all";

  return (
    <>
      <DataTable<AdminEventTicket>
        caption="Peserta dan tiket"
        columns={columns}
        data={list.data?.items}
        getRowId={(t) => t.id}
        status={list.status}
        error={list.error}
        onRetry={() => void list.refetch()}
        isFetching={list.isFetching && list.isPlaceholderData}
        total={list.data?.total}
        minWidth={900}
        rowClassName={(t) => (t.review_overdue ? "bg-warning-bg/50" : undefined)}
        pagination={{
          pageIndex: paging.pageIndex,
          pageSize: TICKET_PAGE_SIZE,
          nextCursor: list.data?.next_cursor,
          onNext: paging.next,
          onPrev: paging.prev,
        }}
        toolbar={
          <>
            <SearchInput
              label="Cari peserta"
              value={filters.q}
              onValueChange={(v) => set("q", v)}
              placeholder="Nama atau nomor anggota"
              className="flex-[1_1_220px]"
            />
            <Field label="Status tiket" className="flex-[0_1_200px]">
              {(a11y) => (
                <Select
                  {...a11y}
                  size="sm"
                  options={STATUS_OPTIONS}
                  value={filters.status}
                  onValueChange={(v) => set("status", v)}
                />
              )}
            </Field>
            <Field label="Check-in" className="flex-[0_1_170px]">
              {(a11y) => (
                <Select
                  {...a11y}
                  size="sm"
                  options={CHECKIN_OPTIONS}
                  value={filters.checkedIn}
                  onValueChange={(v) => set("checkedIn", v)}
                />
              )}
            </Field>
            <Field label="Urutkan" className="flex-[0_1_190px]">
              {(a11y) => (
                <Select<AdminEventTicketSort>
                  {...a11y}
                  size="sm"
                  options={TICKET_SORT_OPTIONS}
                  value={filters.sort}
                  onValueChange={(v) => set("sort", v)}
                />
              )}
            </Field>
            {canSeePayments ? (
              // Seluruh payment tiket event ini (filter event_id adminListPayments, semua status).
              <Link
                to="/payments"
                search={{ tab: "verify", event: event.id }}
                className={cn(buttonClass({ variant: "ghost", size: "sm" }), "self-end")}
              >
                Pembayaran tiket event ini
              </Link>
            ) : null}
          </>
        }
        rowActions={(t) =>
          ticketCancellable(t, event) ? (
            <Button
              variant="danger"
              size="sm"
              leftIcon={<Ban aria-hidden="true" className="size-4" />}
              aria-label={`Batalkan tiket ${holderName(t)}`}
              onClick={() => setToCancel(t)}
            >
              Batalkan
            </Button>
          ) : t.status === "awaiting_review" && event.status !== "cancelled" ? (
            <span className="block max-w-28 text-right text-xs text-text-muted">
              Putuskan pembayaran dahulu
            </span>
          ) : null
        }
        emptyState={
          <EmptyState
            compact
            title={filtered ? "Tidak ada tiket yang cocok" : "Belum ada peserta"}
            description={
              filtered ? "Ubah kata kunci atau filter." : "Tiket muncul di sini setelah anggota mendaftar."
            }
          />
        }
      />
      <CancelTicketDialog ticket={toCancel} event={event} onClose={() => setToCancel(null)} />
    </>
  );
}

/**
 * Pembatalan satu tiket oleh pengurus (kontrak adminCancelTicket, D6, PRD 2.2): alasan wajib; untuk tiket lunas
 * berbayar admin memilih refund penuh atau tanpa refund bila `can_refund`, selain itu dicatat tanpa refund dengan
 * penjelasan. If-Match versi tiket; konflik memuat ulang daftar tiket (AC F15-4).
 */
function CancelTicketDialog({
  ticket,
  event,
  onClose,
}: {
  ticket: AdminEventTicket | null;
  event: AdminEventDetail;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [refund, setRefund] = useState<"refund" | "no_refund" | null>(null);
  const [errors, setErrors] = useState<{ reason?: string; refund?: string }>({});
  const reasonId = useId();
  const paidWithMoney = ticket !== null && ticket.status === "paid" && /[1-9]/.test(ticket.total);
  const askRefund = paidWithMoney && ticket.can_refund;

  const reset = () => {
    setReason("");
    setRefund(null);
    setErrors({});
  };

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: eventKeys.tickets(event.id) }),
      queryClient.invalidateQueries({ queryKey: eventKeys.detail(event.id) }),
      queryClient.invalidateQueries({ queryKey: eventKeys.lists }),
    ]);

  const cancel = useApiMutation<
    AdminEventTicket,
    { ticket: AdminEventTicket; reason: string; refund: boolean }
  >({
    intent: (v) => ({ id: v.ticket.id, version: v.ticket.version, reason: v.reason, refund: v.refund }),
    toastErrors: false,
    request: (v, ctx) =>
      api.POST("/admin/events/{eventId}/tickets/{ticketId}/cancel", {
        params: {
          path: { eventId: event.id, ticketId: v.ticket.id },
          header: { "If-Match": v.ticket.version, "Idempotency-Key": ctx.idempotencyKey },
        },
        body: { reason: v.reason, refund: v.refund },
      }),
    onSuccess: async (saved, v) => {
      toast.success(
        v.refund
          ? `Tiket ${holderName(saved)} dibatalkan. Refund ${formatRupiah(saved.total)} dicatat untuk bendahara.`
          : `Tiket ${holderName(saved)} dibatalkan.`,
      );
      reset();
      onClose();
      await refresh();
    },
    onError: (err) => {
      const fieldErrs = err.fieldErrors;
      if (fieldErrs.reason || fieldErrs.refund) {
        setErrors({ reason: fieldErrs.reason?.join(" "), refund: fieldErrs.refund?.join(" ") });
        return;
      }
      toast.error(errorText(err));
      if (err.ui.action === "reload_latest" || err.code === "FORBIDDEN") {
        reset();
        onClose();
        void refresh();
      }
    },
  });

  function confirm() {
    if (!ticket) return;
    const trimmed = reason.trim();
    const next: typeof errors = {};
    if (trimmed.length < CANCEL_REASON_MIN)
      next.reason = `Alasan wajib diisi, minimal ${CANCEL_REASON_MIN} karakter.`;
    if (askRefund && refund === null) next.refund = "Pilih refund penuh atau tanpa refund.";
    setErrors(next);
    if (next.reason) {
      document.getElementById(reasonId)?.focus();
      return;
    }
    if (next.refund) return;
    cancel.mutate({ ticket, reason: trimmed, refund: askRefund && refund === "refund" });
  }

  const name = ticket ? holderName(ticket) : "";
  return (
    <ConfirmDialog
      open={ticket !== null}
      onCancel={() => {
        reset();
        onClose();
      }}
      onConfirm={confirm}
      pending={cancel.isPending}
      title="Batalkan tiket?"
      description={ticket ? `Tiket ${name} untuk "${event.title}".` : undefined}
      confirmLabel="Batalkan tiket"
      acknowledgement="Saya memahami tiket ini tidak berlaku lagi dan pemegang diberi tahu."
    >
      {ticket ? (
        <div className="flex flex-col gap-1 rounded-md bg-neutral-50 p-3 text-sm">
          <p>
            Status: <strong>{TICKET_STATUS[ticket.status].label}</strong>
            {ticket.payment ? ` | ${formatRupiah(ticket.total)}` : ""}
            {ticket.created_at ? ` | dipesan ${formatDateTime(ticket.created_at)}` : ""}
          </p>
          <p className="text-text-muted">
            {ticket.status === "awaiting_payment"
              ? "Reservasi dibatalkan, pembayaran yang belum berbukti dibatalkan dan kursi dilepas."
              : "QR tiket tidak berlaku lagi dan kursi dilepas. Pemegang diberi notifikasi."}
          </p>
        </div>
      ) : null}
      <Field
        id={reasonId}
        label="Alasan pembatalan"
        required
        error={errors.reason}
        hint="Disimpan di tiket, audit dan notifikasi pemegang."
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
              if (errors.reason) setErrors((x) => ({ ...x, reason: undefined }));
            }}
          />
        )}
      </Field>
      {askRefund ? (
        <RadioGroup
          legend="Refund"
          required
          value={refund}
          onValueChange={(v) => {
            setRefund(v);
            setErrors((x) => ({ ...x, refund: undefined }));
          }}
          error={errors.refund}
          variant="card"
          options={[
            {
              value: "refund",
              label: `Refund penuh ${formatRupiah(ticket?.total)}`,
              description:
                "Dicatat sebagai penyesuaian refund pending; bendahara mentransfer paling lambat 7 hari kerja.",
            },
            {
              value: "no_refund",
              label: "Tanpa refund",
              description:
                "Misalnya pembatalan setelah H-3 atau keputusan pengurus untuk anggota yang disuspend.",
            },
          ]}
        />
      ) : paidWithMoney ? (
        <p className="rounded-md bg-warning-bg p-3 text-sm text-warning">
          Pilihan refund tidak tersedia untuk akun Anda (memerlukan izin memutus pembayaran, dan refund untuk
          tiket akun alumni Anda sendiri harus diputus pengurus lain). Tiket dibatalkan tanpa refund; refund
          dapat dicatat kemudian oleh pengurus pembayaran.
        </p>
      ) : null}
    </ConfirmDialog>
  );
}
