import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ImageOff, Plus, ScanLine, Settings2 } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../../api/client";
import { useApiMutation } from "../../api/query";
import { useAuth } from "../../auth/session";
import { Badge, EVENT_STATUS, EventStatusBadge } from "../../components/ui/Badge";
import { Button, buttonClass } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { DataTable, RowActions, useCursorPaging } from "../../components/ui/DataTable";
import { Field } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Input";
import { PageHeader } from "../../components/ui/PageHeader";
import { SearchInput } from "../../components/ui/SearchInput";
import { EmptyState } from "../../components/ui/States";
import {
  type AdminEventSort,
  type AdminEventSummary,
  EVENT_PAGE_SIZE,
  type EventListFilters,
  type EventStatus,
  eventKeys,
  useEventCategories,
  useEventList,
} from "./api";
import { EventCategoriesSheet } from "./EventCategoriesSheet";
import { EVENT_SORT_OPTIONS, formatTableDate } from "./labels";

const STATUS_OPTIONS: { value: EventStatus | "all"; label: string }[] = [
  { value: "all", label: "Semua status" },
  ...(Object.keys(EVENT_STATUS) as EventStatus[]).map((s) => ({ value: s, label: EVENT_STATUS[s].label })),
];

/**
 * Tabel Event dan Tiket (guideline p14, F-15): pencarian nama/lokasi (debounce), filter status dan kategori,
 * urutan dan paging kursor server, kolom Nama Event, Gambar, Kategori, Lokasi, Buka/Tutup Daftar, Total Tiket, Sisa
 * Tiket dan Kelola. Hapus hanya untuk event yang belum pernah memiliki tiket (AC F15-2); event bertiket dibatalkan
 * dari halaman detail dengan alur notifikasi/refund.
 */
