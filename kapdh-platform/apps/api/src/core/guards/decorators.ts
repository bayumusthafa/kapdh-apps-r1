import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { Permission } from "@kapdh/contracts";
import { unauthenticated } from "../errors/app-exception.js";
import type { MemberAccessLevel } from "../membership/access.js";
import type { AuthContext, AuthedRequest } from "./auth-context.js";

/**
 * Dekorator akses (ARCHITECTURE §4.3). AuthGuard global MENOLAK secara bawaan: setiap handler (atau kelasnya) wajib
 * menyatakan tepat satu dari `@Public()` atau `@Audience(...)`. Dekorator tambahan dievaluasi server setiap request
 * setelah autentikasi.
 */
export const PUBLIC_KEY = "kapdh:public";
export const AUDIENCE_KEY = "kapdh:audience";
export const MEMBER_ACCESS_KEY = "kapdh:member-access";
export const PERMISSIONS_KEY = "kapdh:permissions";
export const PERMISSIONS_ANY_KEY = "kapdh:permissions-any";
export const ROLE_KEY = "kapdh:role";
export const REAUTH_KEY = "kapdh:reauth";

/** Peran admin yang dapat diwajibkan rute (kontrak `x-kapdh-access.role`): hanya tindakan khusus Super Admin. */
export type RequiredRole = "super_admin";

export type RequiredAudience = "mobile" | "admin" | "any";

/** Tingkat akses anggota (PRD 2.2, ARCHITECTURE §3.1); tabelnya di core/membership/access.ts (MEMBER_ACCESS). */

/** Tanpa autentikasi (endpoint publik dan bootstrap auth). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Sesi terautentikasi dengan audience tertentu: "mobile" (alumni), "admin" (web admin, wajib TOTP), atau "any". */
export const Audience = (audience: RequiredAudience) => SetMetadata(AUDIENCE_KEY, audience);

/**
 * Membatasi sesi mobile menurut effective_status (403 ACCOUNT_SUSPENDED / MEMBERSHIP_REQUIRED). Dengan
 * `@Audience("any")`, hanya dievaluasi untuk sesi mobile (kontrak `x-kapdh-access.member_access`); sesi admin lolos.
 */
export const MemberAccess = (level: MemberAccessLevel) => SetMetadata(MEMBER_ACCESS_KEY, level);

/** Khusus admin: SEMUA izin wajib dimiliki, dievaluasi dari database setiap request (AC F15-1, F16-3). */
export const RequirePermission = (...permissions: [Permission, ...Permission[]]) => {
  if (permissions.length === 0) throw new Error("@RequirePermission membutuhkan minimal satu izin");
  return SetMetadata(PERMISSIONS_KEY, permissions);
};

/**
 * Khusus admin: CUKUP SATU izin yang dimiliki (kontrak `x-kapdh-access.permissions_any`), dipakai bila satu data
 * dibutuhkan dua area pengurus (mis. daftar master untuk members.read atau master.manage). Dievaluasi dari database
 * setiap request seperti @RequirePermission; super_admin selalu lolos (ARCHITECTURE §4.5).
 */
export const RequireAnyPermission = (...permissions: [Permission, ...Permission[]]) => {
  if (permissions.length === 0) throw new Error("@RequireAnyPermission membutuhkan minimal satu izin");
  return SetMetadata(PERMISSIONS_ANY_KEY, permissions);
};

/**
 * Khusus admin dengan peran tertentu (kontrak `x-kapdh-access.role`): tindakan yang hanya boleh dilakukan Super Admin
 * (mis. reset sandi anggota, AC F16-4). Peran dibaca dari database setiap request; selain itu 403 FORBIDDEN.
 */
export const RequireRole = (role: RequiredRole) => SetMetadata(ROLE_KEY, role);

/** Tindakan sensitif: header X-Reauth-Token (aud kapdh-reauth, terikat sesi, <= 10 menit; AC F15-3, F16-1). */
export const RequireReauth = () => SetMetadata(REAUTH_KEY, true);

/** Parameter `AuthContext` request terautentikasi. Melempar 401 bila dipakai di rute tanpa autentikasi. */
export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext): AuthContext => {
  const request = context.switchToHttp().getRequest<AuthedRequest>();
  if (!request.auth) throw unauthenticated();
  return request.auth;
});

export interface RouteAuthMeta {
  isPublic: boolean;
  audience: RequiredAudience | null;
  memberAccess: MemberAccessLevel | null;
  permissions: Permission[];
  /** Cukup salah satu izin (kosong = tidak ada syarat any-of). */
  permissionsAny: Permission[];
  role: RequiredRole | null;
  reauth: boolean;
  /** Kesalahan deklarasi; rute dengan masalah selalu ditolak (fail closed) dan diuji per rute. */
  problems: string[];
}

/**
 * Membaca metadata akses handler + kelas. Handler mengalahkan kelas; izin wajib (@RequirePermission) digabung dari
 * keduanya, sedangkan himpunan any-of dan peran diambil dari tingkat terdekat (menggabungkan any-of akan melonggarkan
 * syarat).
 */
export function routeAuthMeta(
  reflector: Reflector,
  targets: [handler: object, controller: object],
): RouteAuthMeta {
  const [handler, controller] = targets as [() => unknown, new () => unknown];
  const scopes = [handler, controller];
  const isPublic = reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, scopes) === true;
  const audience = reflector.getAllAndOverride<RequiredAudience | undefined>(AUDIENCE_KEY, scopes) ?? null;
  const memberAccess =
    reflector.getAllAndOverride<MemberAccessLevel | undefined>(MEMBER_ACCESS_KEY, scopes) ?? null;
  const permissions = [...new Set(reflector.getAllAndMerge<Permission[]>(PERMISSIONS_KEY, scopes) ?? [])];
  const permissionsAny = [
    ...new Set(reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_ANY_KEY, scopes) ?? []),
  ];
  const role = reflector.getAllAndOverride<RequiredRole | undefined>(ROLE_KEY, scopes) ?? null;
  const reauth = reflector.getAllAndOverride<boolean | undefined>(REAUTH_KEY, scopes) === true;

  const problems: string[] = [];
  if (isPublic && audience) problems.push("@Public dan @Audience tidak boleh bersamaan");
  if (!isPublic && !audience) problems.push("rute tanpa @Public atau @Audience");
  if (isPublic && (memberAccess || permissions.length > 0 || permissionsAny.length > 0 || role || reauth))
    problems.push(
      "@Public tidak boleh memakai @MemberAccess/@RequirePermission/@RequireAnyPermission/@RequireRole/@RequireReauth",
    );
  if (memberAccess && audience !== "mobile" && audience !== "any")
    problems.push("@MemberAccess hanya untuk @Audience('mobile') atau @Audience('any')");
  if (permissions.length > 0 && audience !== "admin")
    problems.push("@RequirePermission hanya untuk @Audience('admin')");
  if (permissionsAny.length > 0 && audience !== "admin")
    problems.push("@RequireAnyPermission hanya untuk @Audience('admin')");
  if (role && audience !== "admin") problems.push("@RequireRole hanya untuk @Audience('admin')");
  return { isPublic, audience, memberAccess, permissions, permissionsAny, role, reauth, problems };
}
