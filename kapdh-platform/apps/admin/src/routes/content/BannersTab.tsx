import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../../api/client";
import { useApiMutation, useApiQuery } from "../../api/query";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { DataTable, RowActions, useCursorPaging } from "../../components/ui/DataTable";
import { Field } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Input";
import { SearchInput } from "../../components/ui/SearchInput";
import { EmptyState } from "../../components/ui/States";
import { formatDate } from "../../lib/format";
import { BannerFormDialog } from "./BannerFormDialog";
import { targetText } from "./BannerTargetField";
import { type AdminBanner, CONTENT_PAGE_SIZE, contentKeys, invalidateContent, type S } from "./contentApi";
import { BANNER_STATE, BannerStateBadge, TargetUnavailableBadge } from "./labels";

type StateFilter = S["AdminBannerState"] | "all";

const STATE_OPTIONS: { value: StateFilter; label: string }[] = [
  { value: "all", label: "Semua status" },
  ...(Object.keys(BANNER_STATE) as S["AdminBannerState"][]).map((value) => ({
    value,
    label: BANNER_STATE[value].label,
  })),
];

const SORT_OPTIONS: { value: S["AdminBannerSort"]; label: string }[] = [
  { value: "sort_order_asc", label: "Urutan tampil Beranda" },
  { value: "starts_at_desc", label: "Tanggal publikasi terbaru" },
  { value: "updated_at_desc", label: "Terakhir diubah" },
  { value: "title_asc", label: "Judul A-Z" },
];

/** Masa tayang ringkas untuk kolom "Tgl Publikasi" (guideline p13): mulai, dan akhir bila ada. */
export function bannerWindowText(b: Pick<AdminBanner, "starts_at" | "ends_at">): string {
  return b.ends_at
    ? `${formatDate(b.starts_at)} - ${formatDate(b.ends_at)}`
    : `${formatDate(b.starts_at)} - tanpa batas`;
}

/**
 * Tab Banner (guideline p13, F-08, AC F08-2): judul, gambar, kategori (dari tujuan, kontrak AdminBannerTarget),
 * masa tayang, status tayang turunan server dan penanda tujuan yang tidak lagi tersedia, dengan cari, filter,
 * urutan dan paging server.
 */
