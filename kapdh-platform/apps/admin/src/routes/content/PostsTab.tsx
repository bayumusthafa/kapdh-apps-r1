import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ImageOff, Plus, Settings2 } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../../api/client";
import { useApiMutation, useApiQuery } from "../../api/query";
import { Badge } from "../../components/ui/Badge";
import { Button, buttonClass } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { DataTable, RowActions, useCursorPaging } from "../../components/ui/DataTable";
import { Field } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Input";
import { SearchInput } from "../../components/ui/SearchInput";
import { EmptyState } from "../../components/ui/States";
import { formatDate, formatDateTime } from "../../lib/format";
import {
  type AdminPostState,
  type AdminPostSummary,
  CONTENT_PAGE_SIZE,
  contentKeys,
  fetchPostCategoryOptions,
  invalidateContent,
  type S,
} from "./contentApi";
import { POST_STATE, PostStateBadge } from "./labels";

type StateFilter = AdminPostState | "all";

const STATE_OPTIONS: { value: StateFilter; label: string }[] = [
  { value: "all", label: "Semua status" },
  ...(Object.keys(POST_STATE) as AdminPostState[]).map((value) => ({
    value,
    label: POST_STATE[value].label,
  })),
];

const SORT_OPTIONS: { value: S["AdminPostSort"]; label: string }[] = [
  { value: "updated_at_desc", label: "Terakhir diubah" },
  { value: "published_at_desc", label: "Tanggal publikasi terbaru" },
  { value: "created_at_desc", label: "Terakhir dibuat" },
  { value: "title_asc", label: "Judul A-Z" },
];

/** Hapus hanya untuk draf atau arsip; berita tampil/terjadwal diarsipkan dahulu (kontrak adminDeletePost). */
export function canDeletePost(state: AdminPostState): boolean {
  return state === "draft" || state === "archived";
}

/** Teks kolom "Tgl Publikasi" (guideline p13): jadwal ditampilkan lengkap dengan jam WIB. */
export function publicationText(post: Pick<AdminPostSummary, "state" | "published_at">): string {
  if (!post.published_at) return "-";
  return post.state === "scheduled" ? formatDateTime(post.published_at) : formatDate(post.published_at);
}

/**
 * Tab Berita / Feed Informasi (guideline p13, F-08, F-15): cari judul/slug (debounce), filter status dan kategori,
 * urutan dan paging kursor server, kolom judul, gambar, kategori, status, tanggal publikasi dan aksi kelola.
 */
