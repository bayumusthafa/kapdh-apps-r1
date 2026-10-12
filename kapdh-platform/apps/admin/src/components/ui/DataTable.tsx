import {
  type ColumnDef,
  getCoreRowModel,
  type OnChangeFn,
  type RowData,
  type RowSelectionState,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Pencil, Trash } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { Button, IconButton } from "./Button";
import { EmptyState, ErrorState, Loading } from "./States";

declare module "@tanstack/react-table" {
  // Penggabungan deklarasi: parameter generik wajib sama dengan deklarasi asli.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    align?: "left" | "right" | "center";
    headerClassName?: string;
    cellClassName?: string;
    /** Sel ini menjadi judul baris (<th scope="row">) untuk pembaca layar. */
    rowHeader?: boolean;
    /** Judul kolom hanya untuk pembaca layar (mis. kolom aksi). */
    srOnlyHeader?: boolean;
  }
}

/**
 * Paging kursor server (ARCHITECTURE §4.10: `{items, next_cursor, total}`). Menyimpan tumpukan kursor agar
 * "Halaman sebelumnya" dapat kembali tanpa kursor mundur dari server. Tumpukan direset saat `resetKey`
 * (filter/pencarian/urutan) berubah.
 */
export function useCursorPaging(resetKey: unknown, pageSize = 30) {
  const keyHash = JSON.stringify(resetKey);
  const [state, setState] = useState<{ key: string; stack: (string | null)[] }>({
    key: keyHash,
    stack: [null],
  });
  const current = state.key === keyHash ? state : { key: keyHash, stack: [null] };
  if (current !== state) setState(current);
  const pageIndex = current.stack.length - 1;
  return {
    cursor: current.stack[pageIndex] ?? null,
    pageIndex,
    pageSize,
    next(nextCursor: string) {
      setState((s) => ({ ...s, stack: [...s.stack, nextCursor] }));
    },
    prev() {
      setState((s) => (s.stack.length > 1 ? { ...s, stack: s.stack.slice(0, -1) } : s));
    },
    reset() {
      setState({ key: keyHash, stack: [null] });
    },
  };
}

/**
 * Render templat sel/judul TanStack lewat SATU tipe komponen yang stabil. `flexRender` bawaan memakai fungsi `cell`
 * sebagai tipe komponen React, sehingga setiap kali definisi kolom dibuat ulang (mis. useMemo bergantung pada baris
 * aktif atau jam) React melepas lalu memasang ulang seluruh sel dan fokus keyboard di dalam sel jatuh ke <body>
 * (N-11). Dengan pembungkus ini React hanya merender ulang isi sel. Hook di dalam fungsi sel tetap sah karena fungsi
 * itu dipanggil di dalam komponen ini dan setiap sel diberi key per kolom.
 */
function CellTemplate<P>({ template, props }: { template: unknown; props: P }): ReactNode {
  if (typeof template === "function") return (template as (p: P) => ReactNode)(props);
  return (template as ReactNode) ?? null;
}

export interface DataTablePagination {
  pageIndex: number;
  pageSize: number;
  /** Kursor halaman berikutnya dari server; null bila halaman terakhir. */
  nextCursor: string | null | undefined;
  onNext: (cursor: string) => void;
  onPrev: () => void;
}

export interface DataTableSelection<T> {
  selected: RowSelectionState;
  onChange: OnChangeFn<RowSelectionState>;
  /** Label baris untuk kotak centang, mis. nama alumni. */
  rowLabel: (row: T) => string;
  /** Aksi massal yang AMAN dan dapat diaudit saja (F-15). */
  actions: (rows: T[], clear: () => void) => ReactNode;
  /**
   * Pilihan dikosongkan saat halaman berubah dan saat nilai ini berubah (mis. objek filter/pencarian), agar aksi
   * massal tidak mengenai baris yang tidak lagi terlihat.
   */
  resetKey?: unknown;
}

