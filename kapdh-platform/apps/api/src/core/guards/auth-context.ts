import type { AdminRole, Permission } from "@kapdh/contracts";
import type { FastifyRequest } from "fastify";
import type { EffectiveStatus } from "../membership/effective-status.js";

export type SessionAudience = "mobile" | "admin";

/**
 * Identitas terautentikasi per request (ARCHITECTURE §4.3). Dibangun AuthGuard dari token yang diverifikasi DAN
 * keadaan database terbaru (sesi, status akun, admin, izin), sehingga pencabutan berlaku walau token belum
 * kedaluwarsa (AC F02-6, F16-3).
 */
export interface AuthContext {
  userId: string;
  sessionId: string;
  sessionVersion: number;
  audience: SessionAudience;
  /** 1 = sandi, 2 = sandi + TOTP (admin wajib 2, AC F02-2). */
  mfaLevel: number;
  adminId: string | null;
  adminRole: AdminRole | null;
  /** Izin efektif dari database pada request ini; super_admin = semua izin (AC F15-1, F16-3). */
  permissions: ReadonlySet<Permission>;
  /** Akun alumni yang ditautkan ke identitas admin, untuk cek konflik kepentingan (PRD 2.3). */
  linkedAlumniUserId: string | null;
  /** effective_status anggota (PRD 2.2); terisi pada rute @MemberAccess. */
  effectiveStatus: EffectiveStatus | null;
  /** true bila X-Reauth-Token valid untuk sesi ini (rute @RequireReauth). */
  reauthenticated: boolean;
}

export type AuthedRequest = FastifyRequest & { auth?: AuthContext };

export function hasPermission(auth: AuthContext, permission: Permission): boolean {
  return auth.permissions.has(permission);
}