export function PostsTab({ onManageCategories }: { onManageCategories: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [state, setState] = useState<StateFilter>("all");
  const [categoryId, setCategoryId] = useState("all");
  const [sort, setSort] = useState<S["AdminPostSort"]>("updated_at_desc");
  const [toDelete, setToDelete] = useState<AdminPostSummary | null>(null);
  const filters = { q, state, categoryId, sort };
  const paging = useCursorPaging(filters, CONTENT_PAGE_SIZE);

  const list = useApiQuery({
    queryKey: contentKeys.postList({ ...filters, cursor: paging.cursor }),
    placeholderData: keepPreviousData,
    request: ({ signal, headers }) =>
      api.GET("/admin/content/posts", {
        params: {
          query: {
            ...(q ? { q } : {}),
            ...(state !== "all" ? { state } : {}),
            ...(categoryId !== "all" ? { category_id: categoryId } : {}),
            sort,
            ...(paging.cursor ? { cursor: paging.cursor } : {}),
            limit: CONTENT_PAGE_SIZE,
          },
        },
        signal,
        headers,
      }),
  });

  const categories = useApiQuery({
    queryKey: contentKeys.categoryOptions,
    staleTime: 60_000,
    request: (ctx) => fetchPostCategoryOptions(ctx),
  });
  const categoryOptions = useMemo(
    () => [
      { value: "all", label: "Semua kategori" },
      ...(categories.data?.items ?? []).map((c) => ({
        value: c.id,
        label: c.active ? c.label : `${c.label} (nonaktif)`,
      })),
    ],
    [categories.data],
  );

  const remove = useApiMutation<unknown, AdminPostSummary>({
    intent: (p) => [p.id, p.version],
    request: (p) =>
      api.DELETE("/admin/content/posts/{postId}", {
        params: { path: { postId: p.id }, header: { "If-Match": p.version } },
      }),
    successMessage: (_, p) => `Berita "${p.title}" dihapus.`,
    onSuccess: async (_, p) => {
      setToDelete(null);
      queryClient.removeQueries({ queryKey: contentKeys.post(p.id) });
      await invalidateContent(queryClient);
    },
    onReloadLatest: () => {
      // Berita berubah (mis. sudah diterbitkan) sejak tabel dimuat: tampilkan keadaan terbaru, jangan hapus.
      setToDelete(null);
      void invalidateContent(queryClient);
    },
  });

  const columns = useMemo<ColumnDef<AdminPostSummary>[]>(
    () => [
      {
        id: "title",
        header: "Judul Konten",
        meta: { rowHeader: true },
        cell: ({ row }) => (
          <Link
            to="/content/posts/$postId"
            params={{ postId: row.original.id }}
            className="flex min-h-11 flex-col justify-center text-left"
          >
            <span className="font-semibold text-primary underline-offset-2 hover:underline">
              {row.original.title}
            </span>
            <span className="text-xs font-normal text-text-muted">/{row.original.slug}</span>
          </Link>
        ),
      },
      {
        id: "cover",
        header: "Gambar",
        cell: ({ row }) =>
          row.original.cover ? (
            // Dekoratif: judul berita sudah menjadi nama baris.
            <img
              src={row.original.cover.url}
              alt=""
              referrerPolicy="no-referrer"
              className="h-10 w-16 rounded-sm bg-neutral-100 object-cover"
            />
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-text-muted">
              <ImageOff aria-hidden="true" className="size-4" />
              Tanpa gambar
            </span>
          ),
      },
      {
        id: "category",
        header: "Kategori",
        cell: ({ row }) =>
          row.original.category ? <Badge tone="neutral">{row.original.category.label}</Badge> : "-",
      },
      {
        id: "state",
        header: "Status",
        cell: ({ row }) => <PostStateBadge state={row.original.state} />,
      },
      {
        id: "published_at",
        header: "Tgl Publikasi",
        meta: { cellClassName: "whitespace-nowrap" },
        cell: ({ row }) => publicationText(row.original),
      },
    ],
    [],
  );

  const filtered = q !== "" || state !== "all" || categoryId !== "all";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <SearchInput
          label="Cari berita"
          value={q}
          onValueChange={setQ}
          placeholder="Cari judul konten..."
          className="flex-[1_1_240px]"
        />
        <Field label="Status" className="flex-[0_1_170px]">
          {(a11y) => (
            <Select {...a11y} size="sm" options={STATE_OPTIONS} value={state} onValueChange={setState} />
          )}
        </Field>
        <Field label="Kategori" className="flex-[0_1_190px]">
          {(a11y) => (
            <Select
              {...a11y}
              size="sm"
              options={categoryOptions}
              value={categoryId}
              onValueChange={setCategoryId}
            />
          )}
        </Field>
        <Field label="Urutan" className="flex-[0_1_210px]">
          {(a11y) => (
            <Select {...a11y} size="sm" options={SORT_OPTIONS} value={sort} onValueChange={setSort} />
          )}
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            leftIcon={<Settings2 aria-hidden="true" className="size-4" />}
            onClick={onManageCategories}
          >
            Manajemen Kategori
          </Button>
          <Link to="/content/posts/new" className={buttonClass({ size: "sm" })}>
            <Plus aria-hidden="true" className="size-4" />
            Buat Konten Baru
          </Link>
        </div>
      </div>

      <DataTable<AdminPostSummary>
        caption="Daftar berita"
        columns={columns}
        data={list.data?.items}
        getRowId={(p) => p.id}
        status={list.status}
        error={list.error}
        onRetry={() => void list.refetch()}
        isFetching={list.isFetching && list.isPlaceholderData}
        total={list.data?.total}
        minWidth={760}
        pagination={{
          pageIndex: paging.pageIndex,
          pageSize: CONTENT_PAGE_SIZE,
          nextCursor: list.data?.next_cursor,
          onNext: paging.next,
          onPrev: paging.prev,
        }}
        rowActions={(p) => (
          <RowActions
            edit={{
              label: `Ubah ${p.title}`,
              onClick: () => void navigate({ to: "/content/posts/$postId", params: { postId: p.id } }),
            }}
            remove={{
              label: canDeletePost(p.state)
                ? `Hapus ${p.title}`
                : `Hapus ${p.title} (arsipkan dahulu; hanya draf atau arsip yang dapat dihapus)`,
              disabled: !canDeletePost(p.state),
              onClick: () => setToDelete(p),
            }}
          />
        )}
        emptyState={
          <EmptyState
            compact
            title={filtered ? "Tidak ada berita yang cocok" : "Belum ada berita"}
            description={
              filtered
                ? "Ubah kata kunci atau filter."
                : "Buat berita pertama. Berita disimpan sebagai draf sebelum diterbitkan."
            }
            action={
              filtered ? null : (
                <Link to="/content/posts/new" className={buttonClass({ size: "sm" })}>
                  <Plus aria-hidden="true" className="size-4" />
                  Buat Konten Baru
                </Link>
              )
            }
          />
        }
      />

      <ConfirmDialog
        open={toDelete !== null}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) remove.mutate(toDelete);
        }}
        pending={remove.isPending}
        title="Hapus berita?"
        description={
          toDelete
            ? `"${toDelete.title}" (${POST_STATE[toDelete.state].label.toLowerCase()}) akan dihapus permanen beserta like-nya.`
            : undefined
        }
        confirmLabel="Hapus berita"
        acknowledgement="Saya memahami berita ini tidak dapat dikembalikan."
      >
        <p className="text-sm text-text-muted">
          Banner yang menunjuk berita ini akan ditandai &quot;Tujuan tidak tersedia&quot;. Untuk
          menyembunyikan sementara, gunakan Arsipkan.
        </p>
      </ConfirmDialog>
    </div>
  );
}
