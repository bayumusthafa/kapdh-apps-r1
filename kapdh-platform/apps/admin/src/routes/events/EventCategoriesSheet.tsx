import type { components } from "@kapdh/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash } from "lucide-react";
import { useState } from "react";
import { FormProvider, useForm, type UseFormReturn } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import { useApiMutation, useApiQuery } from "../../api/query";
import { Button, IconButton } from "../../components/ui/Button";
import { Switch } from "../../components/ui/Choice";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Sheet } from "../../components/ui/Dialog";
import { FormError, FormField } from "../../components/ui/FormField";
import { Input } from "../../components/ui/Input";
import { EmptyState, ErrorState, Loading } from "../../components/ui/States";
import { eventKeys } from "./api";

type Category = components["schemas"]["AdminContentCategory"];

/** Batas kontrak AdminContentCategoryCreateRequest/UpdateRequest (admin-content). */
const LABEL_MAX = 80;
const SLUG_MAX = 80;
const SORT_ORDER_MAX = 32_767;
/** Ukuran halaman daftar kategori di panel (kontrak Limit maks 100); kategori event jumlahnya kecil. */
const CATEGORY_PAGE_LIMIT = 100;

const schema = z.object({
  label: z
    .string()
    .trim()
    .min(1, "Nama kategori wajib diisi.")
    .max(LABEL_MAX, `Nama kategori maksimal ${LABEL_MAX} karakter.`),
  slug: z
    .string()
    .trim()
    .max(SLUG_MAX, `Slug maksimal ${SLUG_MAX} karakter.`)
    .refine(
      (v) => v === "" || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v),
      "Slug hanya huruf kecil, angka dan tanda hubung.",
    ),
  sort_order: z
    .string()
    .trim()
    .regex(/^\d+$/, "Urutan harus bilangan bulat 0 atau lebih.")
    .refine((v) => Number(v) <= SORT_ORDER_MAX, `Urutan maksimal ${SORT_ORDER_MAX.toLocaleString("id-ID")}.`),
});
type Values = z.infer<typeof schema>;

