import type { components } from "@kapdh/contracts";
import { keepPreviousData } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { CircleCheck, Hourglass } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { useApiQuery } from "../../api/query";
import { Badge } from "../../components/ui/Badge";
import { DataTable, useCursorPaging } from "../../components/ui/DataTable";
import { Field } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Input";
import { SearchInput } from "../../components/ui/SearchInput";
import { EmptyState } from "../../components/ui/States";
import { formatDate, formatRupiah } from "../../lib/format";
import { AdjustmentPanel } from "./AdjustmentPanel";
import {
  ADJUSTMENT_KIND_LABEL,
  AdjustmentStatusBadge,
  memberName,
  memberSubtitle,
  paymentTypeText,
} from "./labels";
import { ADJUSTMENTS_KEY } from "./queries";

type Adjustment = components["schemas"]["AdminPaymentAdjustment"];
type AdjustmentKind = components["schemas"]["PaymentAdjustmentKind"];
type AdjustmentStatus = components["schemas"]["PaymentAdjustmentStatus"];
type AdjustmentSort = components["schemas"]["AdminPaymentAdjustmentSort"];

export const ADJUSTMENT_PAGE_SIZE = 20;
export const ADJUSTMENT_POLL_MS = 60_000;

const KIND_OPTIONS = [
  { value: "all", label: "Semua jenis" },
  { value: "refund", label: "Refund" },
  { value: "correction", label: "Koreksi" },
] as const satisfies readonly { value: AdjustmentKind | "all"; label: string }[];

const STATUS_OPTIONS = [
  { value: "pending", label: "Menunggu proses" },
  { value: "completed", label: "Selesai" },
  { value: "cancelled", label: "Dibatalkan" },
  { value: "all", label: "Semua" },
] as const satisfies readonly { value: AdjustmentStatus | "all"; label: string }[];

type DestinationFilter = "all" | "missing" | "ready";
const DESTINATION_OPTIONS = [
  { value: "all", label: "Semua" },
  { value: "missing", label: "Menunggu rekening" },
  { value: "ready", label: "Siap ditransfer" },
] as const satisfies readonly { value: DestinationFilter; label: string }[];

type DueFilter = "all" | "overdue";
const DUE_OPTIONS = [
  { value: "all", label: "Semua tenggat" },
  { value: "overdue", label: "Lewat tenggat" },
] as const satisfies readonly { value: DueFilter; label: string }[];

const SORT_OPTIONS = [
  { value: "due_at_asc", label: "Tenggat terdekat" },
  { value: "created_at_desc", label: "Terbaru dicatat" },
] as const satisfies readonly { value: AdjustmentSort; label: string }[];

/** Penanda rekening tujuan refund pending (nilainya sendiri tidak pernah ada di daftar, D2). */
function DestinationBadge({ a }: { a: Adjustment }) {
  if (a.kind !== "refund" || a.status !== "pending") return <span className="text-text-muted">-</span>;
  return a.has_refund_destination ? (
    <Badge tone="success" icon={<CircleCheck />}>
      Siap ditransfer
    </Badge>
  ) : (
    <Badge tone="warning" icon={<Hourglass />}>
      Menunggu rekening
    </Badge>
  );
}

/**
 * Tab Penyesuaian (D6, PRD 3.4, 3.9): antrean refund dan koreksi atas payment paid. Bawaan "Menunggu proses"
 * diurutkan tenggat terdekat (7 hari kerja sejak pembatalan); yang lewat tenggat ditandai teks, bukan warna saja.
 * Rekening tujuan refund tidak pernah tampil di daftar; panel detail menampilkannya hanya selama pending kepada
 * pengurus berizin memutus (D2). Penyesuaian terpilih disimpan di URL (?adjustment=) agar tautan dari detail
 * pembayaran membuka panel yang sama.
 */
