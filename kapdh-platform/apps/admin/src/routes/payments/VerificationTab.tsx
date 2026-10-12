import type { components } from "@kapdh/contracts";
import { keepPreviousData } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { api } from "../../api/client";
import { useApiQuery } from "../../api/query";
import { Badge, PaymentStatusBadge } from "../../components/ui/Badge";
import { DataTable, useCursorPaging } from "../../components/ui/DataTable";
import { Field } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Input";
import { SearchInput } from "../../components/ui/SearchInput";
import { EmptyState } from "../../components/ui/States";
import { formatRelativeAge, formatRupiah, formatShortDateTime } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { PAYMENT_TYPE_LABEL } from "../../lib/labels";
import { PaymentDecisionPanel } from "./PaymentDecisionPanel";

type Item = components["schemas"]["AdminPaymentItem"];
type PaymentStatus = components["schemas"]["PaymentStatus"];
type PaymentType = components["schemas"]["PaymentType"];

/** Ukuran halaman antrean (server: bawaan 30, maks 100). */
export const PAYMENT_PAGE_SIZE = 20;
/** Antrean diperbarui berkala; hanya refetch berkala yang membawa X-Background-Request (AC F02-5). */
export const PAYMENT_POLL_MS = 60_000;

const TYPE_OPTIONS = [
  { value: "all", label: "Semua jenis" },
  { value: "registration", label: "Pendaftaran" },
  { value: "renewal", label: "Perpanjangan" },
  { value: "ticket", label: "Tiket event" },
] as const;

const STATUS_OPTIONS = [
  { value: "pending", label: "Menunggu" },
  { value: "paid", label: "Disetujui" },
  { value: "rejected", label: "Ditolak" },
  { value: "cancelled", label: "Dibatalkan" },
  { value: "all", label: "Semua" },
] as const;

export function paymentTypeText(item: Pick<Item, "type" | "event_title">): string {
  return item.type === "ticket" && item.event_title
    ? `Tiket: ${item.event_title}`
    : PAYMENT_TYPE_LABEL[item.type];
}

/**
 * Antrean verifikasi pembayaran (F-04, prototipe screen_8): cari (debounce), filter jenis & status, paging kursor
 * server, usia antrean, penanda lewat 1 hari kerja, dan panel keputusan di samping (menyusun ke bawah di layar
 * sempit). Antrean diurutkan server berdasarkan waktu kirim bukti, terlama dulu (PRD 3.4).
 */