export function BannersTab() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [state, setState] = useState<StateFilter>("all");
  const [sort, setSort] = useState<S["AdminBannerSort"]>("sort_order_asc");
  const [editing, setEditing] = useState<AdminBanner | "new" | null>(null);
  const [toDelete, setToDelete] = useState<AdminBanner | null>(null);
  const filters = { q, state, sort };
  const paging = useCursorPaging(filters, CONTENT_PAGE_SIZE);

  const list = useApiQuery({
    queryKey: contentKeys.bannerList({ ...filters, cursor: paging.cursor }),
    placeholderData: keepPreviousData,
    request: ({ signal, headers }) =>
      api.GET("/admin/content/banners", {
        params: {
          query: {
            ...(q ? { q } : {}),
            ...(state !== "all" ? { state } : {}),
            sort,
            ...(paging.cursor ? { cursor: paging.cursor } : {}),
            limit: CONTENT_PAGE_SIZE,
          },
        },
        signal,
        headers,
      }),
  });

  const remove = useApiMutation<unknown, AdminBanner>({
    intent: (b) => [b.id, b.version],
    request: (b) =>
      api.DELETE("/admin/content/banners/{bannerId}", {
        params: { path: { bannerId: b.id }, header: { "If-Match": b.version } },
      }),
    successMessage: (_, b) => `Banner "${b.title}" dihapus.`,
    onSuccess: async () => {
      setToDelete(null);
      await invalidateContent(queryClient);
    },
    onReloadLatest: () => {
      setToDelete(null);
      void invalidateContent(queryClient);
    },
  });

  const columns = useMemo<ColumnDef<AdminBanner>[]>(
    () => [
      {
        id: "title",
        header: "Judul",
        meta: { rowHeader: true },
        cell: ({ row }) => {
          const b = row.original;
          return (
            <span className="flex flex-col items-start gap-1 text-left">
              <span className="font-semibold">{b.title}</span>
              <span className="text-xs font-normal text-text-muted">{targetText(b.target)}</span>
              {!b.target.available ? <TargetUnavailableBadge /> : null}
            </span>
          );
        },
      },
      {
        id: "image",
        header: "Gambar",
        cell: ({ row }) => (
          // Dekoratif: judul banner menjadi nama baris.
          <img
            src={row.original.image.url}
            alt=""
            referrerPolicy="no-referrer"
            className="h-10 w-20 rounded-sm bg-neutral-100 object-cover"
          />
        ),
      },
      {
        id: "category",
        header: "Kategori",
        cell: ({ row }) =>
          row.original.target.category ? (
            <Badge tone="neutral">{row.original.target.category.label}</Badge>
          ) : (
            "-"
          ),
      },
      {
        id: "starts_at",
        header: "Tgl Publikasi",
        meta: { cellClassName: "whitespace-nowrap" },
        cell: ({ row }) => bannerWindowText(row.original),
      },
      {
        id: "state",
        header: "Status",
        cell: ({ row }) => <BannerStateBadge state={row.original.state} />,
      },
      {
        id: "sort_order",
        header: "Urutan",
        meta: { align: "right" },
        cell: ({ row }) => row.original.sort_order,
      },
    ],
    [],
  );

  const filtered = q !== "" || state !== "all";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <SearchInput
          label="Cari banner"
          value={q}
          onValueChange={setQ}
          placeholder="Cari judul banner..."
          className="flex-[1_1_240px]"
        />
        <Field label="Status" className="flex-[0_1_170px]">
          {(a11y) => (
            <Select {...a11y} size="sm" options={STATE_OPTIONS} value={state} onValueChange={setState} />
          )}
        </Field>
        <Field label="Urutan" className="flex-[0_1_220px]">
          {(a11y) => (
            <Select {...a11y} size="sm" options={SORT_OPTIONS} value={sort} onValueChange={setSort} />
          )}
        </Field>
        <Button
          size="sm"
          leftIcon={<Plus aria-hidden="true" className="size-4" />}
          onClick={() => setEditing("new")}
        >
          Buat Banner
        </Button>
      </div>

      <DataTable<AdminBanner>
        caption="Daftar banner"
        columns={columns}
        data={list.data?.items}
        getRowId={(b) => b.id}
        status={list.status}
        error={list.error}
        onRetry={() => void list.refetch()}
        isFetching={list.isFetching && list.isPlaceholderData}
        total={list.data?.total}
        minWidth={820}
        pagination={{
          pageIndex: paging.pageIndex,
          pageSize: CONTENT_PAGE_SIZE,
          nextCursor: list.data?.next_cursor,
          onNext: paging.next,
          onPrev: paging.prev,
        }}
        rowActions={(b) => (
          <RowActions
            edit={{ label: `Ubah banner ${b.title}`, onClick: () => setEditing(b) }}
            remove={{ label: `Hapus banner ${b.title}`, onClick: () => setToDelete(b) }}
          />
        )}
        emptyState={
          <EmptyState
            compact
            title={filtered ? "Tidak ada banner yang cocok" : "Belum ada banner"}
            description={filtered ? "Ubah kata kunci atau filter." : "Buat banner untuk Beranda aplikasi."}
          />
        }
      />

      {editing !== null ? (
        <BannerFormDialog banner={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
      <ConfirmDialog
        open={toDelete !== null}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) remove.mutate(toDelete);
        }}
        pending={remove.isPending}
        title="Hapus banner?"
        description={
          toDelete ? `Banner "${toDelete.title}" akan dihapus permanen dari Beranda aplikasi.` : undefined
        }
        confirmLabel="Hapus banner"
        acknowledgement="Saya memahami banner ini tidak dapat dikembalikan."
      >
        <p className="text-sm text-text-muted">
          Untuk menyembunyikan sementara, ubah banner menjadi nonaktif.
        </p>
      </ConfirmDialog>
    </div>
  );
}
