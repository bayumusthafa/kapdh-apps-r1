import type { Permission } from "@kapdh/contracts";
import type { ReactNode } from "react";
import { type Access, useAuth } from "../../auth/session";
import { ForbiddenState } from "./States";

/**
 * Tampilkan isi hanya bila admin memiliki izin (AC F15-1). Ini hanya kenyamanan UI: API tetap memeriksa izin di
 * setiap permintaan dan menu tersembunyi tidak menggantikan pemeriksaan itu (PRD 2.3).
 * - `anyOf`: salah satu izin cukup; `allOf`: semua izin wajib.
 * - Bawaan fallback untuk halaman adalah ForbiddenState; untuk tombol gunakan `fallback={null}`.
 */
export function PermissionGate({
  anyOf,
  allOf,
  fallback,
  children,
}: {
  anyOf?: Access;
  allOf?: readonly Permission[];
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const auth = useAuth();
  const allowed =
    (anyOf === undefined || auth.canAny(anyOf)) &&
    (allOf === undefined || allOf.every((p) => auth.can(p))) &&
    auth.profile !== null;
  if (allowed) return <>{children}</>;
  return <>{fallback === undefined ? <ForbiddenState /> : fallback}</>;
}
