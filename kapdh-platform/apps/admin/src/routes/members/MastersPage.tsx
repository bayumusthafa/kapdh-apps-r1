import { zodResolver } from "@hookform/resolvers/zod";
import { type components, MASTER_KIND_VALUES } from "@kapdh/contracts";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Ban, CircleCheck, Plus, RefreshCw, TriangleAlert } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import type { ApiError } from "../../api/errors";
import { useApiMutation, useApiQuery } from "../../api/query";
import { ROUTE_ACCESS } from "../../auth/access";
import { useAuth } from "../../auth/session";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Switch } from "../../components/ui/Choice";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { DataTable, RowActions, useCursorPaging } from "../../components/ui/DataTable";
import { Dialog } from "../../components/ui/Dialog";
import { Field, FormError, FormField } from "../../components/ui/FormField";
import { Input, Select } from "../../components/ui/Input";
import { type Breadcrumb, PageHeader } from "../../components/ui/PageHeader";
import { PermissionGate } from "../../components/ui/PermissionGate";
import { SearchInput } from "../../components/ui/SearchInput";
import { EmptyState, ErrorState, Loading } from "../../components/ui/States";
import { TabPanel, Tabs } from "../../components/ui/Tabs";
import { MASTER_KIND_LABEL } from "./labels";
import { masterKeys, type MasterKind } from "./queries";

type MasterItem = components["schemas"]["AdminMasterItem"];
type MasterSort = components["schemas"]["AdminMasterSort"];

export const MASTER_PAGE_SIZE = 30;

const SORT_OPTIONS = [
  { value: "manual", label: "Urutan tampil" },
  { value: "label_asc", label: "Label A-Z" },
  { value: "label_desc", label: "Label Z-A" },
  { value: "usage_desc", label: "Paling banyak dipakai" },
] as const satisfies readonly { value: MasterSort; label: string }[];

const ACTIVE_OPTIONS = [
  { value: "all", label: "Semua status" },
  { value: "true", label: "Aktif" },
  { value: "false", label: "Nonaktif" },
] as const;

/**
 * Manajemen Skill & Profesi (F-10, F-15, guideline hal. 16): master profesi dan keahlian dengan pencarian,
 * filter status, urutan dan paging server. Tambah/ubah/nonaktifkan/hapus memerlukan master.manage; master yang
 * dipakai alumni tidak dapat dihapus dan dinonaktifkan sebagai gantinya agar label historis tetap tampil
 * (AC F10-4). Perubahan memakai If-Match (AC F15-4) dan tercatat di audit (AC F17-1).
 */
export function MastersPage() {
  const auth = useAuth();
  const search = useSearch({ from: "/app/members/masters" });
  const navigate = useNavigate({ from: "/members/masters" });
  const kind: MasterKind = search.kind ?? "professions";
  const breadcrumbs: Breadcrumb[] = auth.canAny(ROUTE_ACCESS["/members"])
    ? [{ label: "Manajemen Users", to: "/members" }, { label: "Skill & Profesi" }]
    : [{ label: "Skill & Profesi" }];

  return (
    <>
      <PageHeader
        title="Manajemen Skill & Profesi"
        description="Master terkontrol untuk profil alumni dan filter jejaring. Master yang sudah dipakai dinonaktifkan, bukan dihapus."
        breadcrumbs={breadcrumbs}
        actions={
          <Tabs<MasterKind>
            label="Jenis master"
            idPrefix="master"
            value={kind}
            onValueChange={(next) => void navigate({ search: { kind: next }, replace: true })}
            items={MASTER_KIND_VALUES.map((k) => ({ value: k, label: MASTER_KIND_LABEL[k].plural }))}
          />
        }
      />
      <TabPanel idPrefix="master" value={kind} className="flex flex-col gap-4">
        {/* Penjaga di dalam halaman: izin dapat berubah saat halaman terbuka (AC F16-3). */}
        <PermissionGate allOf={["master.manage"]}>
          <MasterTable key={kind} kind={kind} />
        </PermissionGate>
      </TabPanel>
    </>
  );
}

