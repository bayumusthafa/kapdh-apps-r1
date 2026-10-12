import { Outlet, useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { lastForegroundRequestTime } from "../../api/client";
import { useAuth } from "../../auth/session";
import { useIdleTimeout } from "../../auth/useIdleTimeout";
import { ADMIN_ROLE_LABEL } from "../../lib/labels";
import { Button } from "../ui/Button";
import { Dialog, Sheet } from "../ui/Dialog";
import { useToast } from "../ui/Toast";
import { Brand, SidebarNav } from "./Sidebar";

/** Peringatan muncul 2 menit sebelum idle timeout server (AC F02-5). */
export const IDLE_WARNING_MS = 2 * 60_000;

/**
 * Kerangka halaman admin terautentikasi (prototipe screen_8, guidelines hlm. 12): sidebar hijau tua di layar lebar,
 * laci menu di layar sempit, baris "Masuk sebagai <nama> (<peran>)", area konten krem, dan dialog peringatan idle.
 */
export function AppShell() {
  const auth = useAuth();
  const toast = useToast();
  const profile = auth.profile;
  const authed = auth.state.status === "authenticated";
  const idleSeconds = auth.state.status === "authenticated" ? auth.state.idleTimeoutSeconds : 1800;
  const [menuOpen, setMenuOpen] = useState(false);
  const [extending, setExtending] = useState(false);
  const stayRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const onTimeout = useCallback(() => void auth.logout("idle"), [auth]);
  const onHeartbeat = useCallback(() => void auth.touch(), [auth]);
  const idle = useIdleTimeout({
    timeoutMs: idleSeconds * 1000,
    warnBeforeMs: IDLE_WARNING_MS,
    onTimeout,
    enabled: authed,
    onHeartbeat,
    lastServerActivity: lastForegroundRequestTime,
  });

  // Pindah halaman: tutup laci menu dan arahkan fokus ke konten utama agar pembaca layar mulai dari judul baru.
  const firstRender = useRef(true);
  useEffect(() => {
    setMenuOpen(false);
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  async function stayActive() {
    setExtending(true);
    // "Tetap masuk" harus menyentuh server (tanpa header latar) agar idle 30 menit di server ikut diperpanjang.
    const ok = await auth.touch();
    setExtending(false);
    if (ok) idle.stayActive();
    else if (auth.snapshot().state.status === "authenticated")
      toast.error("Sesi tidak dapat diperpanjang. Periksa koneksi lalu coba lagi.");
  }

  if (!profile) return null;

  return (
    <div className="flex min-h-dvh flex-col bg-background md:flex-row">
      <a
        href="#konten-utama"
        className="sr-only z-50 rounded-md bg-primary px-4 py-3 font-semibold text-on-primary focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Lewati ke konten utama
      </a>

      <aside
        data-surface="dark"
        className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col gap-5 overflow-y-auto bg-surface-dark px-3.5 py-5 text-text-on-dark md:flex"
      >
        <Brand />
        <SidebarNav />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-divider bg-surface px-4 md:border-none md:bg-transparent md:px-7 md:pt-4">
          {/*
            Tombol hijau tua di atas header PUTIH: cincin fokus (di luar tombol) jatuh di permukaan terang, jadi
            memakai cincin hijau primer, bukan emas permukaan gelap (~1,5:1 di atas putih; WCAG 1.4.11, N-11).
            aria-controls hanya saat laci terbuka karena laci tidak dirender saat tertutup.
          */}
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? "menu-seluler" : undefined}
            onClick={() => setMenuOpen(true)}
            className="-ml-1 inline-flex min-h-11 items-center gap-2 rounded-md bg-surface-dark px-3 text-sm font-semibold text-text-on-dark md:hidden"
          >
            <Menu aria-hidden="true" className="size-5" />
            Menu
          </button>
          <p className="ml-auto text-xs text-text-muted">
            Masuk sebagai <span className="font-semibold text-text">{profile.display_name}</span> (
            {ADMIN_ROLE_LABEL[profile.role]})
          </p>
        </header>

        <main
          id="konten-utama"
          ref={mainRef}
          tabIndex={-1}
          className="flex min-w-0 flex-1 flex-col gap-5 px-4 py-5 outline-none md:px-7 md:py-6"
        >
          <Outlet />
        </main>
      </div>

      <Sheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        side="left"
        tone="dark"
        ariaLabel="Menu navigasi"
        title={<Brand decorativeLogo />}
      >
        <div id="menu-seluler" className="flex h-full flex-col">
          <SidebarNav onNavigate={() => setMenuOpen(false)} />
        </div>
      </Sheet>

      <Dialog
        open={idle.warning}
        onClose={() => void stayActive()}
        role="alertdialog"
        size="sm"
        initialFocusRef={stayRef}
        title="Sesi akan berakhir"
        description={`Tidak ada aktivitas. Anda akan keluar otomatis dalam ${Math.ceil(idle.remainingMs / 1000)} detik.`}
        footer={
          <>
            <Button variant="outline" onClick={() => void auth.logout("manual")}>
              Keluar sekarang
            </Button>
            <Button
              ref={stayRef}
              loading={extending}
              loadingText="Memperpanjang..."
              onClick={() => void stayActive()}
            >
              Tetap masuk
            </Button>
          </>
        }
      />
    </div>
  );
}
