import { lazy, type ReactNode, Suspense } from "react";
import { Skeleton } from "./States";

export interface RichTextEditorProps {
  /** HTML (belum tepercaya; server menyanitasi, PRD 3.8). String kosong bila editor kosong. */
  value: string;
  onChange: (html: string) => void;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
}

const Impl = lazy(() => import("./RichTextEditorImpl"));

/**
 * Editor teks kaya (TipTap) untuk berita dan halaman. Kode editor dimuat terpisah saat pertama dipakai sehingga
 * tidak membebani bundel utama web admin.
 */
export function RichTextEditor(props: RichTextEditorProps) {
  return (
    <Suspense
      fallback={
        <div role="status" aria-live="polite" className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{props.label}</span>
          <Skeleton className="h-56 w-full" />
          <span className="sr-only">Memuat editor...</span>
        </div>
      }
    >
      <Impl {...props} />
    </Suspense>
  );
}
