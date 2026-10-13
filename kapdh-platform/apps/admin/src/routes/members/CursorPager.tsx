import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Ref } from "react";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";

/**
 * Ringkasan "Menampilkan X–Y dari Z" untuk paging kursor server (`{items, next_cursor, total}`, ARCHITECTURE
 * §4.10), sama dengan DataTable. Saat berpindah halaman, data lama masih tampil sehingga rentang tidak diumumkan.
 */
export function pageSummary({
  loading,
  pageIndex,
  pageSize,
  shown,
  total,
  noun,
}: {
  loading: boolean;
  pageIndex: number;
  pageSize: number;
  shown: number;
  total: number | undefined;
  noun: string;
}): string | null {
  if (loading) return pageIndex > 0 ? `Memuat halaman ${pageIndex + 1}...` : "Memuat data...";
  if (total === undefined) return null;
  if (shown === 0) return pageIndex > 0 ? `Halaman ${pageIndex + 1} kosong; total ${total} ${noun}` : `Menampilkan 0 dari ${total}`;
  if (pageIndex === 0) return `Menampilkan ${shown} dari ${total}`;
  const from = pageIndex * pageSize + 1;
  return `Menampilkan ${from}–${from + shown - 1} dari ${total}`;
}

/**
 * Tombol halaman sebelumnya/berikutnya. Tombol tetap dapat difokus saat nonaktif (aria-disabled) agar fokus tidak
 * jatuh ke <body> setelah mencapai halaman terakhir (N-11).
 */
export function CursorPager({
  summary,
  pageIndex,
  nextCursor,
  loading,
  onPrev,
  onNext,
  prevRef,
  className,
}: {
  summary: string | null;
  pageIndex: number;
  nextCursor: string | null | undefined;
  loading: boolean;
  onPrev: () => void;
  onNext: (cursor: string) => void;
  prevRef?: Ref<HTMLButtonElement>;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 px-3.5 py-1.5 text-xs text-text-muted",
        className,
      )}
    >
      <span aria-live="polite">{summary}</span>
      <div className="flex items-center gap-1">
        <Button
          ref={prevRef}
          variant="ghost"
          size="sm"
          focusableWhenDisabled
          disabled={pageIndex === 0 || loading}
          onClick={onPrev}
          leftIcon={<ChevronLeft aria-hidden="true" className="size-4" />}
        >
          Halaman sebelumnya
        </Button>
        <Button
          variant="ghost"
          size="sm"
          focusableWhenDisabled
          disabled={!nextCursor || loading}
          onClick={() => nextCursor && onNext(nextCursor)}
          className="flex-row-reverse"
          leftIcon={<ChevronRight aria-hidden="true" className="size-4" />}
        >
          Halaman berikutnya
        </Button>
      </div>
    </div>
  );
}
