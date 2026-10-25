import type { components } from "@kapdh/contracts";
import { keepPreviousData } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Clock, Eye, Flag, Siren } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../../api/client";
import { useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";
import { Badge, ReportStatusBadge } from "../../components/ui/Badge";
import { Card, StatCard } from "../../components/ui/Card";
import { Checkbox } from "../../components/ui/Choice";
import { DataTable, useCursorPaging } from "../../components/ui/DataTable";
import { Field } from "../../components/ui/FormField";
import { Select, type SelectOption } from "../../components/ui/Input";
import { PageHeader } from "../../components/ui/PageHeader";
import { SearchInput } from "../../components/ui/SearchInput";
import { EmptyState, ForbiddenState } from "../../components/ui/States";
import { formatShortDateTime } from "../../lib/format";
import { DELETED_ACCOUNT_LABEL } from "../../lib/labels";
import { CATEGORY_LABEL, PriorityBadge, REPORTS_KEY, TARGET_LABEL } from "./labels";

type Item = components["schemas"]["AdminModerationReportItem"];
type StatusFilter = components["schemas"]["AdminModerationStatusFilter"];
type Sort = components["schemas"]["AdminModerationSort"];
type Category = components["schemas"]["ModerationReportCategory"];
type Priority = components["schemas"]["ModerationReportPriority"];
type Target = components["schemas"]["ModerationTargetType"];

export const REPORT_PAGE_SIZE = 20;
/** Antrean diperbarui berkala; hanya refetch berkala yang berlabel latar (AC F02-5). */
export const REPORT_POLL_MS = 60_000;

const STATUS_OPTIONS = [
  { value: "active", label: "Perlu ditangani" },
  { value: "open", label: "Terbuka" },
  { value: "in_review", label: "Ditinjau" },
  { value: "resolved", label: "Selesai" },
  { value: "dismissed", label: "Diabaikan" },
  { value: "all", label: "Semua status" },
] as const satisfies readonly { value: StatusFilter; label: string }[];
const PRIORITY_OPTIONS = [
  { value: "", label: "Semua prioritas" },
  { value: "urgent", label: "Mendesak" },
  { value: "normal", label: "Normal" },
] as const;
const CATEGORY_OPTIONS: readonly SelectOption<Category | "">[] = [
  { value: "", label: "Semua kategori" },
  ...(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => ({ value: c, label: CATEGORY_LABEL[c] })),
];
const TARGET_OPTIONS: readonly SelectOption<Target | "">[] = [
  { value: "", label: "Semua objek" },
  ...(Object.keys(TARGET_LABEL) as Target[]).map((t) => ({ value: t, label: TARGET_LABEL[t] })),
];
const SORT_OPTIONS = [
  { value: "due", label: "Paling mendesak" },
  { value: "newest", label: "Terbaru" },
  { value: "oldest", label: "Terlama" },
] as const satisfies readonly { value: Sort; label: string }[];

/** Pihak terlapor/pemohon untuk sel tabel; laporan grup tanpa subjek memakai nama grup (PRD 3.12). */
export function subjectText(r: Pick<Item, "subject" | "room_name" | "target_type">): string {
  if (r.subject) return r.subject.full_name;
  if (r.target_type === "room") return r.room_name ? `Grup ${r.room_name}` : "Grup";
  return DELETED_ACCOUNT_LABEL;
}

/**
 * Antrean moderasi (F-12, F-15; izin moderation.read): laporan aktif urut paling mendesak (ancaman/keselamatan dan
 * konten seksual 24 jam, lainnya 2 hari kerja; v3.2, keputusan PP K5), ringkasan hitungan, filter
 * status/prioritas/kategori/objek/lewat target dan pencarian pihak terlapor dengan paging server. Antrean tidak
 * memuat bukti maupun identitas pelapor (minimisasi PRD 3.12); laporan yang menyangkut akun alumni tertaut admin
 * sendiri tidak pernah tampil (konflik kepentingan, AC F12-2).
 */
export function ModerationPage() {
  const auth = useAuth();
  return (
    <>
      <PageHeader
        title="Moderasi"
        description="Laporan pengguna, pesan dan grup. Target penanganan: ancaman/keselamatan dan konten seksual 24 jam, laporan lain 2 hari kerja."
      />
      {auth.can("moderation.read") ? (
        <ModerationQueue />
      ) : (
        <Card>
          <ForbiddenState description="Antrean dan bukti laporan memerlukan izin Membaca laporan moderasi (moderation.read). Hubungi Super Admin bila Anda memerlukannya." />
        </Card>
      )}
    </>
  );
}

function ModerationQueue() {
  const [status, setStatus] = useState<StatusFilter>("active");
  const [priority, setPriority] = useState<Priority | "">("");
  const [category, setCategory] = useState<Category | "">("");
  const [targetType, setTargetType] = useState<Target | "">("");
  const [overdue, setOverdue] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("due");
  const filters = { status, priority, category, targetType, overdue, q, sort };
  const paging = useCursorPaging(filters, REPORT_PAGE_SIZE);
  const list = useApiQuery({
    queryKey: [...REPORTS_KEY, "list", { ...filters, cursor: paging.cursor }],
    placeholderData: keepPreviousData,
    pollMs: REPORT_POLL_MS,
    request: ({ signal, headers }) =>
      api.GET("/admin/reports", {
        params: {
          query: {
            status,
            sort,
            limit: REPORT_PAGE_SIZE,
            ...(priority ? { priority } : {}),
            ...(category ? { category } : {}),
            ...(targetType ? { target_type: targetType } : {}),
            ...(overdue ? { overdue: true } : {}),
            ...(q ? { q } : {}),
            ...(paging.cursor ? { cursor: paging.cursor } : {}),
          },
        },
        signal,
        headers,
      }),
  });

  const columns = useMemo<ColumnDef<Item>[]>(
    () => [
      {
        id: "report",
        header: "Laporan",
        meta: { rowHeader: true },
        cell: ({ row }) => {
          const r = row.original;
          return (
            <span className="flex flex-col items-start gap-1">
              <Link
                to="/moderation/$reportId"
                params={{ reportId: r.id }}
                className="font-semibold text-primary underline-offset-2 hover:underline"
                aria-label={`Buka laporan ${CATEGORY_LABEL[r.category]} terhadap ${subjectText(r)}`}
              >
                {CATEGORY_LABEL[r.category]}
              </Link>
              <PriorityBadge priority={r.priority} />
            </span>
          );
        },
      },
      {
        id: "subject",
        header: "Pihak terlapor",
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span className="font-medium">{subjectText(row.original)}</span>
            <span className="text-xs text-text-muted">
              {row.original.subject?.member_number ??
                (row.original.room_name && row.original.subject ? `di grup ${row.original.room_name}` : "")}
            </span>
          </span>
        ),
      },
      { id: "target", header: "Objek", cell: ({ row }) => TARGET_LABEL[row.original.target_type] },
      {
        id: "created_at",
        header: "Dibuat (WIB)",
        meta: { cellClassName: "whitespace-nowrap" },
        cell: ({ row }) => formatShortDateTime(row.original.created_at),
      },
      {
        id: "due",
        header: "Target penanganan",
        cell: ({ row }) => (
          <span className="flex flex-col items-start gap-1">
            <span className="whitespace-nowrap">{formatShortDateTime(row.original.due_at)}</span>
            {row.original.overdue ? (
              <Badge tone="warning" icon={<Clock />}>
                Lewat target
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <span className="flex flex-col items-start gap-1">
            <ReportStatusBadge status={row.original.status} />
            {row.original.claimed_by ? (
              <span className="text-xs text-text-muted">
                Peninjau: {row.original.claimed_by.display_name}
              </span>
            ) : null}
          </span>
        ),
      },
    ],
    [],
  );

  const counts = list.data?.counts;
  return (
    <>
      <section aria-label="Ringkasan antrean" className="flex flex-wrap gap-4">
        <StatCard
          label="Terbuka"
          value={counts?.open ?? "-"}
          icon={<Flag />}
          tone="warning"
          loading={list.isPending}
        />
        <StatCard
          label="Sedang ditinjau"
          value={counts?.in_review ?? "-"}
          icon={<Eye />}
          tone="info"
          loading={list.isPending}
        />
        <StatCard
          label="Lewat target"
          value={counts?.overdue ?? "-"}
          icon={<Clock />}
          tone="danger"
          loading={list.isPending}
        />
        <StatCard
          label="Mendesak"
          value={counts?.urgent ?? "-"}
          icon={<Siren />}
          tone="danger"
          loading={list.isPending}
        />
      </section>
      <section aria-label="Antrean laporan">
        <DataTable<Item>
          caption="Antrean laporan moderasi"
          columns={columns}
          data={list.data?.items}
          getRowId={(r) => r.id}
          status={list.status}
          error={list.error}
          onRetry={() => void list.refetch()}
          isFetching={list.isFetching && list.isPlaceholderData}
          total={list.data?.total}
          minWidth={820}
          rowClassName={(r) => (r.overdue ? "bg-warning-bg/50" : undefined)}
          pagination={{
            pageIndex: paging.pageIndex,
            pageSize: REPORT_PAGE_SIZE,
            nextCursor: list.data?.next_cursor,
            onNext: paging.next,
            onPrev: paging.prev,
          }}
          toolbar={
            <>
              <SearchInput
                label="Cari pihak terlapor"
                value={q}
                onValueChange={setQ}
                placeholder="Nama atau nomor anggota"
                className="flex-[1_1_220px]"
              />
              <Field label="Status" className="flex-[0_1_180px]">
                {(a11y) => (
                  <Select
                    {...a11y}
                    size="sm"
                    options={STATUS_OPTIONS}
                    value={status}
                    onValueChange={setStatus}
                  />
                )}
              </Field>
              <Field label="Prioritas" className="flex-[0_1_160px]">
                {(a11y) => (
                  <Select
                    {...a11y}
                    size="sm"
                    options={PRIORITY_OPTIONS}
                    value={priority}
                    onValueChange={setPriority}
                  />
                )}
              </Field>
              <Field label="Kategori" className="flex-[0_1_180px]">
                {(a11y) => (
                  <Select<Category | "">
                    {...a11y}
                    size="sm"
                    options={CATEGORY_OPTIONS}
                    value={category}
                    onValueChange={setCategory}
                  />
                )}
              </Field>
              <Field label="Objek" className="flex-[0_1_150px]">
                {(a11y) => (
                  <Select<Target | "">
                    {...a11y}
                    size="sm"
                    options={TARGET_OPTIONS}
                    value={targetType}
                    onValueChange={setTargetType}
                  />
                )}
              </Field>
              <Field label="Urutkan" className="flex-[0_1_160px]">
                {(a11y) => (
                  <Select {...a11y} size="sm" options={SORT_OPTIONS} value={sort} onValueChange={setSort} />
                )}
              </Field>
              <Checkbox label="Hanya yang lewat target" checked={overdue} onCheckedChange={setOverdue} />
            </>
          }
          emptyState={
            <EmptyState
              compact
              title={
                status === "active"
                  ? "Tidak ada laporan yang perlu ditangani"
                  : "Tidak ada laporan yang cocok"
              }
              description="Ubah filter atau kata kunci untuk melihat laporan lain."
            />
          }
        />
      </section>
      <p className="text-xs text-text-muted">
        Bukti hanya dibuka di halaman detail dan setiap pembukaan tercatat di audit (AC F12-3).
      </p>
    </>
  );
}
