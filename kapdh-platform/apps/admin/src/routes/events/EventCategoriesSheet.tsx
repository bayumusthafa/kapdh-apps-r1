import type { components } from "@kapdh/contracts";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, RefreshCw, Trash, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

function valuesOf(c: Category): Values {
  return { label: c.label, slug: c.slug, sort_order: String(c.sort_order) };
}

/** Kategori dari `current` galat VERSION_CONFLICT (kontrak adminUpdateEventCategory). */
function currentCategory(current: unknown): Category | null {
  if (
    current &&
    typeof current === "object" &&
    "id" in current &&
    "version" in current &&
    "label" in current &&
    "slug" in current &&
    "sort_order" in current
  )
    return current as Category;
  return null;
}

/**
 * Peringatan versi baru saat formulir ubah terbuka (AC F15-4, PRD 4.5): nilai terbaru ditampilkan, simpan dikunci
 * sampai admin memuat versi terbaru, sehingga perubahan admin lain tidak tertimpa diam-diam.
 */
function StaleCategoryAlert({ latest, onReload }: { latest: Category; onReload: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [latest.version]);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning-bg p-3 text-sm text-warning outline-none"
    >
      <p className="flex items-start gap-2 font-semibold">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        Kategori ini sudah diubah admin lain (versi {latest.version}).
      </p>
      <p className="text-text">
        Versi terbaru: {latest.label} | {latest.slug} | urutan {latest.sort_order} |{" "}
        {latest.active ? "aktif" : "nonaktif"}. Perubahan Anda belum disimpan dan tidak akan menimpa versi
        terbaru. Muat versi terbaru, lalu ulangi perubahan yang masih diperlukan.
      </p>
      <div>
        <Button
          size="sm"
          variant="outline"
          leftIcon={<RefreshCw aria-hidden="true" className="size-4" />}
          onClick={onReload}
        >
          Muat versi terbaru
        </Button>
      </div>
    </div>
  );
}

function CategoryForm({
  initial,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
  form,
  stale,
  onReloadLatest,
}: {
  initial?: Category;
  submitLabel: string;
  pending: boolean;
  onSubmit: (v: Values) => void;
  onCancel?: () => void;
  form: UseFormReturn<Values>;
  /** Versi lebih baru dari yang dipakai formulir (konflik atau terlihat di daftar). */
  stale?: Category | null;
  onReloadLatest?: () => void;
}) {
  return (
    <FormProvider {...form}>
      <form
        noValidate
        aria-label={initial ? `Ubah kategori ${initial.label}` : "Tambah kategori event"}
        onSubmit={(e) => {
          if (stale) {
            e.preventDefault();
            return;
          }
          void form.handleSubmit(onSubmit)(e);
        }}
        className="flex flex-col gap-3"
      >
        {stale && onReloadLatest ? <StaleCategoryAlert latest={stale} onReload={onReloadLatest} /> : null}
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
          <Button
            type="submit"
            size="sm"
            loading={pending}
            loadingText="Menyimpan..."
            disabled={Boolean(stale)}
            focusableWhenDisabled
          >
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
 * If-Match (AC F15-4): formulir ubah memakai versi saat dibuka (bukan versi daftar yang dimuat ulang), dan bila
 * kategori berubah di tempat lain, nilai terbaru ditampilkan dengan tombol muat ulang; simpan dikunci sampai itu.
 */
export function EventCategoriesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  /** Kategori saat formulir ubah dibuka: dasar diff dan If-Match. */
  const [editing, setEditing] = useState<Category | null>(null);
  /** Versi terbaru dari `current` konflik saat menyimpan formulir ubah. */
  const [conflict, setConflict] = useState<Category | null>(null);
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

  const closeEditor = () => {
    setEditing(null);
    setConflict(null);
  };

  const update = useApiMutation<
    Category,
    {
      category: Category;
      body: components["schemas"]["AdminContentCategoryUpdateRequest"];
      /** Dari formulir ubah (bukan sakelar aktif): konflik ditampilkan di formulir. */
      fromForm?: boolean;
    },
    Values
  >({
    setError: editForm.setError,
    request: ({ category, body }) =>
      api.PATCH("/admin/content/event-categories/{categoryId}", {
        params: { path: { categoryId: category.id }, header: { "If-Match": category.version } },
        body,
      }),
    successMessage: (c) => `Kategori "${c.label}" disimpan.`,
    onReloadLatest: (err, vars) => {
      void refresh();
      if (!vars.fromForm || editing?.id !== vars.category.id) return;
      // AC F15-4: formulir tetap memakai versi lamanya; versi terbaru ditawarkan, tidak dipasang diam-diam.
      const latest = currentCategory(err.current);
      if (latest) setConflict(latest);
    },
    onError: (err, vars) => {
      // Kategori dihapus admin lain: formulir ubahnya tidak berlaku lagi.
      if (err.code === "NOT_FOUND" && vars.fromForm) closeEditor();
    },
    onSuccess: async (_saved, vars) => {
      if (vars.fromForm) closeEditor();
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
    editForm.reset(valuesOf(c));
    setConflict(null);
    setEditing(c);
  }

  /** Muat versi terbaru ke formulir ubah; admin mengulangi perubahan yang masih diperlukan (AC F15-4). */
  function reloadLatest(latest: Category) {
    editForm.reset(valuesOf(latest));
    setConflict(null);
    setEditing(latest);
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
                  {editing?.id === c.id ? (
                    <CategoryForm
                      form={editForm}
                      initial={editing}
                      submitLabel="Simpan"
                      pending={update.isPending}
                      onCancel={closeEditor}
                      // Versi baru terlihat di daftar yang dimuat ulang, atau dari `current` konflik simpan.
                      stale={c.version !== editing.version ? c : conflict}
                      onReloadLatest={() => reloadLatest(c.version !== editing.version ? c : (conflict ?? c))}
                      onSubmit={(v) => {
                        const base = editing;
                        const body = {
                          ...(v.label !== base.label ? { label: v.label } : {}),
                          ...(v.slug && v.slug !== base.slug ? { slug: v.slug } : {}),
                          ...(Number(v.sort_order) !== base.sort_order
                            ? { sort_order: Number(v.sort_order) }
                            : {}),
                        };
                        if (Object.keys(body).length === 0) closeEditor();
                        else update.mutate({ category: base, body, fromForm: true });
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
