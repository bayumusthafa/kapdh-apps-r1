import { type ParsedLocation, redirect } from "@tanstack/react-router";
import type { Access, AuthApi } from "./session";

/** Konteks router web admin (TanStack Router `context`), diperbarui setiap state sesi berubah. */
export interface RouterContext {
  auth: AuthApi;
}

/**
 * Galat yang dilempar `beforeLoad` bila admin tidak memiliki izin rute. Dirender sebagai ForbiddenState oleh
 * errorComponent rute (AC F15-1). Penjaga rute hanya kenyamanan UI; API tetap menolak (PRD 2.3).
 */
export class ForbiddenRouteError extends Error {
  override readonly name = "ForbiddenRouteError";
  constructor(readonly access: Access) {
    super("Akses ditolak");
  }
}

export function isForbiddenRouteError(e: unknown): e is ForbiddenRouteError {
  return e instanceof ForbiddenRouteError;
}

/** Path tujuan setelah login: hanya path internal relatif (mencegah open redirect ke situs lain). */
export function safeRedirectPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return undefined;
  if (value.startsWith("/login") || value.startsWith("/invite")) return undefined;
  return value.length <= 512 ? value : undefined;
}

/** `beforeLoad` layout terautentikasi: belum masuk → /login?redirect=<path saat ini>. */
export function requireSession({ context, location }: { context: RouterContext; location: ParsedLocation }) {
  const { state, lastLogoutReason } = context.auth.snapshot();
  if (state.status === "authenticated") return;
  const back = lastLogoutReason === "manual" ? undefined : safeRedirectPath(location.href);
  throw redirect({ to: "/login", search: back ? { redirect: back } : {} });
}

/** `beforeLoad` per rute area: izin tidak cukup → ForbiddenRouteError (bukan redirect, agar admin paham). */
export function requireAccess(access: Access) {
  return ({ context }: { context: RouterContext }) => {
    if (!context.auth.allowsNow(access)) throw new ForbiddenRouteError(access);
  };
}