type Pending =
  | { type: "create" }
  | { type: "edit"; item: MasterItem }
  | { type: "deactivate"; item: MasterItem }
  | { type: "delete"; item: MasterItem }
  | null;

function MasterTable({ kind }: { kind: MasterKind }) {
  const queryClient = useQueryClient();
  const names = MASTER_KIND_LABEL[kind];
  const [q, setQ] = useState("");
  const [active, setActive] = useState<"all" | "true" | "false">("all");
  const [sort, setSort] = useState<MasterSort>("manual");
  const [pending, setPending] = useState<Pending>(null);
  const filters = { q, active, sort };
  const paging = useCursorPaging(filters, MASTER_PAGE_SIZE);

  const list = useApiQuery({
    queryKey: masterKeys.list(kind, { ...filters, cursor: paging.cursor }),
    placeholderData: keepPreviousData,
    request: ({ signal, headers }) =>
      api.GET("/admin/masters/{kind}", {
        params: {
          path: { kind },
          query: {
            ...(q ? { q } : {}),
            ...(active !== "all" ? { active: active === "true" } : {}),
            ...(sort !== "manual" ? { sort } : {}),
            ...(paging.cursor ? { cursor: paging.cursor } : {}),
            limit: MASTER_PAGE_SIZE,
          },
        },
        signal,
        headers,
      }),
  });

  function refreshLists() {
    // Daftar master dan pilihan filter/formulir anggota (label baru, status aktif) dimuat ulang.
    void queryClient.invalidateQueries({ queryKey: masterKeys.all });
    void queryClient.invalidateQueries({ queryKey: ["admin-member"] });
    void queryClient.invalidateQueries({ queryKey: ["admin-members"] });
  }

  const toggle = useApiMutation<MasterItem, { item: MasterItem; active: boolean }>({
    intent: (v) => [v.item.id, v.item.version, v.active],
    request: (v) =>
      api.PATCH("/admin/masters/{kind}/{masterId}", {
        params: { path: { kind, masterId: v.item.id }, header: { "If-Match": v.item.version } },
        body: { active: v.active },
      }),
    successMessage: (data) =>
      data.active
        ? `${data.label} diaktifkan kembali dan dapat dipilih alumni.`
        : `${data.label} dinonaktifkan. Profil yang sudah memakainya tetap menampilkan label ini.`,
    onReloadLatest: () => refreshLists(),
    onSuccess: () => {
      setPending(null);
      refreshLists();
    },
    onError: () => setPending(null),
  });

  const remove = useApiMutation<void, MasterItem>({
    intent: (v) => [v.id, v.version],
    request: (item) =>
      api.DELETE("/admin/masters/{kind}/{masterId}", {
        params: { path: { kind, masterId: item.id }, header: { "If-Match": item.version } },
      }),
    successMessage: (_d, item) => `${item.label} dihapus.`,
    onReloadLatest: () => refreshLists(),
    onSuccess: () => {
      setPending(null);
      refreshLists();
    },
    onError: (error) => {
      // Master mulai dipakai sejak daftar dimuat: server menolak (FK RESTRICT) dan menyarankan nonaktifkan,
      // `current` memuat jumlah pemakaian terbaru (AC F10-4).
      const current = usedMasterFrom(error);
      refreshLists();
      setPending(current && current.active ? { type: "deactivate", item: current } : null);
    },
  });

  const columns = useMemo<ColumnDef<MasterItem>[]>(
    () => [
      {
        id: "label",
        header: names.plural,
        meta: { rowHeader: true },
        cell: ({ row }) => <span className="font-medium">{row.original.label}</span>,
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) =>
          row.original.active ? (
            <Badge tone="success" icon={<CircleCheck />}>
              Aktif
            </Badge>
          ) : (
            <Badge tone="neutral" icon={<Ban />}>
              Nonaktif
            </Badge>
          ),
      },
      {
        id: "usage",
        header: "Dipakai",
        meta: { align: "right", cellClassName: "whitespace-nowrap" },
        cell: ({ row }) => `${row.original.usage_count} alumni`,
      },
      {
        id: "sort_order",
        header: "Urutan",
        meta: { align: "right" },
        cell: ({ row }) => row.original.sort_order,
      },
    ],
    [names.plural],
  );

  return (
    <>
      <p role="note" className="rounded-md bg-info-bg p-3 text-sm text-info">
        {names.plural} yang sudah dipakai alumni tidak dapat dihapus. Nonaktifkan agar tidak dapat dipilih lagi;
        profil yang sudah memakainya tetap menampilkan labelnya (AC F10-4).
      </p>
      <DataTable<MasterItem>
        caption={`Daftar ${names.singular}`}
        columns={columns}
        data={list.data?.items}
        getRowId={(m) => m.id}
        status={list.status}
        error={list.error}
        onRetry={() => void list.refetch()}
        isFetching={list.isFetching && list.isPlaceholderData}
        total={list.data?.total}
        minWidth={560}
        pagination={{
          pageIndex: paging.pageIndex,
          pageSize: MASTER_PAGE_SIZE,
          nextCursor: list.data?.next_cursor,
          onNext: paging.next,
          onPrev: paging.prev,
        }}
        toolbar={
          <>
            <SearchInput
              label={`Cari ${names.singular}`}
              value={q}
              onValueChange={setQ}
              placeholder="Cari label"
              className="flex-[1_1_220px]"
            />
            <Field label="Status" className="flex-[0_1_170px]">
              {(a11y) => (
                <Select {...a11y} size="sm" options={ACTIVE_OPTIONS} value={active} onValueChange={setActive} />
              )}
            </Field>
            <Field label="Urutkan" className="flex-[0_1_200px]">
              {(a11y) => (
                <Select {...a11y} size="sm" options={SORT_OPTIONS} value={sort} onValueChange={setSort} />
              )}
            </Field>
            <Button
              size="sm"
              leftIcon={<Plus aria-hidden="true" className="size-4" />}
              onClick={() => setPending({ type: "create" })}
            >
              Tambah {names.singular}
            </Button>
          </>
        }
        rowActions={(item) => (
          <RowActions
            edit={{ label: `Ubah ${item.label}`, onClick: () => setPending({ type: "edit", item }) }}
            // Hapus hanya untuk master yang belum pernah dipakai; yang terpakai dinonaktifkan (AC F10-4).
            remove={
              item.usage_count === 0
                ? { label: `Hapus ${item.label}`, onClick: () => setPending({ type: "delete", item }) }
                : undefined
            }
          >
            <Button
              variant="ghost"
              size="sm"
              loading={toggle.isPending && toggle.variables?.item.id === item.id}
              onClick={() =>
                item.active
                  ? setPending({ type: "deactivate", item })
                  : toggle.mutate({ item, active: true })
              }
              aria-label={item.active ? `Nonaktifkan ${item.label}` : `Aktifkan ${item.label}`}
            >
              {item.active ? "Nonaktifkan" : "Aktifkan"}
            </Button>
          </RowActions>
        )}
        emptyState={
          <EmptyState
            compact
            title={q || active !== "all" ? `Tidak ada ${names.singular} yang cocok` : `Belum ada ${names.singular}`}
            description={
              q || active !== "all"
                ? "Ubah kata kunci atau filter status."
                : `Tambahkan ${names.singular} agar alumni dapat memilihnya di profil.`
            }
          />
        }
      />

      {pending?.type === "create" || pending?.type === "edit" ? (
        <MasterFormDialog
          kind={kind}
          itemId={pending.type === "edit" ? pending.item.id : null}
          onClose={() => setPending(null)}
          onSaved={() => {
            setPending(null);
            refreshLists();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={pending?.type === "deactivate"}
        tone="primary"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending?.type === "deactivate") toggle.mutate({ item: pending.item, active: false });
        }}
        pending={toggle.isPending}
        title={pending?.type === "deactivate" ? `Nonaktifkan ${pending.item.label}?` : ""}
        description={
          pending?.type === "deactivate"
            ? `${names.plural} ini tidak dapat dipilih lagi untuk profil baru. ${pending.item.usage_count} alumni yang sudah memakainya tetap menampilkan labelnya sebagai label historis (AC F10-4).`
            : undefined
        }
        confirmLabel="Nonaktifkan"
      />

      <ConfirmDialog
        open={pending?.type === "delete"}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending?.type === "delete") remove.mutate(pending.item);
        }}
        pending={remove.isPending}
        title={pending?.type === "delete" ? `Hapus ${pending.item.label}?` : ""}
        description={`${names.plural} yang belum pernah dipakai dihapus permanen dari daftar pilihan. Bila ternyata sudah dipakai, server menolak dan menyarankan menonaktifkan.`}
        confirmLabel={`Hapus ${names.singular}`}
      />
    </>
  );
}