export function VerificationTab() {
  const [q, setQ] = useState("");
  const [type, setType] = useState<PaymentType | "all">("all");
  const [status, setStatus] = useState<PaymentStatus | "all">("pending");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Naik setiap admin memilih baris; panel memindah fokus ke judul detail setelah detail termuat. */
  const [focusRequest, setFocusRequest] = useState(0);
  const now = useNow();
  const filters = { q, type, status };
  const paging = useCursorPaging(filters, PAYMENT_PAGE_SIZE);

  const list = useApiQuery({
    queryKey: ["admin-payments", "list", { ...filters, cursor: paging.cursor }],
    pollMs: PAYMENT_POLL_MS,
    placeholderData: keepPreviousData,
    request: ({ signal, headers }) =>
      api.GET("/admin/payments", {
        params: {
          query: {
            ...(status !== "all" ? { status } : {}),
            ...(type !== "all" ? { type } : {}),
            ...(q ? { q } : {}),
            ...(paging.cursor ? { cursor: paging.cursor } : {}),
            limit: PAYMENT_PAGE_SIZE,
          },
        },
        signal,
        headers,
      }),
  });

  function select(id: string) {
    setSelectedId(id);
    // Fokus dipindah ke judul detail oleh panel SETELAH detail termuat (judul belum ada selama memuat), agar
    // pengguna keyboard/pembaca layar langsung berada di panel keputusan (N-11).
    setFocusRequest((n) => n + 1);
  }

  const showAge = status === "pending";
  const columns = useMemo<ColumnDef<Item>[]>(
    () => [
      {
        id: "submitted_at",
        header: "Dikirim (WIB)",
        cell: ({ row }) => formatShortDateTime(row.original.submitted_at),
        meta: { cellClassName: "whitespace-nowrap" },
      },
      {
        id: "member",
        header: "Alumni",
        meta: { rowHeader: true },
        cell: ({ row }) => {
          const p = row.original;
          const active = p.id === selectedId;
          return (
            <button
              type="button"
              aria-current={active ? "true" : undefined}
              onClick={() => select(p.id)}
              className="flex min-h-11 flex-col items-start justify-center text-left"
            >
              <span className="font-semibold text-primary underline-offset-2 hover:underline">
                {p.member.full_name}
              </span>
              <span className="text-xs font-normal text-text-muted">
                {p.member.member_number ?? "Belum bernomor"}
              </span>
            </button>
          );
        },
      },
      { id: "type", header: "Jenis", cell: ({ row }) => paymentTypeText(row.original) },
      {
        id: "amount",
        header: "Nominal",
        meta: { align: "right", cellClassName: "whitespace-nowrap" },
        cell: ({ row }) => formatRupiah(row.original.amount),
      },
      showAge
        ? {
            id: "age",
            header: "Usia antrean",
            cell: ({ row }) =>
              row.original.overdue ? (
                <Badge tone="warning">Lewat 1 hari kerja</Badge>
              ) : (
                formatRelativeAge(row.original.submitted_at, now)
              ),
          }
        : {
            id: "status",
            header: "Status",
            cell: ({ row }) => (
              <span className="flex flex-wrap items-center gap-1.5">
                <PaymentStatusBadge status={row.original.status} />
                {/* Penanda lewat SLA juga berupa teks, tidak hanya warna latar baris (PRD 4.5). */}
                {row.original.overdue && row.original.status === "pending" ? (
                  <Badge tone="warning">Lewat 1 hari kerja</Badge>
                ) : null}
              </span>
            ),
          },
    ],
    // `select` hanya memakai setState sehingga aman tidak dijadikan dependensi. Definisi kolom yang dibuat ulang
    // (baris aktif, jam) tidak memasang ulang sel karena DataTable merender templat lewat komponen stabil.
    [selectedId, showAge, now],
  );

  const selectedItem = list.data?.items.find((i) => i.id === selectedId);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <SearchInput
          label="Cari"
          value={q}
          onValueChange={setQ}
          placeholder="Nama atau nomor KTA"
          className="flex-[1_1_240px]"
        />
        <Field label="Jenis" className="flex-[0_1_200px]">
          {(a11y) => (
            <Select {...a11y} size="sm" options={TYPE_OPTIONS} value={type} onValueChange={setType} />
          )}
        </Field>
        <Field label="Status" className="flex-[0_1_180px]">
          {(a11y) => (
            <Select {...a11y} size="sm" options={STATUS_OPTIONS} value={status} onValueChange={setStatus} />
          )}
        </Field>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <section aria-label="Antrean pembayaran" className="min-w-0 flex-[3_1_520px]">
          <DataTable<Item>
            caption="Antrean pembayaran"
            columns={columns}
            data={list.data?.items}
            getRowId={(p) => p.id}
            status={list.status}
            error={list.error}
            onRetry={() => void list.refetch()}
            isFetching={list.isFetching && list.isPlaceholderData}
            total={list.data?.total}
            activeRowId={selectedId}
            rowClassName={(p) => (p.overdue && p.status === "pending" ? "bg-warning-bg/50" : undefined)}
            minWidth={620}
            pagination={{
              pageIndex: paging.pageIndex,
              pageSize: PAYMENT_PAGE_SIZE,
              nextCursor: list.data?.next_cursor,
              onNext: paging.next,
              onPrev: paging.prev,
            }}
            emptyState={
              <EmptyState
                compact
                title={q ? "Tidak ada pembayaran yang cocok" : "Antrean kosong"}
                description={
                  q ? "Ubah kata kunci atau filter." : "Tidak ada pembayaran dengan jenis dan status ini."
                }
              />
            }
          />
        </section>
        <div className="min-w-0 flex-[2_1_340px]">
          {selectedId ? (
            <PaymentDecisionPanel
              key={selectedId}
              paymentId={selectedId}
              listProofVersion={selectedItem?.proof_version}
              focusRequest={focusRequest}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-border bg-surface">
              <EmptyState
                compact
                title="Pilih pembayaran"
                description="Pilih nama alumni pada antrean untuk melihat bukti dan memutus pembayaran."
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