function CategoryForm({
  initial,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
  form,
}: {
  initial?: Category;
  submitLabel: string;
  pending: boolean;
  onSubmit: (v: Values) => void;
  onCancel?: () => void;
  form: UseFormReturn<Values>;
}) {
  return (
    <FormProvider {...form}>
      <form
        noValidate
        aria-label={initial ? `Ubah kategori ${initial.label}` : "Tambah kategori event"}
        onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
        className="flex flex-col gap-3"
      >
        <FormError message={form.formState.errors.root?.server?.message} />
        <FormField<Values, "label"> name="label" label="Nama kategori" required>
          {(field, a11y) => (
            <Input {...a11y} {...field} maxLength={LABEL_MAX} autoComplete="off" disabled={pending} />
          )}
        </FormField>
        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <FormField<Values, "slug"> name="slug" label="Slug" hint="Kosongkan agar dibuat dari nama.">
            {(field, a11y) => (
              <Input {...a11y} {...field} maxLength={SLUG_MAX} autoComplete="off" disabled={pending} />
            )}
          </FormField>
          <FormField<Values, "sort_order"> name="sort_order" label="Urutan">
            {(field, a11y) => <Input {...a11y} {...field} inputMode="numeric" disabled={pending} />}
          </FormField>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {onCancel ? (
            <Button variant="outline" size="sm" onClick={onCancel} disabled={pending}>
              Batal
            </Button>
          ) : null}
          <Button type="submit" size="sm" loading={pending} loadingText="Menyimpan...">
            {submitLabel}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}

/**
 * Manajemen Kategori event (guideline p14) lewat /admin/content/event-categories dengan izin events.manage, sehingga
 * pengurus event mengelola kategorinya tanpa izin konten (PRD 2.3, AC F15-1). Kategori yang dipakai event tidak
 * dapat dihapus, hanya dinonaktifkan; kategori nonaktif tetap tampil pada event lama. Perubahan berversi memakai
 * If-Match (AC F15-4).
 */
export function EventCategoriesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Category | null>(null);
  const list = useApiQuery({
    queryKey: eventKeys.managedCategories({ limit: CATEGORY_PAGE_LIMIT }),
    enabled: open,
    request: ({ signal, headers }) =>
      api.GET("/admin/content/event-categories", {
        params: { query: { limit: CATEGORY_PAGE_LIMIT } },
        signal,
        headers,
      }),
  });
  const createForm = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { label: "", slug: "", sort_order: "0" },
  });
  const editForm = useForm<Values>({ resolver: zodResolver(schema) });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: eventKeys.managedCategories() }),
      queryClient.invalidateQueries({ queryKey: eventKeys.categories }),
    ]);
  };

  const create = useApiMutation<Category, Values, Values>({
    setError: createForm.setError,
    request: (v, ctx) =>
      api.POST("/admin/content/event-categories", {
        params: { header: { "Idempotency-Key": ctx.idempotencyKey } },
        body: {
          label: v.label,
          ...(v.slug ? { slug: v.slug } : {}),
          sort_order: Number(v.sort_order),
          active: true,
        },
      }),
    successMessage: (c) => `Kategori "${c.label}" ditambahkan.`,
    onSuccess: async () => {
      createForm.reset({ label: "", slug: "", sort_order: "0" });
      await refresh();
    },
  });

  const update = useApiMutation<
    Category,
    { category: Category; body: components["schemas"]["AdminContentCategoryUpdateRequest"] },
    Values
  >({
    setError: editForm.setError,
    request: ({ category, body }) =>
      api.PATCH("/admin/content/event-categories/{categoryId}", {
        params: { path: { categoryId: category.id }, header: { "If-Match": category.version } },
        body,
      }),
    successMessage: (c) => `Kategori "${c.label}" disimpan.`,
    onReloadLatest: () => void refresh(),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });

  const remove = useApiMutation<void, Category>({
    request: (c) =>
      api.DELETE("/admin/content/event-categories/{categoryId}", {
        params: { path: { categoryId: c.id }, header: { "If-Match": c.version } },
      }),
    successMessage: (_d, c) => `Kategori "${c.label}" dihapus.`,
    onSuccess: async () => {
      setToDelete(null);
      await refresh();
    },
    onError: () => {
      setToDelete(null);
      void refresh();
    },
  });

  function startEdit(c: Category) {
    editForm.reset({ label: c.label, slug: c.slug, sort_order: String(c.sort_order) });
    setEditing(c.id);
  }

  const items = list.data?.items ?? [];

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title="Manajemen Kategori Event"
        description="Kategori tampil sebagai tab daftar event di aplikasi anggota."
        className="max-w-lg"
      >
        <section
          aria-labelledby="kategori-baru"
          className="flex flex-col gap-3 rounded-lg border border-divider p-4"
        >
          <h3 id="kategori-baru" className="flex items-center gap-2 font-semibold text-primary">
            <Plus aria-hidden="true" className="size-4" />
            Tambah kategori
          </h3>
          <CategoryForm
            form={createForm}
            submitLabel="Tambah kategori"
            pending={create.isPending}
            onSubmit={(v) => create.mutate(v)}
          />
        </section>

        <section aria-labelledby="kategori-daftar" className="flex flex-col gap-2">
          <h3 id="kategori-daftar" className="font-semibold text-primary">
            Kategori event{list.data ? ` (${list.data.total})` : ""}
          </h3>
          {list.isPending ? (
            <Loading label="Memuat kategori event..." rows={3} />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} compact />
          ) : items.length === 0 ? (
            <EmptyState
              compact
              title="Belum ada kategori event"
              description="Tambahkan kategori pertama di atas."
            />
          ) : (
            <ul className="flex flex-col divide-y divide-divider rounded-lg border border-divider">
              {items.map((c) => (
                <li key={c.id} className="flex flex-col gap-3 p-3">
                  {editing === c.id ? (
                    <CategoryForm
                      form={editForm}
                      initial={c}
                      submitLabel="Simpan"
                      pending={update.isPending}
                      onCancel={() => setEditing(null)}
                      onSubmit={(v) => {
                        const body = {
                          ...(v.label !== c.label ? { label: v.label } : {}),
                          ...(v.slug && v.slug !== c.slug ? { slug: v.slug } : {}),
                          ...(Number(v.sort_order) !== c.sort_order
                            ? { sort_order: Number(v.sort_order) }
                            : {}),
                        };
                        if (Object.keys(body).length === 0) setEditing(null);
                        else update.mutate({ category: c, body });
                      }}
                    />
                  ) : (
                    <>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="font-semibold">{c.label}</span>
                          <span className="text-xs text-text-muted">
                            {c.slug} | urutan {c.sort_order} | dipakai {c.usage_count} event
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <IconButton
                            tone="primary"
                            icon={<Pencil />}
                            label={`Ubah kategori ${c.label}`}
                            onClick={() => startEdit(c)}
                          />
                          <IconButton
                            tone="danger"
                            icon={<Trash />}
                            label={
                              c.usage_count > 0
                                ? `Hapus kategori ${c.label} tidak tersedia: masih dipakai event, nonaktifkan saja`
                                : `Hapus kategori ${c.label}`
                            }
                            disabled={c.usage_count > 0}
                            onClick={() => setToDelete(c)}
                          />
                        </div>
                      </div>
                      <Switch
                        label="Tampil untuk event baru"
                        description={
                          c.active
                            ? undefined
                            : "Nonaktif: tidak dapat dipilih untuk event baru, tetap tampil pada event lama."
                        }
                        checked={c.active}
                        disabled={update.isPending}
                        onCheckedChange={(active) => update.mutate({ category: c, body: { active } })}
                      />
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {list.data && list.data.total > items.length ? (
            <p className="text-xs text-text-muted">
              Menampilkan {items.length} dari {list.data.total} kategori, urut sesuai urutan tampil.
            </p>
          ) : null}
        </section>
      </Sheet>
      <ConfirmDialog
        open={toDelete !== null}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) remove.mutate(toDelete);
        }}
        pending={remove.isPending}
        title="Hapus kategori?"
        description={toDelete ? `Kategori "${toDelete.label}" akan dihapus.` : undefined}
        confirmLabel="Hapus kategori"
      >
        <p className="text-sm">Hanya kategori yang belum dipakai event yang dapat dihapus.</p>
      </ConfirmDialog>
    </>
  );
}