/** `current` pada 409 VALIDATION_ERROR hapus master terpakai (kontrak adminDeleteMaster). */
function usedMasterFrom(error: ApiError): MasterItem | null {
  if (error.status !== 409 || error.code !== "VALIDATION_ERROR") return null;
  const current = error.current as Partial<MasterItem> | undefined;
  return current && typeof current.id === "string" && typeof current.version === "string"
    ? (current as MasterItem)
    : null;
}

const masterSchema = z.object({
  label: z.string().trim().min(1, "Label wajib diisi.").max(100, "Label maksimal 100 karakter."),
  sort_order: z
    .string()
    .trim()
    .regex(/^-?\d{1,5}$/, "Urutan berupa bilangan bulat.")
    .refine((v) => Number(v) >= -32768 && Number(v) <= 32767, "Urutan antara -32768 dan 32767."),
  active: z.boolean(),
});
type MasterValues = z.input<typeof masterSchema>;

function valuesOf(item: MasterItem | null): MasterValues {
  return item
    ? { label: item.label, sort_order: String(item.sort_order), active: item.active }
    : { label: "", sort_order: "0", active: true };
}

/**
 * Formulir tambah/ubah master. Ubah memuat detail terbaru (GET /admin/masters/{kind}/{id}) untuk version If-Match;
 * label ganda dijawab server 409 dengan galat pada isian label; konflik versi menawarkan muat ulang (AC F15-4).
 */