export function AdjustmentsTab() {
  const search = useSearch({ from: "/app/payments" });
  const navigate = useNavigate({ from: "/payments" });
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<AdjustmentKind | "all">("all");
  const [status, setStatus] = useState<AdjustmentStatus | "all">("pending");
  const [destination, setDestination] = useState<DestinationFilter>("all");
  const [due, setDue] = useState<DueFilter>("all");
  const [sort, setSort] = useState<AdjustmentSort>("due_at_asc");
  const [selectedId, setSelectedId] = useState<string | null>(search.adjustment ?? null);
  const [focusRequest, setFocusRequest] = useState(0);
  const filters = { q, kind, status, destination, due, sort };
  const paging = useCursorPaging(filters, ADJUSTMENT_PAGE_SIZE);

  const linked = search.adjustment;
  useEffect(() => {
    if (linked) setSelectedId(linked);
  }, [linked]);

  const list = useApiQuery({
    queryKey: [...ADJUSTMENTS_KEY, "list", { ...filters, cursor: paging.cursor }],
    pollMs: ADJUSTMENT_POLL_MS,
    placeholderData: keepPreviousData,
    request: ({ signal, headers }) =>
      api.GET("/admin/payment-adjustments", {
        params: {
          query: {
            ...(status !== "all" ? { status } : {}),
            ...(kind !== "all" ? { kind } : {}),
            ...(destination !== "all" ? { has_refund_destination: destination === "ready" } : {}),
            ...(due === "overdue" ? { overdue: true } : {}),
            ...(q ? { q } : {}),
            ...(sort !== "due_at_asc" ? { sort } : {}),
            ...(paging.cursor ? { cursor: paging.cursor } : {}),
            limit: ADJUSTMENT_PAGE_SIZE,
          },
        },
        signal,
        headers,
      }),
  });

  // Rekening tujuan hanya ada pada refund: filter rekening menyiratkan jenis refund, dan koreksi mengosongkannya.
  function changeKind(next: AdjustmentKind | "all") {
    setKind(next);
    if (next === "correction") setDestination("all");
  }
  function changeDestination(next: DestinationFilter) {
    setDestination(next);
    if (next !== "all") setKind("refund");
  }

  function select(id: string) {
    setSelectedId(id);
    void navigate({ search: (prev) => ({ ...prev, adjustment: id }), replace: true });
    setFocusRequest((n) => n + 1);
  }

  const columns = useMemo<ColumnDef<Adjustment>[]>(
    () => [
      {
        id: "due_at",
        header: "Tenggat",
        meta: { cellClassName: "whitespace-nowrap" },
        cell: ({ row }) => {
          const a = row.original;
          if (!a.due_at) return <span className="text-text-muted">Tanpa tenggat</span>;
          return (
            <span className="flex flex-col items-start gap-1">
              {formatDate(a.due_at)}
              {a.overdue ? <Badge tone="danger">Lewat tenggat</Badge> : null}
            </span>
          );
        },
      },
      {
        id: "member",
        header: "Alumni",
        meta: { rowHeader: true },
        cell: ({ row }) => {
          const a = row.original;
          return (
            <button
              type="button"
              aria-current={a.id === selectedId ? "true" : undefined}
              onClick={() => select(a.id)}
              className="flex min-h-11 flex-col items-start justify-center text-left"
            >
              <span className="font-semibold text-primary underline-offset-2 hover:underline">
                {memberName(a.payment.member)}
              </span>
              <span className="text-xs font-normal text-text-muted">{memberSubtitle(a.payment.member)}</span>
            </button>
          );
        },
      },
      {
        id: "payment",
        header: "Pembayaran asal",
        cell: ({ row }) => (
          <span className="flex flex-col">
            {paymentTypeText(row.original.payment)}
            <span className="text-xs text-text-muted">{formatRupiah(row.original.payment.amount)}</span>
          </span>
        ),
      },
      {
        id: "kind",
        header: "Jenis",
        cell: ({ row }) => ADJUSTMENT_KIND_LABEL[row.original.kind],
      },
      {
        id: "amount",
        header: "Nominal",
        meta: { align: "right", cellClassName: "whitespace-nowrap" },
        cell: ({ row }) => formatRupiah(row.original.amount),
      },
      {
        id: "destination",
        header: "Rekening tujuan",
        cell: ({ row }) => <DestinationBadge a={row.original} />,
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <AdjustmentStatusBadge status={row.original.status} />,
      },
    ],
    [selectedId],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <SearchInput
          label="Cari"
          value={q}
          onValueChange={setQ}
          placeholder="Nama atau nomor KTA"
          className="flex-[1_1_220px]"
        />
        <Field label="Jenis" className="flex-[0_1_160px]">
          {(a11y) => (
            <Select {...a11y} size="sm" options={KIND_OPTIONS} value={kind} onValueChange={changeKind} />
          )}
        </Field>
        <Field label="Status" className="flex-[0_1_180px]">
          {(a11y) => (
            <Select {...a11y} size="sm" options={STATUS_OPTIONS} value={status} onValueChange={setStatus} />
          )}
        </Field>
        <Field label="Rekening tujuan" className="flex-[0_1_190px]">
          {(a11y) => (
            <Select
              {...a11y}
              size="sm"
              options={DESTINATION_OPTIONS}
              value={destination}
              onValueChange={changeDestination}
            />
          )}
        </Field>
        <Field label="Tenggat" className="flex-[0_1_170px]">
          {(a11y) => <Select {...a11y} size="sm" options={DUE_OPTIONS} value={due} onValueChange={setDue} />}
        </Field>
        <Field label="Urutan" className="flex-[0_1_180px]">
          {(a11y) => (
            <Select {...a11y} size="sm" options={SORT_OPTIONS} value={sort} onValueChange={setSort} />
          )}
        </Field>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <section aria-label="Daftar penyesuaian" className="min-w-0 flex-[3_1_520px]">
          <DataTable<Adjustment>
            caption="Daftar penyesuaian"
            columns={columns}
            data={list.data?.items}
            getRowId={(a) => a.id}
            status={list.status}
            error={list.error}
            onRetry={() => void list.refetch()}
            isFetching={list.isFetching && list.isPlaceholderData}
            total={list.data?.total}
            activeRowId={selectedId}
            rowClassName={(a) => (a.overdue ? "bg-danger-bg/40" : undefined)}
            minWidth={760}
            pagination={{
              pageIndex: paging.pageIndex,
              pageSize: ADJUSTMENT_PAGE_SIZE,
              nextCursor: list.data?.next_cursor,
              onNext: paging.next,
              onPrev: paging.prev,
            }}
            emptyState={
              <EmptyState
                compact
                title={q ? "Tidak ada penyesuaian yang cocok" : "Tidak ada penyesuaian"}
                description={
                  status === "pending"
                    ? "Tidak ada refund atau koreksi yang menunggu proses dengan filter ini."
                    : "Ubah kata kunci atau filter."
                }
              />
            }
          />
        </section>
        <div className="min-w-0 flex-[2_1_340px]">
          {selectedId ? (
            <AdjustmentPanel key={selectedId} adjustmentId={selectedId} focusRequest={focusRequest} />
          ) : (
            <div className="rounded-lg border border-dashed border-border bg-surface">
              <EmptyState
                compact
                title="Pilih penyesuaian"
                description="Pilih nama alumni pada daftar untuk melihat rincian, rekening tujuan dan memproses refund."
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
