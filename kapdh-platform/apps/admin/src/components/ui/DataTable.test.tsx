import type { ColumnDef, RowSelectionState, SortingState } from "@tanstack/react-table";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/errors";
import { Button } from "./Button";
import { DataTable, RowActions, useCursorPaging } from "./DataTable";

interface Row {
  id: string;
  name: string;
  cohort: number;
}

const ALL: Row[] = Array.from({ length: 7 }, (_, i) => ({
  id: `r${i + 1}`,
  name: `Alumni ${i + 1}`,
  cohort: 20 + i,
}));
const PAGE = 3;

/** Server tiruan kecil: kursor = offset; urutan nama naik/turun. */
function fetchPage(cursor: string | null, sorting: SortingState) {
  const offset = cursor ? Number(cursor) : 0;
  const sorted = [...ALL].sort((a, b) => (sorting[0]?.desc ? b.cohort - a.cohort : a.cohort - b.cohort));
  const items = sorted.slice(offset, offset + PAGE);
  return { items, total: ALL.length, next_cursor: offset + PAGE < ALL.length ? String(offset + PAGE) : null };
}

const columns: ColumnDef<Row>[] = [
  {
    id: "name",
    header: "Nama",
    cell: ({ row }) => row.original.name,
    meta: { rowHeader: true },
    enableSorting: false,
  },
  // Kolom yang dapat diurutkan memerlukan accessor (TanStack); urutan tetap dikerjakan server.
  { accessorKey: "cohort", header: "Angkatan", meta: { align: "right" } },
];

function Harness({ onEdit, onBulk }: { onEdit: (r: Row) => void; onBulk: (rows: Row[]) => void }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [selected, setSelected] = useState<RowSelectionState>({});
  const paging = useCursorPaging({ sorting }, PAGE);
  const page = fetchPage(paging.cursor, sorting);
  return (
    <DataTable<Row>
      caption="Daftar alumni"
      columns={columns}
      data={page.items}
      getRowId={(r) => r.id}
      status="success"
      total={page.total}
      sorting={sorting}
      onSortingChange={setSorting}
      pagination={{
        pageIndex: paging.pageIndex,
        pageSize: PAGE,
        nextCursor: page.next_cursor,
        onNext: paging.next,
        onPrev: paging.prev,
      }}
      selection={{
        selected,
        onChange: setSelected,
        rowLabel: (r) => r.name,
        actions: (rows, clear) => (
          <Button
            size="sm"
            onClick={() => {
              onBulk(rows);
              clear();
            }}
          >
            Ekspor terpilih
          </Button>
        ),
      }}
      rowActions={(r) => (
        <RowActions
          edit={{ label: `Ubah ${r.name}`, onClick: () => onEdit(r) }}
          remove={{ label: `Hapus ${r.name}`, onClick: () => undefined }}
        />
      )}
    />
  );
}

describe("DataTable (F-15: paging/sort server, N-11)", () => {
  it("caption sr-only, judul kolom/baris, ringkasan 'Menampilkan X dari Y' dan paging kursor", async () => {
    const user = userEvent.setup();
    render(<Harness onEdit={vi.fn()} onBulk={vi.fn()} />);
    const table = screen.getByRole("table", { name: "Daftar alumni" });
    expect(within(table).getByRole("rowheader", { name: "Alumni 1" })).toBeInTheDocument();
    expect(screen.getByText("Menampilkan 3 dari 7")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Halaman sebelumnya" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Halaman berikutnya" }));
    expect(screen.getByText("Menampilkan 4–6 dari 7")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Halaman berikutnya" }));
    expect(screen.getByText("Menampilkan 7–7 dari 7")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Halaman berikutnya" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Halaman sebelumnya" }));
    expect(screen.getByText("Menampilkan 4–6 dari 7")).toBeInTheDocument();
  });

  it("urut kolom lewat tombol header dengan aria-sort; urutan baru mereset paging", async () => {
    const user = userEvent.setup();
    render(<Harness onEdit={vi.fn()} onBulk={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Halaman berikutnya" }));
    const header = screen.getByRole("columnheader", { name: /Angkatan/ });
    expect(header).toHaveAttribute("aria-sort", "none");
    expect(screen.getByRole("columnheader", { name: "Nama" })).not.toHaveAttribute("aria-sort");
    await user.click(within(header).getByRole("button", { name: /Angkatan, urutkan/ }));
    expect(header).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByText("Menampilkan 3 dari 7")).toBeInTheDocument();
    await user.click(within(header).getByRole("button"));
    expect(header).toHaveAttribute("aria-sort", "descending");
    expect(screen.getAllByRole("rowheader")[0]).toHaveTextContent("Alumni 7");
  });

  it("aksi baris berlabel (ubah hijau, hapus merah) dan pilihan baris untuk aksi massal aman", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onBulk = vi.fn();
    render(<Harness onEdit={onEdit} onBulk={onBulk} />);
    await user.click(screen.getByRole("button", { name: "Ubah Alumni 2" }));
    expect(onEdit).toHaveBeenCalledWith(ALL[1]);
    expect(screen.getByRole("button", { name: "Hapus Alumni 2" })).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Pilih Alumni 1" }));
    await user.click(screen.getByRole("checkbox", { name: "Pilih Alumni 3" }));
    expect(screen.getByText("2 baris dipilih")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ekspor terpilih" }));
    expect(onBulk).toHaveBeenCalledWith([ALL[0], ALL[2]]);
    expect(screen.queryByText(/baris dipilih/)).toBeNull();

    await user.click(screen.getByRole("checkbox", { name: "Pilih semua baris di halaman ini" }));
    expect(screen.getByText("3 baris dipilih")).toBeInTheDocument();
    // Pindah halaman mengosongkan pilihan (aksi massal hanya pada baris yang terlihat).
    await user.click(screen.getByRole("button", { name: "Halaman berikutnya" }));
    expect(screen.queryByText(/baris dipilih/)).toBeNull();
  });

  it("keadaan memuat, kosong dan galat memiliki pesan serta tindakan", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(
      <DataTable<Row>
        caption="Daftar alumni"
        columns={columns}
        data={undefined}
        getRowId={(r) => r.id}
        status="pending"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Memuat daftar alumni...");
    rerender(
      <DataTable<Row>
        caption="Daftar alumni"
        columns={columns}
        data={[]}
        getRowId={(r) => r.id}
        status="success"
        total={0}
      />,
    );
    expect(screen.getByText("Belum ada data")).toBeInTheDocument();
    expect(screen.getByText("Menampilkan 0 dari 0")).toBeInTheDocument();
    rerender(
      <DataTable<Row>
        caption="Daftar alumni"
        columns={columns}
        data={undefined}
        getRowId={(r) => r.id}
        status="error"
        error={new ApiError({ code: "NETWORK", status: 0, message: "Tidak dapat terhubung." })}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Tidak dapat terhubung");
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
