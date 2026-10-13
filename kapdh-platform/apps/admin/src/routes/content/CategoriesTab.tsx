import { zodResolver } from "@hookform/resolvers/zod";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { CircleCheck, EyeOff, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import { toApiError } from "../../api/errors";
import { unwrap, useApiMutation, useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Switch } from "../../components/ui/Choice";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { DataTable, RowActions, useCursorPaging } from "../../components/ui/DataTable";
import { Dialog } from "../../components/ui/Dialog";
import { Field, FormError, FormField } from "../../components/ui/FormField";
import { Input, Select } from "../../components/ui/Input";
import { SearchInput } from "../../components/ui/SearchInput";
import { EmptyState } from "../../components/ui/States";
import { useToast } from "../../components/ui/Toast";
import { requiredText } from "../../lib/validation";
import { ConflictNotice } from "./ConflictNotice";
import {
  type AdminContentCategory,
  CONTENT_PAGE_SIZE,
  type ConflictState,
  conflictState,
  contentKeys,
  errorText,
  invalidateContent,
  type S,
  SLUG_HINT,
  SLUG_PATTERN,
  slugFromTitle,
} from "./contentApi";
import { useDeferredFocus } from "./useDeferredFocus";

type ActiveFilter = "all" | "true" | "false";

const ACTIVE_OPTIONS: { value: ActiveFilter; label: string }[] = [
  { value: "all", label: "Semua status" },
  { value: "true", label: "Aktif" },
  { value: "false", label: "Nonaktif" },
];

const SORT_OPTIONS: { value: S["AdminContentCategorySort"]; label: string }[] = [
  { value: "sort_order_asc", label: "Urutan tampil" },
  { value: "label_asc", label: "Label A-Z" },
  { value: "usage_desc", label: "Paling banyak dipakai" },
  { value: "updated_at_desc", label: "Terakhir diubah" },
];

/** Pemakai kategori berita, untuk "Dipakai 3 berita". */
const NOUN = "berita";

function CategoryStatusBadge({ active }: { active: boolean }) {
  return active ? (
    <Badge tone="success" icon={<CircleCheck />}>
      Aktif
    </Badge>
  ) : (
    <Badge tone="neutral" icon={<EyeOff />}>
      Nonaktif
    </Badge>
  );
}

/**
 * Tab Kategori (guideline p13 "Manajemen Kategori"): kategori berita dengan izin content.manage
 * (/admin/content/post-categories). Kategori event dikelola dari halaman Event & Tiket (guideline p14, tombol
 * "Manajemen Kategori"; /admin/content/event-categories dengan izin events.manage), sehingga satu layar saja yang
 * mengelolanya dan admin yang hanya memegang events.manage tetap dapat menjangkaunya (AC F15-1).
 */
export function CategoriesTab() {
  const auth = useAuth();
  return (
    <div className="flex flex-col gap-4">
      <CategoryManager />
      {auth.can("events.manage") ? (
        <p className="text-sm text-text-muted">
          Kategori event dikelola dari halaman{" "}
          <Link to="/events" className="font-medium text-primary underline underline-offset-2">
            Event dan Tiket
          </Link>{" "}
          melalui tombol Manajemen Kategori.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Tabel pengelolaan kategori berita: cari, filter aktif, urutan dan paging server, jumlah pemakaian, ubah dan hapus.
 * Kategori yang dipakai tidak dapat dihapus (server: FK RESTRICT) sehingga tombol hapus dinonaktifkan dengan alasan
 * dan admin diarahkan menonaktifkannya.
 */
function CategoryManager() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("all");
  const [sort, setSort] = useState<S["AdminContentCategorySort"]>("sort_order_asc");
  const [editing, setEditing] = useState<AdminContentCategory | "new" | null>(null);
  const [toDelete, setToDelete] = useState<AdminContentCategory | null>(null);
  const filters = { q, activeFilter, sort };
  const paging = useCursorPaging(filters, CONTENT_PAGE_SIZE);

  const list = useApiQuery({
    queryKey: contentKeys.categoryList({ ...filters, cursor: paging.cursor }),
    placeholderData: keepPreviousData,
    request: (init) =>
      api.GET("/admin/content/post-categories", {
        params: {
          query: {
            ...(q ? { q } : {}),
            ...(activeFilter !== "all" ? { active: activeFilter === "true" } : {}),
            sort,
            ...(paging.cursor ? { cursor: paging.cursor } : {}),
            limit: CONTENT_PAGE_SIZE,
          },
        },
        ...init,
      }),
  });

  const remove = useApiMutation<unknown, AdminContentCategory>({
    intent: (c) => [c.id, c.version],
    toastErrors: false,
    request: (c) =>
      api.DELETE("/admin/content/post-categories/{categoryId}", {
        params: { path: { categoryId: c.id }, header: { "If-Match": c.version } },
      }),
    successMessage: (_, c) => `Kategori "${c.label}" dihapus.`,
    onSuccess: async () => {
      setToDelete(null);
      await invalidateContent(queryClient);
    },
    onError: (error) => {
      setToDelete(null);
      // Kategori mulai dipakai sejak tabel dimuat (FK RESTRICT) atau sudah berubah: tampilkan alasan dan muat ulang.
      if (!error.reauthCancelled) toast.error(errorText(error));
      void invalidateContent(queryClient);
    },
  });

  const columns = useMemo<ColumnDef<AdminContentCategory>[]>(
    () => [
      {
        id: "label",
        header: "Label",
        meta: { rowHeader: true },
        cell: ({ row }) => <span className="font-semibold">{row.original.label}</span>,
      },
      {
        id: "slug",
        header: "Slug",
        cell: ({ row }) => <span className="text-text-muted">{row.original.slug}</span>,
      },
      {
        id: "sort_order",
        header: "Urutan",
        meta: { align: "right" },
        cell: ({ row }) => row.original.sort_order,
      },
      {
        id: "active",
        header: "Status",
        cell: ({ row }) => <CategoryStatusBadge active={row.original.active} />,
      },
      {
        id: "usage_count",
        header: "Dipakai",
        meta: { cellClassName: "whitespace-nowrap" },
        cell: ({ row }) =>
          row.original.usage_count > 0 ? `${row.original.usage_count} ${NOUN}` : `Belum dipakai`,
      },
    ],
    [],
  );

  const filtered = q !== "" || activeFilter !== "all";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <SearchInput
          label="Cari kategori berita"
          value={q}
          onValueChange={setQ}
          placeholder="Cari label atau slug..."
          maxLength={80}
          className="flex-[1_1_220px]"
        />
        <Field label="Status" className="flex-[0_1_160px]">
          {(a11y) => (
            <Select
              {...a11y}
              size="sm"
              options={ACTIVE_OPTIONS}
              value={activeFilter}
              onValueChange={setActiveFilter}
            />
          )}
        </Field>
        <Field label="Urutan" className="flex-[0_1_200px]">
          {(a11y) => (
            <Select {...a11y} size="sm" options={SORT_OPTIONS} value={sort} onValueChange={setSort} />
          )}
        </Field>
        <Button
          size="sm"
          leftIcon={<Plus aria-hidden="true" className="size-4" />}
          onClick={() => setEditing("new")}
        >
          Tambah Kategori
        </Button>
      </div>

      <DataTable<AdminContentCategory>
        caption="Kategori Berita"
        columns={columns}
        data={list.data?.items}
        getRowId={(c) => c.id}
        status={list.status}
        error={list.error}
        onRetry={() => void list.refetch()}
        isFetching={list.isFetching && list.isPlaceholderData}
        total={list.data?.total}
        minWidth={620}
        pagination={{
          pageIndex: paging.pageIndex,
          pageSize: CONTENT_PAGE_SIZE,
          nextCursor: list.data?.next_cursor,
          onNext: paging.next,
          onPrev: paging.prev,
        }}
        rowActions={(c) => (
          <RowActions
            edit={{ label: `Ubah kategori ${c.label}`, onClick: () => setEditing(c) }}
            remove={{
              label:
                c.usage_count > 0
                  ? `Hapus kategori ${c.label} (dipakai ${c.usage_count} ${NOUN}; nonaktifkan saja)`
                  : `Hapus kategori ${c.label}`,
              disabled: c.usage_count > 0,
              onClick: () => setToDelete(c),
            }}
          />
        )}
        emptyState={
          <EmptyState
            compact
            title={filtered ? "Tidak ada kategori yang cocok" : "Belum ada kategori"}
            description={filtered ? "Ubah kata kunci atau filter." : `Tambahkan kategori untuk ${NOUN}.`}
          />
        }
      />
      <p className="text-xs text-text-muted">
        Kategori yang sedang dipakai {NOUN} tidak dapat dihapus. Nonaktifkan agar tidak muncul di pilihan baru
        dan tab anggota; label lama tetap tampil pada {NOUN} yang memakainya.
      </p>

      {editing !== null ? (
        <CategoryFormDialog
          category={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        open={toDelete !== null}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) remove.mutate(toDelete);
        }}
        pending={remove.isPending}
        title="Hapus kategori?"
        description={toDelete ? `Kategori "${toDelete.label}" akan dihapus permanen.` : undefined}
        confirmLabel="Hapus kategori"
        acknowledgement="Saya memahami kategori ini tidak dapat dikembalikan."
      />
    </div>
  );
}

interface CategoryFormValues {
  label: string;
  slug: string;
  sort_order: string;
  active: boolean;
}

const categorySchema = z.object({
  label: requiredText("Label", 1, 80),
  slug: z
    .string()
    .trim()
    .max(80, "Slug maksimal 80 karakter.")
    .refine((v) => v === "" || SLUG_PATTERN.test(v), SLUG_HINT),
  sort_order: z
    .string()
    .trim()
    .regex(/^\d{1,5}$/, "Urutan berupa angka 0 sampai 32767.")
    .refine((v) => Number(v) <= 32767, "Urutan berupa angka 0 sampai 32767."),
  active: z.boolean(),
});

function toCategoryForm(c: AdminContentCategory | null): CategoryFormValues {
  return {
    label: c?.label ?? "",
    slug: c?.slug ?? "",
    sort_order: String(c?.sort_order ?? 0),
    active: c?.active ?? true,
  };
}

function categoryChanges(
  v: CategoryFormValues,
  base: AdminContentCategory,
): S["AdminContentCategoryUpdateRequest"] {
  const out: S["AdminContentCategoryUpdateRequest"] = {};
  if (v.label.trim() !== base.label) out.label = v.label.trim();
  const slug = v.slug.trim();
  if (slug !== "" && slug !== base.slug) out.slug = slug;
  if (Number(v.sort_order) !== base.sort_order) out.sort_order = Number(v.sort_order);
  if (v.active !== base.active) out.active = v.active;
  return out;
}

/** Formulir tambah/ubah kategori dengan If-Match dan konflik versi yang ditawarkan muat ulang (AC F15-4). */
function CategoryFormDialog({
  category,
  onClose,
}: {
  category: AdminContentCategory | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [base, setBase] = useState(category);
  const [conflict, setConflict] = useState<ConflictState<AdminContentCategory> | null>(null);
  const focusLabel = useDeferredFocus(() => form.setFocus("label"));
  const form = useForm<CategoryFormValues>({
    resolver: zodResolver(categorySchema),
    defaultValues: toCategoryForm(category),
  });
  const values = form.watch();
  const label = "kategori berita";

  useEffect(() => {
    form.setFocus("label");
  }, [form]);

  const save = useApiMutation<AdminContentCategory, CategoryFormValues, CategoryFormValues>({
    intent: (v) => [base?.id ?? "new", base?.version, v],
    setError: form.setError,
    request: (v, ctx) => {
      if (!base) {
        const slug = v.slug.trim();
        const body: S["AdminContentCategoryCreateRequest"] = {
          label: v.label.trim(),
          ...(slug ? { slug } : {}),
          sort_order: Number(v.sort_order),
          active: v.active,
        };
        return api.POST("/admin/content/post-categories", {
          params: { header: { "Idempotency-Key": ctx.idempotencyKey } },
          body,
        });
      }
      return api.PATCH("/admin/content/post-categories/{categoryId}", {
        params: { path: { categoryId: base.id }, header: { "If-Match": base.version } },
        body: categoryChanges(v, base),
      });
    },
    successMessage: (data) =>
      base ? `Kategori "${data.label}" diperbarui.` : `Kategori "${data.label}" ditambahkan.`,
    onSuccess: async () => {
      await invalidateContent(queryClient);
      onClose();
    },
    onReloadLatest: (error) => {
      if (base) setConflict(conflictState<AdminContentCategory>(error, base));
    },
  });

  async function reloadLatest() {
    if (!base) return;
    try {
      const latest =
        conflict?.latest ??
        (await unwrap(
          api.GET("/admin/content/post-categories/{categoryId}", {
            params: { path: { categoryId: base.id } },
          }),
        ));
      setConflict(null);
      setBase(latest);
      form.reset(toCategoryForm(latest));
      void invalidateContent(queryClient);
      focusLabel();
    } catch (e) {
      toast.error(toApiError(e).message);
    }
  }

  const unchanged = base !== null && Object.keys(categoryChanges(values, base)).length === 0;

  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={!save.isPending}
      title={base ? `Ubah ${label}` : `Tambah ${label}`}
      description={
        base && base.usage_count > 0
          ? `Dipakai ${base.usage_count} ${NOUN}. Perubahan label langsung tampil pada ${NOUN} tersebut.`
          : undefined
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Batal
          </Button>
          <Button
            type="submit"
            form="form-kategori"
            loading={save.isPending}
            loadingText="Menyimpan..."
            disabled={Boolean(conflict) || unchanged}
          >
            {base ? "Simpan perubahan" : "Tambah kategori"}
          </Button>
        </>
      }
    >
      {conflict ? (
        <ConflictNotice
          subject="Kategori ini"
          cause={conflict.cause}
          updatedAt={conflict.latest?.updated_at}
          latestStatus={conflict.latest ? <CategoryStatusBadge active={conflict.latest.active} /> : null}
          onReload={() => void reloadLatest()}
        />
      ) : null}
      <form
        id="form-kategori"
        noValidate
        className="flex flex-col gap-4"
        onSubmit={form.handleSubmit((v) => {
          if (conflict || unchanged) return;
          save.mutate(v);
        })}
      >
        <FormError message={form.formState.errors.root?.server?.message} />
        <FormField<CategoryFormValues, "label"> control={form.control} name="label" label="Label" required>
          {(field, a11y) => <Input {...a11y} {...field} maxLength={80} autoComplete="off" />}
        </FormField>
        <FormField<CategoryFormValues, "slug">
          control={form.control}
          name="slug"
          label="Slug"
          hint={
            base
              ? SLUG_HINT
              : `Kosongkan agar dibuat otomatis${values.label.trim() ? ` (${slugFromTitle(values.label)})` : ""}. ${SLUG_HINT}`
          }
        >
          {(field, a11y) => (
            <Input {...a11y} {...field} maxLength={80} autoComplete="off" spellCheck={false} />
          )}
        </FormField>
        <FormField<CategoryFormValues, "sort_order">
          control={form.control}
          name="sort_order"
          label="Urutan tampil"
          hint="Angka kecil tampil lebih dahulu pada tab kategori aplikasi."
          required
        >
          {(field, a11y) => <Input {...a11y} {...field} inputMode="numeric" maxLength={5} />}
        </FormField>
        <Switch
          label="Aktif"
          description="Kategori nonaktif tidak dapat dipilih untuk konten baru dan tidak tampil sebagai tab anggota."
          checked={values.active}
          onCheckedChange={(v) => form.setValue("active", v, { shouldDirty: true })}
        />
      </form>
    </Dialog>
  );
}
