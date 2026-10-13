import { Controller, Get, HttpCode } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth } from "../../core/guards/decorators.js";
import { DashboardService } from "./dashboard.service.js";

/**
 * Domain admin-dashboard (kontrak C7, F-15, AC F15-1). Tanpa izin khusus: setiap bagian dihilangkan bila izinnya tidak
 * dimiliki, sehingga kekurangan izin per bagian tidak pernah menghasilkan 403. X-Background-Request dihormati AuthGuard
 * (AC F02-5).
 */
@Controller("admin/dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** adminGetDashboard: { audience: admin } */
  @Get()
  @HttpCode(200)
  @Audience("admin")
  get(@CurrentAuth() auth: AuthContext): Promise<components["schemas"]["AdminDashboard"]> {
    return this.dashboard.dashboard(auth);
  }

  /** adminGetDashboardBadges: { audience: admin } */
  @Get("badges")
  @HttpCode(200)
  @Audience("admin")
  badges(@CurrentAuth() auth: AuthContext): Promise<components["schemas"]["AdminNavBadges"]> {
    return this.dashboard.badges(auth);
  }
}
