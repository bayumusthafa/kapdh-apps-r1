import type { components } from "@kapdh/contracts";
import { keepPreviousData } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { useApiQuery } from "../../api/query";
import { Badge, PaymentStageBadge } from "../../components/ui/Badge";
import { DataTable, useCursorPaging } from "../../components/ui/DataTable";
import { Field } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Input";
import { SearchInput } from "../../components/ui/SearchInput";
import { EmptyState } from "../../components/ui/States";
import { formatRelativeAge, formatRupiah, formatShortDateTime } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { memberName, memberSubtitle, paymentTypeText as typeText } from "./labels";
import { PaymentDecisionPanel } from "./PaymentDecisionPanel";
import { PAYMENTS_KEY } from "./queries";

type Item = components["schemas"]["AdminPaymentItem"];
type PaymentStatus = components["schemas"]["PaymentStatus"];
type PaymentType = components["schemas"]["PaymentType"];
type PaymentSort = components["schemas"]["AdminPaymentSort"];

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

/**
 * Pilihan Status prototipe screen_8 dan filter kontrak adminListPayments: "Menunggu" = `stage=awaiting_review`
 * (pending berbukti yang siap diputus; total sama dengan pill menu), bukan `status=pending` yang ikut memuat
 * instruksi tanpa bukti. "Semua" = tanpa status dan tanpa stage.
 */
type StatusFilter = "awaiting_review" | Exclude<PaymentStatus, "pending"> | "all";

const STATUS_OPTIONS = [
  { value: "awaiting_review", label: "Menunggu" },
  { value: "paid", label: "Disetujui" },
  { value: "rejected", label: "Ditolak" },
  { value: "cancelled", label: "Dibatalkan" },
  { value: "all", label: "Semua" },
] as const satisfies readonly { value: StatusFilter; label: string }[];

/** Urutan antrean "Menunggu" (kontrak AdminPaymentSort). Tiket mendekati hari H naik dengan batas review (PRD 4.4). */
type QueueSort = Extract<PaymentSort, "submitted_at_asc" | "review_due_at_asc">;
const SORT_OPTIONS = [
  { value: "submitted_at_asc", label: "Paling lama menunggu" },
  { value: "review_due_at_asc", label: "Batas review terdekat" },
] as const satisfies readonly { value: QueueSort; label: string }[];

function statusQuery(filter: StatusFilter): { stage?: "awaiting_review"; status?: PaymentStatus } {
  if (filter === "awaiting_review") return { stage: "awaiting_review" };
  if (filter === "all") return {};
  return { status: filter };
}

/**
 * Urutan per pilihan status: antrean menurut usia atau batas review; Disetujui/Ditolak keputusan terbaru dahulu
 * (`decided_at_desc`); Dibatalkan instruksi terbaru dahulu; Semua memakai urutan antrean bawaan.
 */
function sortFor(filter: StatusFilter, queueSort: QueueSort): PaymentSort | undefined {
  if (filter === "awaiting_review") return queueSort === "submitted_at_asc" ? undefined : queueSort;
  if (filter === "paid" || filter === "rejected") return "decided_at_desc";
  if (filter === "cancelled") return "created_at_desc";
  return undefined;
}

/** Kolom waktu pertama mengikuti pilihan status: waktu kirim bukti, waktu keputusan, atau waktu dibuat. */
function timeColumn(filter: StatusFilter): { header: string; value: (i: Item) => string | null } {
  if (filter === "paid" || filter === "rejected")
    return { header: "Diputus (WIB)", value: (i) => i.decided_at };
  if (filter === "cancelled") return { header: "Dibuat (WIB)", value: (i) => i.created_at };
  return { header: "Dikirim (WIB)", value: (i) => i.submitted_at };
}

export function paymentTypeText(item: Pick<Item, "type" | "event_title">): string {
  return typeText(item);
}

/**
 * Teks penanda lewat batas review (`overdue` dari server): iuran +1 hari kerja (prototipe screen_8); tiket paling
 * lambat pembukaan check-in event (PRD 4.4, D5), sehingga tidak selalu "1 hari kerja".
 */
export function overdueText(item: Pick<Item, "type">): string {
  return item.type === "ticket" ? "Lewat batas review" : "Lewat 1 hari kerja";
}

/**
 * Penanda tiket/event yang sudah dibatalkan sebelum keputusan (`event_cancelled`, `ticket_status`), agar pemutus
 * tahu sebelum membuka detail (kontrak adminListPayments, PRD 4.4). Null bila tidak ada.
 */
export function ticketMarker(item: Pick<Item, "event_cancelled" | "ticket_status" | "stage">): string | null {
  if (item.event_cancelled) return "Event dibatalkan";
  // Tiket ditolak ikut cancelled (AC F09-4); penanda hanya untuk pembatalan di luar keputusan pembayaran.
  if (item.stage === "rejected_final") return null;
  if (item.ticket_status === "cancelled") return "Tiket dibatalkan";
  if (item.ticket_status === "expired") return "Tiket kedaluwarsa";
  return null;
}

