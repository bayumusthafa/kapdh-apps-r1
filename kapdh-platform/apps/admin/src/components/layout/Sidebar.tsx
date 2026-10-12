import { Link, useRouterState } from "@tanstack/react-router";
import { LogOut, UserRound } from "lucide-react";
import { ADMIN_ROLE_LABEL } from "../../lib/labels";
import { cn } from "../../lib/cn";
import { ACCOUNT_LINK, visibleNav } from "../../nav";
import { useAuth } from "../../auth/session";
import { Avatar } from "../ui/DataDisplay";
import { usePendingPaymentsCount } from "./usePendingPayments";

/** Logo dan nama aplikasi di atas menu (prototipe screen_8). */
export function Brand({ compact, decorativeLogo }: { compact?: boolean; decorativeLogo?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 px-1.5">
      <img
        src="/logo.png"
        // Logo dekoratif bila nama aplikasi sudah tertulis di sebelahnya dalam konteks yang sama (laci menu).
        alt={decorativeLogo ? "" : "Logo KAPDH"}
        width={40}
        height={40}
        className="size-10 object-contain"
      />
      {compact ? null : (
        <div className="flex flex-col leading-tight">
          <span className="font-heading text-base font-bold text-accent">KAPDH</span>
          <span className="text-[11px] text-green-100">Web Manajemen Data Alumni</span>
        </div>
      )}
    </div>
  );
}

function isActivePath(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}

/**
 * Menu samping hijau tua: grup sesuai guidelines, tautan per izin (AC F15-1), penanda emas jumlah pembayaran
 * menunggu, kartu pengguna dengan "Akun saya" dan "Keluar" di bawah. Dipakai di sidebar desktop dan laci menu
 * seluler.
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const auth = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const pending = usePendingPaymentsCount();
  const profile = auth.profile;
  if (!profile) return null;
  const sections = visibleNav(profile.permissions);

  return (
    <div className="flex h-full flex-col gap-5">
      <nav aria-label="Menu admin" className="flex flex-col">
        <ul className="flex flex-col gap-1 text-sm">
          {sections.map((section) => {
            const Icon = section.icon;
            // Rute yang lebih spesifik (mis. /members/masters) mengalahkan grup induknya.
            const activeLink = section.links
              .filter((l) => isActivePath(pathname, l.to))
              .sort((a, b) => b.to.length - a.to.length)[0];
            const sectionActive = activeLink !== undefined;
            const count = section.badge === "pending_payments" ? pending.data : undefined;
            const showSub = section.links.length > 1;
            return (
              <li key={section.id}>
                <Link
                  to={section.to}
                  onClick={onNavigate}
                  aria-current={sectionActive && !showSub ? "page" : undefined}
                  className={cn(
                    "flex min-h-11 items-center gap-2.5 rounded-md px-3 text-green-100 transition-colors hover:bg-green-800 hover:text-white",
                    sectionActive && "bg-green-700 font-semibold text-white",
                  )}
                >
                  <Icon aria-hidden="true" className="size-[18px] shrink-0" />
                  <span className="flex-1">{section.label}</span>
                  {count !== undefined && count > 0 ? (
                    <span className="rounded-pill bg-accent px-2 py-0.5 text-[11px] font-bold text-on-accent">
                      {count > 99 ? "99+" : count}
                      <span className="sr-only"> pembayaran menunggu</span>
                    </span>
                  ) : null}
                </Link>
                {showSub && sectionActive ? (
                  <ul className="mt-1 flex flex-col gap-0.5 border-l border-green-800 pl-3 ml-5">
                    {section.links.map((l) => {
                      const current = activeLink?.to === l.to;
                      return (
                        <li key={l.to}>
                          <Link
                            to={l.to}
                            onClick={onNavigate}
                            aria-current={current ? "page" : undefined}
                            className={cn(
                              "flex min-h-11 items-center rounded-md px-3 text-[13px] text-green-100 hover:bg-green-800 hover:text-white",
                              current && "font-semibold text-accent",
                            )}
                          >
                            {l.label}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="mt-auto flex flex-col gap-2 rounded-lg bg-green-900 p-3">
        <div className="flex items-center gap-2.5">
          <Avatar name={profile.display_name} size="sm" className="bg-green-700 text-white" />
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-semibold text-white">{profile.display_name}</span>
            <span className="text-xs text-green-100">{ADMIN_ROLE_LABEL[profile.role]}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <Link
            to={ACCOUNT_LINK.to}
            onClick={onNavigate}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-green-100 hover:bg-green-800 hover:text-white"
            activeProps={{ "aria-current": "page", className: "text-accent" }}
          >
            <UserRound aria-hidden="true" className="size-4" />
            {ACCOUNT_LINK.label}
          </Link>
          <button
            type="button"
            onClick={() => void auth.logout("manual")}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-accent hover:bg-green-800"
          >
            <LogOut aria-hidden="true" className="size-4" />
            Keluar
          </button>
        </div>
      </div>
    </div>
  );
}
