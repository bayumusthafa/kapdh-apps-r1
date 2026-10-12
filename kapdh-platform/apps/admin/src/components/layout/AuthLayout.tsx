import type { ReactNode } from "react";
import { useDocumentTitle } from "../ui/PageHeader";

/**
 * Tata letak halaman masuk sesuai guidelines hlm. 10: panel formulir putih di kiri dan panel hijau tua bergradasi
 * dengan logo di kanan. Di layar sempit panel logo menjadi pita di atas formulir.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
}) {
  useDocumentTitle(title);
  return (
    <div className="flex min-h-dvh items-stretch bg-surface-brand p-0 md:p-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col overflow-hidden bg-surface shadow-raised md:flex-row md:rounded-xl">
        <div data-surface="dark" className="flex items-center gap-3 bg-kta-card px-5 py-4 md:hidden">
          <img src="/logo.png" alt="" aria-hidden="true" className="size-12 object-contain" />
          <span className="font-heading text-sm font-semibold leading-tight text-text-on-dark">
            Keluarga Alumni
            <br />
            Ponpes Darel Hikmah
          </span>
        </div>

        <main className="flex flex-1 items-center justify-center px-5 py-10 md:px-12">
          <div className="flex w-full max-w-sm flex-col gap-6">
            <div className="flex flex-col gap-1.5">
              <h1 className="font-heading text-display font-bold leading-tight text-primary">{title}</h1>
              <div className="text-sm text-primary/90">{subtitle}</div>
            </div>
            {children}
          </div>
        </main>

        <div aria-hidden="true" className="relative hidden flex-1 items-center justify-center p-4 md:flex">
          <div className="flex h-full w-full flex-col items-center justify-center gap-6 rounded-xl rounded-bl-[10rem] bg-kta-card p-10 text-center">
            <img src="/logo.png" alt="" className="size-40 object-contain drop-shadow-lg" />
            <div className="flex flex-col gap-1 text-text-on-dark">
              <span className="font-heading text-3xl font-bold tracking-wide text-accent">KAPDH</span>
              <span className="text-sm text-green-100">Web Manajemen Data Alumni</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Ditampilkan sebentar saat sesi dipulihkan dari cookie refresh setelah halaman dimuat ulang. */
export function RestoringScreen() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-surface-brand text-sm text-text-muted"
    >
      <img src="/logo.png" alt="" aria-hidden="true" className="size-16 animate-pulse object-contain" />
      Memuat sesi...
    </div>
  );
}