export function EventListPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<EventListFilters>({
    q: "",
    status: "all",
    categoryId: "",
    sort: "starts_at_desc",
  });
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [toDelete, setToDelete] = useState<AdminEventSummary | null>(null);
  const paging = useCursorPaging(filters, EVENT_PAGE_SIZE);
  const list = useEventList(filters, paging.cursor);
  const categories = useEventCategories();

  const remove = useApiMutation<void, AdminEventSummary>({
    request: (e) =>
      api.DELETE("/admin/events/{eventId}", {
        params: { path: { eventId: e.id }, header: { "If-Match": e.version } },
      }),
    successMessage: (_d, e) => `Event "${e.title}" dihapus.`,
    onSuccess: async () => {
      setToDelete(null);
      await queryClient.invalidateQueries({ queryKey: eventKeys.lists });
    },
    onError: () => {
      // Event berubah atau sudah bertiket (409): tutup dialog dan muat ulang baris terbaru.
      setToDelete(null);
      void queryClient.invalidateQueries({ queryKey: eventKeys.lists });
    },
  });

  const set = <K extends keyof EventListFilters>(key: K, value: EventListFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const categoryOptions = useMemo(
    () => [
      { value: "", label: "Semua kategori" },
      ...(categories.data?.items ?? []).map((c) => ({
        value: c.id,
        label: c.active ? c.label : `${c.label} (nonaktif)`,
      })),
    ],
    [categories.data],
  );

  const columns = useMemo<ColumnDef<AdminEventSummary>[]>(
    () => [
      {
        id: "title",
        header: "Nama Event",
        meta: { rowHeader: true, cellClassName: "min-w-48" },
        cell: ({ row }) => {
          const e = row.original;
          return (
            <span className="flex flex-col items-start gap-1">
              <Link
                to="/events/$eventId"
                params={{ eventId: e.id }}
                className="inline-flex min-h-11 items-center font-semibold text-primary underline-offset-2 hover:underline"
              >
                {e.title}
              </Link>
              <EventStatusBadge status={e.status} />
            </span>
          );
        },
      },
      {
        id: "cover",
        header: "Gambar",
        cell: ({ row }) =>
          row.original.cover_url ? (
            <img
              src={row.original.cover_url}
              alt=""
              referrerPolicy="no-referrer"
              className="h-10 w-16 rounded-sm bg-neutral-100 object-cover"
            />
          ) : (
            <span className="flex h-10 w-16 items-center justify-center rounded-sm bg-neutral-100 text-text-muted">
              <ImageOff aria-hidden="true" className="size-4" />
              <span className="sr-only">Tanpa gambar</span>
            </span>
          ),
      },
      {
        id: "category",
        header: "Kategori",
        cell: ({ row }) =>
          row.original.category ? (
            <Badge tone="neutral">{row.original.category.label}</Badge>
          ) : (
            <span className="text-text-muted">-</span>
          ),
      },
      {
        id: "location",
        header: "Lokasi",
        meta: { cellClassName: "max-w-48" },
        cell: ({ row }) => (
          <span className="line-clamp-2 break-words" title={row.original.location_name ?? undefined}>
            {row.original.location_name ?? "-"}
          </span>
        ),
      },
      {
        id: "registration_opens_at",
        header: "Buka Daftar",
        meta: { cellClassName: "whitespace-nowrap" },
        cell: ({ row }) => formatTableDate(row.original.registration_opens_at, row.original.timezone),
      },
      {
        id: "registration_closes_at",
        header: "Tutup Daftar",
        meta: { cellClassName: "whitespace-nowrap" },
        cell: ({ row }) => formatTableDate(row.original.registration_closes_at, row.original.timezone),
      },
      {
        id: "seats_total",
        header: "Total Tiket",
        meta: { align: "right" },
        cell: ({ row }) => row.original.seats_total.toLocaleString("id-ID"),
      },
      {
        id: "seats_available",
        header: "Sisa Tiket",
        meta: { align: "right" },
        cell: ({ row }) => {
          const e = row.original;
          if (e.status === "cancelled") return <span className="text-text-muted">Dibatalkan</span>;
          return (
            <span className="flex flex-col items-end gap-0.5">
              <Badge tone={e.seats_available === 0 ? "danger" : "success"}>
                {e.seats_available === 0 ? "Habis" : e.seats_available.toLocaleString("id-ID")}
              </Badge>
              <span className="whitespace-nowrap text-xs text-text-muted">
                Ditahan {e.held_quantity} | Terbayar {e.paid_quantity}
              </span>
            </span>
          );
        },
      },
    ],
    [],
  );

  const filtered = filters.q !== "" || filters.status !== "all" || filters.categoryId !== "";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Event dan Tiket"
        description="Kegiatan alumni, periode pendaftaran, kuota, tiket peserta dan pembatalan."
        actions={
          <>
            {auth.can("events.checkin") ? (
              <Link to="/events/checkin" className={buttonClass({ variant: "outline", size: "sm" })}>
                <ScanLine aria-hidden="true" className="size-4" />
                Check-in Tiket
              </Link>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Settings2 aria-hidden="true" className="size-4" />}
              onClick={() => setCategoriesOpen(true)}
            >
              Manajemen Kategori
            </Button>
            <Link to="/events/new" className={buttonClass({ variant: "gradient", size: "sm" })}>
              <Plus aria-hidden="true" className="size-4" />
              Buat Event Baru
            </Link>
          </>
        }
      />

      <DataTable<AdminEventSummary>
        caption="Daftar event"
        columns={columns}
        data={list.data?.items}
        getRowId={(e) => e.id}
        status={list.status}
        error={list.error}
        onRetry={() => void list.refetch()}
        isFetching={list.isFetching && list.isPlaceholderData}
        total={list.data?.total}
        minWidth={960}
        pagination={{
          pageIndex: paging.pageIndex,
          pageSize: EVENT_PAGE_SIZE,
          nextCursor: list.data?.next_cursor,
          onNext: paging.next,
          onPrev: paging.prev,
        }}
        toolbar={
          <>
            <SearchInput
              label="Cari event"
              labelHidden
              value={filters.q}
              onValueChange={(v) => set("q", v)}
              placeholder="Cari nama event atau lokasi..."
              className="flex-[1_1_260px]"
            />
            <Field label="Status" className="flex-[0_1_200px]">
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
            <Field label="Kategori" className="flex-[0_1_200px]">
              {(a11y) => (
                <Select
                  {...a11y}
                  size="sm"
                  options={categoryOptions}
                  value={filters.categoryId}
                  onValueChange={(v) => set("categoryId", v)}
                />
              )}
            </Field>
            <Field label="Urutkan" className="flex-[0_1_220px]">
              {(a11y) => (
                <Select<AdminEventSort>
                  {...a11y}
                  size="sm"
                  options={EVENT_SORT_OPTIONS}
                  value={filters.sort}
                  onValueChange={(v) => set("sort", v)}
                />
              )}
            </Field>
          </>
        }
        rowActions={(e) => (
          <RowActions
            edit={
              e.status === "done" || e.status === "cancelled"
                ? undefined
                : {
                    label: `Ubah ${e.title}`,
                    onClick: () =>
                      void navigate({ to: "/events/$eventId", params: { eventId: e.id }, search: { tab: "edit" } }),
                  }
            }
            remove={{
              label: e.has_tickets
                ? `Hapus ${e.title} tidak tersedia: event sudah memiliki tiket, gunakan pembatalan`
                : `Hapus ${e.title}`,
              onClick: () => setToDelete(e),
              disabled: e.has_tickets,
            }}
          />
        )}
        emptyState={
          <EmptyState
            compact
            title={filtered ? "Tidak ada event yang cocok" : "Belum ada event"}
            description={
              filtered
                ? "Ubah kata kunci atau filter."
                : "Buat event pertama lalu terbitkan agar anggota dapat mendaftar."
            }
            action={
              filtered ? undefined : (
                <Link to="/events/new" className={buttonClass({ variant: "primary", size: "sm" })}>
                  Buat Event Baru
                </Link>
              )
            }
          />
        }
      />

      <EventCategoriesSheet open={categoriesOpen} onClose={() => setCategoriesOpen(false)} />

      <ConfirmDialog
        open={toDelete !== null}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) remove.mutate(toDelete);
        }}
        pending={remove.isPending}
        title="Hapus event?"
        description={toDelete ? `"${toDelete.title}" akan dihapus permanen.` : undefined}
        confirmLabel="Hapus event"
        acknowledgement="Saya memahami event ini dihapus dan tidak dapat dikembalikan."
      >
        <p className="text-sm">
          Hapus hanya untuk event yang belum pernah memiliki tiket. Event yang sudah memiliki tiket harus dibatalkan
          agar peserta diberi notifikasi dan refund tercatat (AC F15-2).
        </p>
      </ConfirmDialog>
    </div>
  );
}