export interface DataTableProps<T> {
  /** Judul tabel untuk pembaca layar (<caption class="sr-only">). */
  caption: string;
  /**
   * Definisi kolom TanStack. Kolom yang boleh diurutkan server wajib punya `accessorKey`/`accessorFn`; kolom tanpa
   * accessor (hanya `id` + `cell`) tidak dapat diurutkan. `id`/`accessorKey` dipakai sebagai nama kolom urutan.
   * `cell`/`header` berupa teks atau fungsi render; definisi boleh dibuat ulang (mis. useMemo yang bergantung pada
   * baris aktif) tanpa membuat sel dipasang ulang, karena DataTable merendernya lewat komponen yang stabil.
   */
  // ColumnDef<T, any> adalah bentuk baku TanStack Table untuk kolom bernilai campuran.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ColumnDef<T, any>[];
  data: T[] | undefined;
  getRowId: (row: T) => string;
  /** Status query (TanStack Query). */
  status: "pending" | "error" | "success";
  error?: unknown;
  onRetry?: () => void;
  /**
   * Sedang berpindah halaman/filter dengan data lama masih tampil (placeholder). Ringkasan menampilkan "Memuat..."
   * alih-alih rentang yang belum sesuai, dan tombol paging tetap dapat difokus tetapi klik diabaikan.
   */
  isFetching?: boolean;
  total?: number;
  pagination?: DataTablePagination;
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  selection?: DataTableSelection<T>;
  /** Sel aksi per baris (kolom "Kelola"); gunakan <RowActions>. */
  rowActions?: (row: T) => ReactNode;
  /** Baris aktif pada pola daftar-detail (latar hijau + garis kiri seperti prototipe screen_8). */
  activeRowId?: string | null;
  rowClassName?: (row: T) => string | undefined;
  /** Bilah filter di atas tabel. */
  toolbar?: ReactNode;
  emptyState?: ReactNode;
  minWidth?: number;
  className?: string;
}

