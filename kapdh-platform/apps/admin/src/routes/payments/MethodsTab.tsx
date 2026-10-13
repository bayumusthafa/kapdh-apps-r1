import type { components } from "@kapdh/contracts";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Ban, CircleCheck, Lock, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../../api/client";
import { useApiMutation, useApiQuery } from "../../api/query";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { DataTable, RowActions, useCursorPaging } from "../../components/ui/DataTable";
import { Field } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Input";
import { EmptyState } from "../../components/ui/States";
import { useToast } from "../../components/ui/Toast";
import { METHOD_KIND_LABEL } from "./labels";
import { MethodFormDialog } from "./MethodFormDialog";
import { METHODS_KEY } from "./queries";

type Method = components["schemas"]["AdminPaymentMethod"];

export const METHOD_PAGE_SIZE = 20;

type ActiveFilter = "all" | "active" | "inactive";
const ACTIVE_OPTIONS = [
  { value: "all", label: "Semua" },
  { value: "active", label: "Aktif" },
  { value: "inactive", label: "Nonaktif" },
] as const satisfies readonly { value: ActiveFilter; label: string }[];

type FormState = { method: Method | null; nextSortOrder: number } | null;

/**
 * Tab Kelola Metode (guidelines hlm. 17, F-15, D13): rekening bank dan e-wallet tujuan transfer manual. Tabel
 * server-side dengan total dan paging kursor, urutan tampil yang diatur pengurus. Tambah, ubah dan hapus meminta
 * reautentikasi (AC F15-3) dan memakai If-Match (AC F15-4). Metode yang sudah dipakai pembayaran tidak dapat
 * dihapus, hanya dinonaktifkan, agar histori dan snapshot tagihan tetap utuh.
 */
export function MethodsTab() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [active, setActive] = useState<ActiveFilter>("all");
  const [formState, setFormState] = useState<FormState>(null);
  const [deleting, setDeleting] = useState<Method | null>(null);
  const paging = useCursorPaging({ active }, METHOD_PAGE_SIZE);

  const list = useApiQuery({
    queryKey: [...METHODS_KEY, "list", { active, cursor: paging.cursor }],
    placeholderData: keepPreviousData,
    request: ({ signal, headers }) =>
      api.GET("/admin/payment-methods", {
        params: {
          query: {
            ...(active !== "all" ? { active: active === "active" } : {}),
            ...(paging.cursor ? { cursor: paging.cursor } : {}),
            limit: METHOD_PAGE_SIZE,
          },
        },
        signal,
        headers,
      }),
  });

  const remove = useApiMutation<unknown, Method>({
    requiresReauth: true,
    reauthReason: "Menghapus rekening tujuan pembayaran",
    toastErrors: false,
    request: (m, ctx) =>
      api.DELETE("/admin/payment-methods/{methodId}", {
        params: {
          path: { methodId: m.id },
          header: { "If-Match": m.version, "X-Reauth-Token": ctx.reauthToken ?? "" },
        },
      }),
    onSuccess: (_d, m) => {
      setDeleting(null);
      toast.success(`Metode ${m.provider} dihapus.`);
      void queryClient.invalidateQueries({ queryKey: METHODS_KEY });
    },
    onError: (error) => {
      if (error.reauthCancelled) return;
      setDeleting(null);
      // Metode sudah dipakai (400 field_errors._) atau sudah diubah admin lain (409): pesan server, daftar dimuat
      // ulang agar admin melihat keadaan terbaru (AC F15-4).
      toast.error(error.fieldErrors._?.join(" ") ?? error.message);
      void queryClient.invalidateQueries({ queryKey: METHODS_KEY });
    },
  });

  const items = list.data?.items;
  const nextSortOrder = useMemo(
    () => (items && items.length > 0 ? Math.min(32767, Math.max(...items.map((m) => m.sort_order)) + 1) : 0),
    [items],
  );

  const columns = useMemo<ColumnDef<Method>[]>(
    () => [
      { id: "sort_order", header: "Urutan", cell: ({ row }) => row.original.sort_order },
      {
        id: "provider",
        header: "Penyedia",
        meta: { rowHeader: true },
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span className="font-semibold">{row.original.provider}</span>
            <span className="text-xs text-text-muted">{METHOD_KIND_LABEL[row.original.kind]}</span>
          </span>
        ),
      },
      {
        id: "account",
        header: "Rekening",
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span>{row.original.account_number}</span>
            <span className="text-xs text-text-muted">a.n. {row.original.account_holder}</span>
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1.5">
            {row.original.active ? (
              <Badge tone="success" icon={<CircleCheck />}>
                Aktif
              </Badge>
            ) : (
              <Badge tone="neutral" icon={<Ban />}>
                Nonaktif
              </Badge>
            )}
            {row.original.in_use ? (
              <Badge tone="info" icon={<Lock />}>
                Sudah dipakai
              </Badge>
            ) : null}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-5">
      <DataTable<Method>
        caption="Metode pembayaran"
        columns={columns}
        data={items}
        getRowId={(m) => m.id}
        status={list.status}
        error={list.error}
        onRetry={() => void list.refetch()}
        isFetching={list.isFetching && list.isPlaceholderData}
        total={list.data?.total}
        minWidth={640}
        toolbar={
          <>
            <Field label="Status" className="flex-[0_1_180px]">
              {(a11y) => (
                <Select
                  {...a11y}
                  size="sm"
                  options={ACTIVE_OPTIONS}
                  value={active}
                  onValueChange={setActive}
                />
              )}
            </Field>
            <Button
              className="ml-auto"
              leftIcon={<Plus aria-hidden="true" className="size-4" />}
              onClick={() => setFormState({ method: null, nextSortOrder })}
            >
              Tambah metode
            </Button>
          </>
        }
        pagination={{
          pageIndex: paging.pageIndex,
          pageSize: METHOD_PAGE_SIZE,
          nextCursor: list.data?.next_cursor,
          onNext: paging.next,
          onPrev: paging.prev,
        }}
        rowActions={(m) => (
          <RowActions
            edit={{
              label: `Ubah ${m.provider}`,
              onClick: () => setFormState({ method: m, nextSortOrder }),
            }}
            remove={m.in_use ? undefined : { label: `Hapus ${m.provider}`, onClick: () => setDeleting(m) }}
          />
        )}
        emptyState={
          <EmptyState
            compact
            title={active === "all" ? "Belum ada metode pembayaran" : "Tidak ada metode dengan status ini"}
            description="Tambah rekening bank atau e-wallet organisasi sebagai tujuan transfer iuran dan tiket."
          />
        }
      />
      <p className="text-xs leading-relaxed text-text-muted">
        Perubahan rekening hanya berlaku untuk tagihan baru; tagihan yang sudah dibuat tetap memakai snapshot
        rekening saat dibuat. Metode yang sudah dipakai pembayaran hanya dapat dinonaktifkan.
      </p>

      <MethodFormDialog
        open={formState !== null}
        method={formState?.method ?? null}
        nextSortOrder={formState?.nextSortOrder ?? 0}
        onClose={() => setFormState(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting);
        }}
        pending={remove.isPending}
        title="Hapus metode pembayaran?"
        description={
          deleting
            ? `${METHOD_KIND_LABEL[deleting.kind]} ${deleting.provider} (${deleting.account_number} a.n. ${deleting.account_holder}) dihapus dan tidak lagi ditampilkan ke alumni. Hanya metode yang belum pernah dipakai pembayaran yang dapat dihapus.`
            : undefined
        }
        confirmLabel="Hapus metode"
      />
    </div>
  );
}
