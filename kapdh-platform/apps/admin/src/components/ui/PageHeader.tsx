import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { cn } from "../../lib/cn";
import type { StaticAppPath } from "../../lib/paths";

export interface Breadcrumb {
  label: string;
  /** Tanpa `to` = halaman saat ini (aria-current="page"). */
  to?: StaticAppPath;
  /** Parameter pencarian tujuan, mis. filter daftar yang sedang dipakai agar kembali ke daftar yang sama. */
  search?: Record<string, unknown>;
}

/** Judul tab peramban mengikuti halaman agar pembaca layar dan riwayat peramban jelas (N-11). */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} | KAPDH Admin`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/**
 * Kepala halaman: breadcrumb, judul h1, deskripsi singkat dan aksi (prototipe screen_8 header). Satu h1 per
 * halaman.
 */
export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  breadcrumbs?: Breadcrumb[];
  actions?: ReactNode;
  className?: string;
}) {
  useDocumentTitle(title);
  return (
    <header className={cn("flex flex-col gap-2", className)}>
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-text-muted">
            {breadcrumbs.map((b, i) => (
              <li key={`${b.label}-${i}`} className="flex items-center gap-1">
                {i > 0 ? <ChevronRight aria-hidden="true" className="size-3.5" /> : null}
                {b.to ? (
                  <Link
                    to={b.to}
                    // Tipe search per rute tidak dapat diturunkan dari union path; rute tujuan tetap memvalidasinya
                    // lewat validateSearch.
                    {...(b.search ? { search: b.search as never } : {})}
                    className="inline-flex min-h-6 items-center font-medium text-primary hover:underline"
                  >
                    {b.label}
                  </Link>
                ) : (
                  <span aria-current="page">{b.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-heading text-h1 font-semibold text-text">{title}</h1>
          {description ? <p className="text-sm text-text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