export function DataTable<T>({
  caption,
  columns,
  data,
  getRowId,
  status,
  error,
  onRetry,
  isFetching = false,
  total,
  pagination,
  sorting,
  onSortingChange,
  selection,
  rowActions,
  activeRowId,
  rowClassName,
  toolbar,
  emptyState,
  minWidth = 640,
  className,
}: DataTableProps<T>) {
  const allColumns = useMemo(() => {
    // ColumnDef<T, any> sesuai tipe kolom pemanggil.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cols: ColumnDef<T, any>[] = [];
    if (selection) {
      cols.push({
        id: "__select",
        meta: { srOnlyHeader: false, headerClassName: "w-12" },
        header: ({ table }) => (
          <input
            type="checkbox"
            aria-label="Pilih semua baris di halaman ini"
            className="size-5 accent-[var(--color-primary)]"
            checked={table.getIsAllRowsSelected()}
            ref={(el) => {
              if (el) el.indeterminate = table.getIsSomeRowsSelected();
            }}
            onChange={table.getToggleAllRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={`Pilih ${selection.rowLabel(row.original)}`}
            className="size-5 accent-[var(--color-primary)]"
            checked={row.getIsSelected()}
            disabled={!row.getCanSelect()}
            onChange={row.getToggleSelectedHandler()}
          />
        ),
      });
    }
    cols.push(...columns);
    if (rowActions) {
      cols.push({
        id: "__actions",
        header: "Kelola",
        meta: { align: "right" },
        cell: ({ row }) => rowActions(row.original),
      });
    }
    return cols;
  }, [columns, rowActions, selection]);

  const table = useReactTable<T>({
    data: data ?? [],
    columns: allColumns,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    enableRowSelection: Boolean(selection),
    enableSorting: Boolean(onSortingChange),
    enableSortingRemoval: true,
    // Klik pertama selalu naik (A-Z, lama-baru) agar dapat diprediksi; server tetap yang mengurutkan.
    sortDescFirst: false,
    state: {
      sorting: sorting ?? [],
      rowSelection: selection?.selected ?? {},
    },
    onSortingChange,
    onRowSelectionChange: selection?.onChange,
  });

  // Pilihan tidak dibawa ke halaman/filter lain (aksi massal hanya pada baris yang terlihat). Handler disimpan di
  // ref sehingga pemanggil boleh memberi fungsi inline tanpa memicu efek (dan render) berulang tanpa akhir.
  const pageIndex = pagination?.pageIndex ?? 0;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const selectionResetKey = JSON.stringify(selection?.resetKey ?? null);
  const selectionScope = useRef({ pageIndex, selectionResetKey });
  useEffect(() => {
    const prev = selectionScope.current;
    if (prev.pageIndex === pageIndex && prev.selectionResetKey === selectionResetKey) return;
    selectionScope.current = { pageIndex, selectionResetKey };
    const current = selectionRef.current;
    if (current && Object.keys(current.selected).length > 0) current.onChange({});
  }, [pageIndex, selectionResetKey]);

  const rows = table.getRowModel().rows;
  const selectedRows = table.getSelectedRowModel().rows.map((r) => r.original);
  const shown = rows.length;
  const from = pageIndex * (pagination?.pageSize ?? 0) + 1;
  const to = pageIndex * (pagination?.pageSize ?? 0) + shown;
  // Saat berpindah halaman/filter, baris yang tampil masih milik halaman lama: jangan tampilkan (dan umumkan)
  // rentang yang mustahil seperti "21–40 dari 26".
  const loadingPage = isFetching && status === "success";
  // Halaman lanjutan menjadi kosong (mis. baris terakhirnya baru diputus lalu daftar dimuat ulang) padahal data
  // masih ada di halaman sebelumnya: bukan "data kosong", tawarkan kembali ke halaman sebelumnya.
  const emptyLaterPage = status === "success" && shown === 0 && pageIndex > 0 && Boolean(pagination);
  const prevButtonRef = useRef<HTMLButtonElement>(null);
  const summary = loadingPage
    ? pageIndex > 0
      ? `Memuat halaman ${pageIndex + 1}...`
      : "Memuat data..."
    : total === undefined
      ? null
      : emptyLaterPage
        ? `Halaman ${pageIndex + 1} kosong; total ${total} data`
        : shown === 0
          ? `Menampilkan 0 dari ${total}`
          : pageIndex === 0
            ? `Menampilkan ${shown} dari ${total}`
            : `Menampilkan ${from}–${to} dari ${total}`;

  let body: ReactNode;
  if (status === "pending") body = <Loading label={`Memuat ${caption.toLowerCase()}...`} />;
  else if (status === "error") body = <ErrorState error={error} onRetry={onRetry} compact />;
  else if (emptyLaterPage)
    body = (
      <EmptyState
        compact
        title="Halaman ini sudah kosong"
        description="Data di halaman ini sudah berpindah, misalnya baru saja diproses. Data lain masih ada di halaman sebelumnya."
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              pagination?.onPrev();
              // Tombol ini hilang setelah berpindah halaman: fokus dipindah ke tombol paging yang tetap ada.
              prevButtonRef.current?.focus();
            }}
          >
            Kembali ke halaman sebelumnya
          </Button>
        }
      />
    );
  else if (shown === 0) body = emptyState ?? <EmptyState title="Belum ada data" compact />;
  else
    body = (
      <div className="overflow-x-auto">
        <table
          aria-busy={isFetching || undefined}
          className="w-full border-collapse text-sm"
          style={{ minWidth }}
        >
          <caption className="sr-only">{caption}</caption>
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="bg-green-50 text-left">
                {hg.headers.map((header) => {
                  const meta = header.column.columnDef.meta;
                  const sortable = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  const content = header.isPlaceholder ? null : (
                    <CellTemplate template={header.column.columnDef.header} props={header.getContext()} />
                  );
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={
                        sortable
                          ? sorted === "asc"
                            ? "ascending"
                            : sorted === "desc"
                              ? "descending"
                              : "none"
                          : undefined
                      }
                      className={cn(
                        "px-3.5 py-3 text-xs font-semibold uppercase tracking-wide text-neutral-700",
                        meta?.align === "right" && "text-right",
                        meta?.align === "center" && "text-center",
                        meta?.headerClassName,
                      )}
                    >
                      {sortable ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            "inline-flex min-h-11 items-center gap-1 uppercase hover:text-primary",
                            meta?.align === "right" && "flex-row-reverse",
                          )}
                        >
                          {content}
                          {sorted === "asc" ? (
                            <ArrowUp aria-hidden="true" className="size-3.5" />
                          ) : sorted === "desc" ? (
                            <ArrowDown aria-hidden="true" className="size-3.5" />
                          ) : (
                            <ChevronsUpDown aria-hidden="true" className="size-3.5 opacity-60" />
                          )}
                          <span className="sr-only">, urutkan</span>
                        </button>
                      ) : meta?.srOnlyHeader ? (
                        <span className="sr-only">{content}</span>
                      ) : (
                        content
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.map((row) => {
              const active = activeRowId === row.id;
              return (
                <tr
                  key={row.id}
                  data-active={active || undefined}
                  className={cn(
                    "border-t border-divider",
                    rowClassName?.(row.original),
                    row.getIsSelected() && "bg-green-50",
                    active && "bg-green-100 shadow-[inset_4px_0_0_var(--color-primary)]",
                  )}
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta;
                    const Tag = meta?.rowHeader ? "th" : "td";
                    return (
                      <Tag
                        key={cell.id}
                        scope={meta?.rowHeader ? "row" : undefined}
                        className={cn(
                          "px-3.5 py-3 align-middle font-normal",
                          meta?.align === "right" && "text-right",
                          meta?.align === "center" && "text-center",
                          meta?.rowHeader && "text-left",
                          meta?.cellClassName,
                        )}
                      >
                        <CellTemplate template={cell.column.columnDef.cell} props={cell.getContext()} />
                      </Tag>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-lg border border-divider bg-surface",
        className,
      )}
    >
      {toolbar ? (
        <div className="flex flex-wrap items-end gap-3 border-b border-divider p-3.5">{toolbar}</div>
      ) : null}
      {selection && selectedRows.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-divider bg-green-50 px-3.5 py-2">
          <span className="text-sm font-semibold" aria-live="polite">
            {selectedRows.length} baris dipilih
          </span>
          {selection.actions(selectedRows, () => selection.onChange({}))}
        </div>
      ) : null}
      {body}
      {pagination || summary ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-divider px-3.5 py-1.5 text-xs text-text-muted">
          <span aria-live="polite">{summary}</span>
          {pagination ? (
            <div className="flex items-center gap-1">
              {/* Tetap dapat difokus saat nonaktif: tombol yang baru ditekan tidak boleh membuang fokus (N-11). */}
              <Button
                ref={prevButtonRef}
                variant="ghost"
                size="sm"
                focusableWhenDisabled
                disabled={pagination.pageIndex === 0 || isFetching}
                onClick={pagination.onPrev}
                leftIcon={<ChevronLeft aria-hidden="true" className="size-4" />}
              >
                Halaman sebelumnya
              </Button>
              <Button
                variant="ghost"
                size="sm"
                focusableWhenDisabled
                disabled={!pagination.nextCursor || isFetching}
                onClick={() => pagination.nextCursor && pagination.onNext(pagination.nextCursor)}
                className="flex-row-reverse"
                leftIcon={<ChevronRight aria-hidden="true" className="size-4" />}
              >
                Halaman berikutnya
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Aksi baris baku: ubah (ikon pensil hijau) dan hapus (ikon tempat sampah merah) sesuai guidelines hlm. 13-17. */
export function RowActions({
  edit,
  remove,
  children,
}: {
  edit?: { label: string; onClick: () => void; disabled?: boolean };
  remove?: { label: string; onClick: () => void; disabled?: boolean };
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      {children}
      {edit ? (
        <IconButton
          tone="primary"
          icon={<Pencil />}
          label={edit.label}
          onClick={edit.onClick}
          disabled={edit.disabled}
        />
      ) : null}
      {remove ? (
        <IconButton
          tone="danger"
          icon={<Trash />}
          label={remove.label}
          onClick={remove.onClick}
          disabled={remove.disabled}
        />
      ) : null}
    </div>
  );
}