/**
 * Antrean verifikasi pembayaran (F-04, prototipe screen_8): cari (debounce), filter jenis & status (termasuk
 * Semua), urutan, paging kursor server dengan ringkasan "Menampilkan x dari y", usia antrean, penanda lewat batas
 * review, baris terpilih bergaris hijau, dan panel keputusan di samping (menyusun ke bawah di layar sempit).
 * Antrean diurutkan server berdasarkan waktu kirim bukti, terlama dulu (PRD 3.4). Pemilik yang akunnya sudah
 * dihapus tampil sebagai "Akun dihapus" (AC F14-4). Pilihan payment disimpan di URL (?payment=) sehingga tautan
 * dari tab Penyesuaian membuka panel yang sama.
 */
export function VerificationTab() {
  const search = useSearch({ from: "/app/payments" });
  const navigate = useNavigate({ from: "/payments" });
  const [q, setQ] = useState("");
  const [type, setType] = useState<PaymentType | "all">("all");
  const [status, setStatus] = useState<StatusFilter>("awaiting_review");
  const [queueSort, setQueueSort] = useState<QueueSort>("submitted_at_asc");
  const [selectedId, setSelectedId] = useState<string | null>(search.payment ?? null);
  /** Naik setiap admin memilih baris; panel memindah fokus ke judul detail setelah detail termuat. */
  const [focusRequest, setFocusRequest] = useState(0);
  const now = useNow();
  const sort = sortFor(status, queueSort);
  const filters = { q, type, status, sort };
  const paging = useCursorPaging(filters, PAYMENT_PAGE_SIZE);

  // Tautan dari luar tab (mis. "Buka pembayaran asal" di tab Penyesuaian) mengganti pilihan.
  const linked = search.payment;
  useEffect(() => {
    if (linked) setSelectedId(linked);
  }, [linked]);

  const list = useApiQuery({
    queryKey: [...PAYMENTS_KEY, "list", { ...filters, cursor: paging.cursor }],
    pollMs: PAYMENT_POLL_MS,
    placeholderData: keepPreviousData,
    request: ({ signal, headers }) =>
      api.GET("/admin/payments", {
        params: {
          query: {
            ...statusQuery(status),
            ...(type !== "all" ? { type } : {}),
            ...(q ? { q } : {}),
            ...(sort ? { sort } : {}),
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
    void navigate({ search: (prev) => ({ ...prev, payment: id }), replace: true });
    // Fokus dipindah ke judul detail oleh panel SETELAH detail termuat (judul belum ada selama memuat), agar
    // pengguna keyboard/pembaca layar langsung berada di panel keputusan (N-11).
    setFocusRequest((n) => n + 1);
  }

  const showAge = status === "awaiting_review";
  const time = timeColumn(status);
  const columns = useMemo<ColumnDef<Item>[]>(
    () => [
      {
        id: "time",
        header: time.header,
        cell: ({ row }) => formatShortDateTime(time.value(row.original)),
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
                {memberName(p.member)}
              </span>
              <span className="text-xs font-normal text-text-muted">{memberSubtitle(p.member)}</span>
            </button>
          );
        },
      },
      {
        id: "type",
        header: "Jenis",
        cell: ({ row }) => {
          const marker = ticketMarker(row.original);
          return (
            <span className="flex flex-col items-start gap-1">
              {paymentTypeText(row.original)}
              {marker ? <Badge tone="warning">{marker}</Badge> : null}
            </span>
          );
        },
      },
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
                <Badge tone="warning">{overdueText(row.original)}</Badge>
              ) : (
                formatRelativeAge(row.original.submitted_at, now)
              ),
          }
        : {
            id: "status",
            header: "Status",
            cell: ({ row }) => (
              <span className="flex flex-wrap items-center gap-1.5">
                <PaymentStageBadge stage={row.original.stage} />
                {/* Penanda lewat SLA juga berupa teks, tidak hanya warna latar baris (PRD 4.5). */}
                {row.original.overdue && row.original.stage === "awaiting_review" ? (
                  <Badge tone="warning">{overdueText(row.original)}</Badge>
                ) : null}
              </span>
            ),
          },
    ],
    // `select` hanya memakai setState/navigate sehingga aman tidak dijadikan dependensi. Definisi kolom yang dibuat
    // ulang (baris aktif, jam) tidak memasang ulang sel karena DataTable merender templat lewat komponen stabil.
    [selectedId, showAge, now, status],
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
        {status === "awaiting_review" ? (
          <Field label="Urutan" className="flex-[0_0_230px]">
            {(a11y) => (
              <Select
                {...a11y}
                size="sm"
                options={SORT_OPTIONS}
                value={queueSort}
                onValueChange={setQueueSort}
              />
            )}
          </Field>
        ) : null}
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
            rowClassName={(p) =>
              p.overdue && p.stage === "awaiting_review" ? "bg-warning-bg/50" : undefined
            }
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