function MasterFormDialog({
  kind,
  itemId,
  onClose,
  onSaved,
}: {
  kind: MasterKind;
  itemId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const names = MASTER_KIND_LABEL[kind];
  const detail = useApiQuery({
    queryKey: masterKeys.detail(kind, itemId ?? "new"),
    enabled: itemId !== null,
    request: ({ signal, headers }) =>
      api.GET("/admin/masters/{kind}/{masterId}", {
        params: { path: { kind, masterId: itemId ?? "" } },
        signal,
        headers,
      }),
  });
  const title = itemId ? `Ubah ${names.singular}` : `Tambah ${names.singular}`;

  let body;
  if (itemId && detail.isPending) body = <Loading label={`Memuat ${names.singular}...`} rows={3} />;
  else if (itemId && detail.isError)
    body = <ErrorState error={detail.error} onRetry={() => void detail.refetch()} compact />;
  else
    body = (
      <MasterForm
        kind={kind}
        item={itemId ? (detail.data ?? null) : null}
        onClose={onClose}
        onSaved={onSaved}
        onReload={() => void detail.refetch()}
      />
    );

  return (
    <Dialog open onClose={onClose} title={title} size="sm">
      {body}
    </Dialog>
  );
}

function MasterForm({
  kind,
  item,
  onClose,
  onSaved,
  onReload,
}: {
  kind: MasterKind;
  item: MasterItem | null;
  onClose: () => void;
  onSaved: () => void;
  onReload: () => void;
}) {
  const queryClient = useQueryClient();
  const names = MASTER_KIND_LABEL[kind];
  const formId = useId();
  const [base, setBase] = useState(item);
  const [conflict, setConflict] = useState(false);
  const form = useForm<MasterValues>({ resolver: zodResolver(masterSchema), defaultValues: valuesOf(item) });

  const save = useApiMutation<MasterItem, MasterValues, MasterValues>({
    setError: form.setError,
    request: (v) => {
      const label = v.label.trim();
      const sortOrder = Number(v.sort_order);
      if (!base)
        return api.POST("/admin/masters/{kind}", {
          params: { path: { kind } },
          body: { label, active: v.active, sort_order: sortOrder },
        });
      return api.PATCH("/admin/masters/{kind}/{masterId}", {
        params: { path: { kind, masterId: base.id }, header: { "If-Match": base.version } },
        body: {
          ...(label !== base.label ? { label } : {}),
          ...(v.active !== base.active ? { active: v.active } : {}),
          ...(sortOrder !== base.sort_order ? { sort_order: sortOrder } : {}),
        },
      });
    },
    successMessage: (data) => (base ? `${data.label} disimpan.` : `${data.label} ditambahkan.`),
    onReloadLatest: (error) => {
      if (error.code !== "VERSION_CONFLICT") return;
      const current = error.current as MasterItem | undefined;
      if (current && base && current.id === base.id)
        queryClient.setQueryData(masterKeys.detail(kind, base.id), current);
      else onReload();
      setConflict(true);
    },
    onSuccess: () => onSaved(),
  });

  // Data terbaru sesudah konflik (setQueryData/refetch) masuk lewat prop `item`.
  function reloadLatest() {
    setBase(item);
    form.reset(valuesOf(item));
    setConflict(false);
  }

  const onSubmit = form.handleSubmit((values) => {
    if (base) {
      const unchanged =
        values.label.trim() === base.label &&
        values.active === base.active &&
        Number(values.sort_order) === base.sort_order;
      if (unchanged) {
        form.setError("root.server", { type: "manual", message: "Belum ada perubahan." });
        return;
      }
    }
    save.mutate(values);
  });

  const usage = base?.usage_count ?? 0;
  return (
    <FormProvider {...form}>
      <form id={formId} noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        {conflict ? (
          <div role="alert" className="flex flex-col gap-2 rounded-md bg-warning-bg p-3 text-sm text-warning">
            <span className="flex items-start gap-2 font-medium">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {names.plural} ini sudah diubah admin lain. Simpan dinonaktifkan agar perubahan tersebut tidak
              tertimpa.
            </span>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              leftIcon={<RefreshCw aria-hidden="true" className="size-4" />}
              onClick={reloadLatest}
            >
              Muat data terbaru
            </Button>
          </div>
        ) : null}
        <FormError message={form.formState.errors.root?.server?.message} />
        <FormField<MasterValues, "label">
          name="label"
          label="Label"
          required
          hint={base && usage > 0 ? `Mengganti label berlaku untuk ${usage} alumni yang memakainya.` : "Unik tanpa membedakan huruf besar/kecil."}
        >
          {(field, a11y) => <Input {...field} {...a11y} maxLength={100} autoComplete="off" />}
        </FormField>
        <FormField<MasterValues, "sort_order"> name="sort_order" label="Urutan tampil" hint="Angka kecil tampil lebih dulu.">
          {(field, a11y) => <Input {...field} {...a11y} type="number" inputMode="numeric" min={-32768} max={32767} />}
        </FormField>
        <Switch
          label="Dapat dipilih alumni"
          description={
            form.watch("active")
              ? "Tampil pada pilihan profil dan filter direktori."
              : "Nonaktif: tidak dapat dipilih baru; profil lama tetap menampilkan labelnya (AC F10-4)."
          }
          checked={form.watch("active")}
          onCheckedChange={(v) => form.setValue("active", v, { shouldDirty: true })}
        />
        <div className="flex flex-wrap justify-end gap-3 pt-1">
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Batal
          </Button>
          <Button
            type="submit"
            focusableWhenDisabled
            disabled={conflict}
            loading={save.isPending}
            loadingText="Menyimpan..."
          >
            {base ? "Simpan" : "Tambah"}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}
