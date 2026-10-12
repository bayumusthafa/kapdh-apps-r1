import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PERMISSION_VALUES, type AdminRole, type Permission } from "@kapdh/contracts";
import { adminPermissions, admins, sessions } from "@kapdh/database";
import { and, eq, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import { TokenService } from "../../modules/auth/token.service.js";
import type { Clock } from "../adapters/clock.js";
import { setActor } from "../context/request-context.js";
import type { Db } from "../db/types.js";
import { AppException, forbidden, unauthenticated } from "../errors/app-exception.js";
import type { MemberAccessLevel } from "../membership/access.js";
import { MembershipKernel } from "../membership/membership.kernel.js";
import { RealtimeService } from "../realtime/realtime.service.js";
import { CLOCK, DB, ROOT_LOGGER } from "../tokens.js";
import type { AuthContext, AuthedRequest } from "./auth-context.js";
import { routeAuthMeta } from "./decorators.js";
import { SessionValidator } from "./session-validator.js";

/** Idle timeout admin di server (N-08, AC F02-5). */
export const ADMIN_IDLE_MS = 30 * 60_000;
/** last_seen_at sesi mobile diperbarui paling sering sekali per menit (mengurangi tulis). */
const MOBILE_LAST_SEEN_THROTTLE_MS = 60_000;

const ALL_PERMISSIONS: ReadonlySet<Permission> = new Set(PERMISSION_VALUES);
const NO_PERMISSIONS: ReadonlySet<Permission> = new Set();

const REAUTH_HEADER = "x-reauth-token";

/**
 * Guard global (APP_GUARD) yang MENOLAK secara bawaan (ARCHITECTURE §4.3). Urutan pemeriksaan:
 *   1. deklarasi rute (@Public / @Audience; kesalahan deklarasi → 403 dan log galat),
 *   2. access token (aud, exp) dan token tahap sandi admin → 403 MFA_REQUIRED (AC F02-2),
 *   3. keadaan database terbaru: sesi belum dicabut/kedaluwarsa, session_version, akun `active`, jenis akun,
 *      admin aktif + idle 30 menit (AC F02-5, F02-6), izin admin dari database (AC F15-1, F16-3),
 *   4. @MemberAccess (effective_status, PRD 2.2), @RequirePermission (semua), @RequireAnyPermission (salah satu),
 *      @RequireRole (Super Admin), @RequireReauth.
 * Konteks request (aktor) diisi untuk audit dan log.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionValidator,
    private readonly membership: MembershipKernel,
    private readonly realtime: RealtimeService,
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Gateway realtime memvalidasi handshake dan sesinya sendiri (ARCHITECTURE §4.9).
    if (context.getType() !== "http") return true;
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const meta = routeAuthMeta(this.reflector, [context.getHandler(), context.getClass()]);
    if (meta.problems.length > 0) {
      request.log.error(
        { route: request.routeOptions?.url, problems: meta.problems },
        "deklarasi akses rute tidak valid; permintaan ditolak",
      );
      throw forbidden("Akses ditolak.");
    }
    if (meta.isPublic) return true;
    const required = meta.audience!;

    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) throw unauthenticated();

    if (token.length > 4096) throw unauthenticated();
    const claims = await this.sessions.verifyToken(token);
    if (!claims) {
      // Token tahap sandi admin dipakai di endpoint admin: wajib TOTP (AC F02-2).
      if (required === "admin" && (await this.tokens.verifyMfa(token)))
        throw new AppException(403, "MFA_REQUIRED", "Masukkan kode autentikator untuk melanjutkan.");
      throw unauthenticated();
    }
    if (required !== "any" && claims.audience !== required)
      throw forbidden("Token tidak berlaku untuk layanan ini.");
    if (claims.audience === "admin" && claims.mfaLevel < 2)
      throw new AppException(403, "MFA_REQUIRED", "Masukkan kode autentikator untuk melanjutkan.");

    const now = this.clock.now();
    // Sesi belum dicabut/kedaluwarsa, session_version, akun aktif dan jenisnya (sama dengan gateway realtime).
    const row = await this.sessions.loadActiveSession(claims, now);
    if (!row) throw unauthenticated();

    const auth: AuthContext = {
      userId: claims.userId,
      sessionId: claims.sessionId,
      sessionVersion: claims.sessionVersion,
      audience: claims.audience,
      mfaLevel: claims.mfaLevel,
      adminId: null,
      adminRole: null,
      permissions: NO_PERMISSIONS,
      linkedAlumniUserId: null,
      effectiveStatus: null,
      reauthenticated: false,
    };

    if (claims.audience === "admin") {
      if (now.getTime() - row.lastActivityAt.getTime() > ADMIN_IDLE_MS) {
        await this.db
          .update(sessions)
          .set({ revokedAt: now })
          .where(and(eq(sessions.id, claims.sessionId), isNull(sessions.revokedAt)));
        throw unauthenticated("Sesi admin berakhir karena tidak ada aktivitas selama 30 menit.");
      }
      const [admin] = await this.db
        .select({
          id: admins.id,
          role: admins.role,
          status: admins.status,
          linkedAlumniUserId: admins.linkedAlumniUserId,
        })
        .from(admins)
        .where(eq(admins.userId, claims.userId))
        .limit(1);
      if (!admin || admin.status !== "active") throw forbidden("Akun admin tidak aktif.");
      auth.adminId = admin.id;
      auth.adminRole = admin.role as AdminRole;
      auth.linkedAlumniUserId = admin.linkedAlumniUserId;
      auth.permissions =
        admin.role === "super_admin" ? ALL_PERMISSIONS : await this.loadPermissions(admin.id);
      // Permintaan latar (polling) tidak dihitung sebagai aktivitas (AC F02-5).
      if (request.headers["x-background-request"] !== "1") {
        await this.db
          .update(sessions)
          .set({ lastActivityAt: now, lastSeenAt: now })
          .where(eq(sessions.id, claims.sessionId));
      }
    } else if (now.getTime() - row.lastSeenAt.getTime() > MOBILE_LAST_SEEN_THROTTLE_MS) {
      await this.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, claims.sessionId));
    }

    request.auth = auth;
    setActor({
      kind: claims.audience === "admin" ? "admin" : "alumni",
      userId: auth.userId,
      adminId: auth.adminId,
      adminRole: auth.adminRole,
      sessionId: auth.sessionId,
    });

    // effective_status hanya bermakna untuk identitas alumni (sesi mobile, PRD 2.2).
    if (meta.memberAccess && auth.audience === "mobile")
      await this.checkMemberAccess(auth, meta.memberAccess, now);
    if (meta.permissions.length > 0) {
      const missing = meta.permissions.filter((permission) => !auth.permissions.has(permission));
      if (missing.length > 0) throw forbidden();
    }
    // Cukup salah satu izin (x-kapdh-access.permissions_any); super_admin memiliki semua izin (ARCHITECTURE §4.5).
    if (
      meta.permissionsAny.length > 0 &&
      !meta.permissionsAny.some((permission) => auth.permissions.has(permission))
    )
      throw forbidden();
    // Peran dari database pada request ini (x-kapdh-access.role; AC F16-1, F16-4).
    if (meta.role && auth.adminRole !== meta.role)
      throw forbidden("Tindakan ini hanya dapat dilakukan Super Admin.");
    if (meta.reauth) await this.checkReauth(request, auth);
    return true;
  }

  private async loadPermissions(adminId: string): Promise<ReadonlySet<Permission>> {
    const rows = await this.db
      .select({ permission: adminPermissions.permission })
      .from(adminPermissions)
      .where(eq(adminPermissions.adminId, adminId));
    return new Set(rows.map((r) => r.permission as Permission));
  }

  /**
   * PRD 2.2 lewat MembershipKernel (data canonical saat request; AC F07-3): suspended → 403 ACCOUNT_SUSPENDED; status
   * lain di luar tingkat → 403 MEMBERSHIP_REQUIRED.
   */
  private async checkMemberAccess(auth: AuthContext, level: MemberAccessLevel, now: Date) {
    const snapshot = await this.membership.effectiveStatusFor(auth.userId, { now });
    // Akun alumni tanpa profil (data rusak) diperlakukan unverified: tidak pernah membuka akses aktif.
    const status = snapshot?.status ?? "unverified";
    auth.effectiveStatus = status;
    if (!this.membership.allows(level, status)) {
      // Penolakan berarti status tidak aktif: langganan room socket pengguna dicabut seketika, tidak menunggu
      // penyapuan berkala (kontrak C6 "Pencabutan langganan room" butir 3; AC F11-6).
      this.realtime.syncRoomSubscriptions(auth.userId, status);
    }
    this.membership.assertAccess(level, status);
  }

  /** X-Reauth-Token terikat user + sesi, <= 10 menit; sesi admin wajib reautentikasi dengan TOTP (F-16). */
  private async checkReauth(request: AuthedRequest, auth: AuthContext) {
    const raw = request.headers[REAUTH_HEADER];
    const token = typeof raw === "string" ? raw.trim() : "";
    const reauthRequired = new AppException(
      403,
      "REAUTH_REQUIRED",
      "Konfirmasi ulang identitas Anda untuk melanjutkan tindakan ini.",
    );
    if (!token || token.length > 2048) throw reauthRequired;
    const claims = await this.tokens.verifyReauth(token);
    if (
      !claims ||
      claims.userId !== auth.userId ||
      claims.sessionId !== auth.sessionId ||
      (auth.audience === "admin" && claims.level < 2)
    ) {
      this.logger.debug({ request_id: String(request.id) }, "X-Reauth-Token ditolak");
      throw reauthRequired;
    }
    auth.reauthenticated = true;
  }
}
