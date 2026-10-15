import { Inject, Injectable } from "@nestjs/common";
import semver from "semver";
import type { Clock } from "../adapters/clock.js";
import { AppException } from "../errors/app-exception.js";
import { TokenService } from "../identity/token.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { CLOCK } from "../tokens.js";

export const API_PREFIX = "/api/v1";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Mutasi yang tetap diproses saat maintenance untuk SEMUA pemanggil (ARCHITECTURE §4.3): refresh/logout dan pencabutan
 * sesi perangkat agar sesi tetap terkendali, seluruh /admin/** agar pengurus dapat bekerja dan mematikan maintenance,
 * serta verifikasi KTA publik (POST tetapi hanya membaca, F-06). `path` adalah pola rute yang cocok (mis.
 * `/auth/sessions/:sessionId`), bukan URL mentah.
 */
function maintenanceAllowed(method: string, path: string): boolean {
  return (
    path === "/auth/refresh" ||
    path === "/auth/logout" ||
    path === "/auth/logout-all" ||
    (method === "DELETE" && path === "/auth/sessions/:sessionId") ||
    path === "/admin" ||
    path.startsWith("/admin/") ||
    path === "/public/kta/verify"
  );
}

/**
 * Mutasi bersama (bukan /admin/**) yang dipakai web admin dan tetap diproses saat maintenance HANYA untuk access token
 * ber-audience admin yang sah (ARCHITECTURE §4.3): reautentikasi (X-Reauth-Token untuk tindakan kredensial admin
 * seperti pemulihan admin, backup code, dan reset sandi anggota, agar tetap dapat dilakukan selama maintenance;
 * mematikan maintenance sendiri cukup dengan If-Match sejak ADR-025) dan unggahan berkas pengurus (bukti pembayaran
 * tercatat D13, bukti refund). Mutasi anggota yang sama tetap 503.
 */
function maintenanceAllowedForAdmin(method: string, path: string): boolean {
  return method === "POST" && (path === "/auth/reauth" || path === "/files");
}

/** Logout selalu diizinkan dari versi lama agar pengguna dapat mengakhiri sesi (keamanan). */
function versionGateExempt(path: string): boolean {
  return path === "/auth/logout" || path === "/auth/logout-all";
}

/** Path relatif terhadap /api/v1 tanpa query string, atau null di luar prefix. */
export function apiPath(url: string): string | null {
  const path = url.split("?")[0]!;
  if (path === API_PREFIX) return "/";
  return path.startsWith(`${API_PREFIX}/`) ? path.slice(API_PREFIX.length) : null;
}

export interface GateRequest {
  method: string;
  url: string;
  appPlatform: "android" | "ios" | null;
  /** Nilai mentah header X-App-Version (bisa tidak valid). */
  appVersion: string | undefined;
  /** Nilai mentah header Authorization (Bearer access token), untuk pengecualian maintenance khusus sesi admin. */
  authorization?: string | undefined;
}

/**
 * Hook global sebelum guard (ARCHITECTURE §4.3, PRD 4.5): mode maintenance menolak mutasi dengan
 * 503 MAINTENANCE; mutasi dari aplikasi mobile di bawah min_app_version ditolak 426 UPGRADE_REQUIRED. Keduanya
 * dibaca dari app_settings melalui SettingsService (cache singkat), bukan env.
 */
@Injectable()
export class RequestGate {
  constructor(
    private readonly settings: SettingsService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tokens: TokenService,
  ) {}

  async check(request: GateRequest): Promise<void> {
    const method = request.method.toUpperCase();
    if (!MUTATING.has(method)) return;
    const path = apiPath(request.url);
    if (path === null) return;

    if (!maintenanceAllowed(method, path)) {
      const maintenance = await this.settings.get("maintenance");
      if (maintenance.active && !(await this.adminExempt(method, path, request.authorization))) {
        const until = maintenance.until ? new Date(maintenance.until).getTime() : null;
        const wait = until ? Math.ceil((until - this.clock.now().getTime()) / 1000) : 0;
        throw new AppException(
          503,
          "MAINTENANCE",
          maintenance.message ??
            "Layanan sedang dalam pemeliharaan terjadwal. Perubahan data dijeda sementara.",
          wait > 0 ? { retryAfterSeconds: wait } : {},
        );
      }
    }

    if (request.appPlatform && !versionGateExempt(path)) {
      const minimum = (await this.settings.get("min_app_version"))[request.appPlatform];
      const version = request.appVersion ? semver.valid(request.appVersion.trim()) : null;
      if (!version || semver.lt(version, minimum)) {
        const storeLinks = await this.settings.get("store_links");
        throw new AppException(
          426,
          "UPGRADE_REQUIRED",
          "Versi aplikasi tidak lagi didukung. Perbarui aplikasi untuk melanjutkan.",
          {
            current: {
              platform: request.appPlatform,
              min_version: minimum,
              store_url: storeLinks[request.appPlatform],
            },
          },
        );
      }
    }
  }

  /**
   * true bila mutasi bersama ini dikecualikan untuk pemanggil admin: tanda tangan, masa berlaku, dan audience access
   * token diverifikasi (sama dengan AuthGuard), sehingga token anggota atau token palsu tetap 503. Keadaan sesi (dicabut,
   * admin nonaktif, izin) tetap diperiksa AuthGuard sesudah gerbang ini.
   */
  private async adminExempt(
    method: string,
    path: string,
    authorization: string | undefined,
  ): Promise<boolean> {
    if (!maintenanceAllowedForAdmin(method, path)) return false;
    const header = authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) return false;
    return (await this.tokens.verifyAccess(token))?.audience === "admin";
  }
}
