import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { admins, sessions, users } from "@kapdh/database";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { AppException } from "../common/app-exception.js";
import { CLOCK, type Clock } from "../infra/clock.js";
import type { Db } from "../infra/db.js";
import { DB } from "../infra/tokens.js";
import { ADMIN_IDLE_MS } from "./auth.service.js";
import { type AccessClaims, TokenService } from "./token.service.js";

export interface AuthContext extends AccessClaims {
  adminId?: string;
}

export type AuthedRequest = FastifyRequest & { auth?: AuthContext };

export const AUDIENCE_KEY = "kapdh:audience";
/** Tandai controller/handler dengan audience yang diwajibkan: "mobile", "admin", atau "any". */
export const RequireAuth = (audience: "mobile" | "admin" | "any") => SetMetadata(AUDIENCE_KEY, audience);

/**
 * Memeriksa access token, sesi yang belum dicabut, session_version, status akun, dan untuk admin: TOTP dan idle 30 menit.
 * Server memeriksa revocation pada setiap tindakan terlindungi (F-02).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<"mobile" | "admin" | "any" | undefined>(AUDIENCE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const unauth = new AppException(401, "UNAUTHENTICATED", "Sesi berakhir. Silakan masuk kembali.");
    if (!token) throw unauth;

    const claims = await this.tokens.verifyAccess(token);
    if (!claims) {
      // Token tahap sandi admin dipakai di endpoint admin: wajib TOTP (AC F02-2).
      if (required === "admin" && (await this.tokens.verifyMfa(token))) {
        throw new AppException(403, "MFA_REQUIRED", "Masukkan kode autentikator untuk melanjutkan.");
      }
      throw unauth;
    }
    if (required !== "any" && claims.audience !== required)
      throw new AppException(403, "FORBIDDEN", "Token tidak berlaku untuk layanan ini.");
    if (claims.audience === "admin" && claims.mfaLevel < 2)
      throw new AppException(403, "MFA_REQUIRED", "Masukkan kode autentikator untuk melanjutkan.");

    const now = this.clock.now();
    const session = await this.db.query.sessions.findFirst({ where: eq(sessions.id, claims.sessionId) });
    const user = await this.db.query.users.findFirst({ where: eq(users.id, claims.userId) });
    if (
      !session ||
      session.revokedAt ||
      session.userId !== claims.userId ||
      !user ||
      user.sessionVersion !== claims.sessionVersion
    )
      throw unauth;
    if (user.status === "disabled" || user.status === "deleted") throw unauth;

    const auth: AuthContext = { ...claims };
    if (claims.audience === "admin") {
      if (now.getTime() - session.lastActivityAt.getTime() > ADMIN_IDLE_MS) {
        await this.db.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, session.id));
        throw new AppException(
          401,
          "UNAUTHENTICATED",
          "Sesi admin berakhir karena tidak ada aktivitas selama 30 menit.",
        );
      }
      const admin = await this.db.query.admins.findFirst({ where: eq(admins.userId, user.id) });
      if (admin?.status !== "active") throw new AppException(403, "FORBIDDEN", "Akun admin tidak aktif.");
      auth.adminId = admin.id;
      // Permintaan latar tidak dihitung sebagai aktivitas (AC F02-5).
      if (req.headers["x-background-request"] !== "1") {
        await this.db
          .update(sessions)
          .set({ lastActivityAt: now, lastSeenAt: now })
          .where(eq(sessions.id, session.id));
      }
    } else if (now.getTime() - session.lastSeenAt.getTime() > 60_000) {
      await this.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, session.id));
    }
    req.auth = auth;
    return true;
  }
}
