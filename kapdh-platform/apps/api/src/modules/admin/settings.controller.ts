import { Body, Controller, Get, Headers, HttpCode, Put } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { parseIfMatch } from "../../core/concurrency/if-match.js";
import { Audience, RequirePermission } from "../../core/guards/decorators.js";
import { AdminSettingsService } from "./settings.service.js";

type Schemas = components["schemas"];

/**
 * Domain admin-settings (kontrak C3, F-15, AC F15-3, F15-4, F03-5, D4, D13, PRD 4.5). Semua operasi butuh
 * settings.manage; setiap perubahan wajib If-Match versi kunci (AC F15-4) dan tercatat di audit. Reautentikasi
 * (X-Reauth-Token) tidak lagi diminta untuk pengaturan sejak keputusan PO 2026-10-15 (ADR-025); hanya tindakan
 * kredensial yang memakainya.
 */
@Controller("admin/settings")
@Audience("admin")
export class SettingsController {
  constructor(private readonly settings: AdminSettingsService) {}

  /** adminGetAppSettings: { audience: admin, permissions: [settings.manage] } */
  @Get()
  @HttpCode(200)
  @RequirePermission("settings.manage")
  all(): Promise<Schemas["AdminAppSettings"]> {
    return this.settings.all();
  }

  /** adminGetFees: { audience: admin, permissions: [settings.manage] } */
  @Get("fees")
  @HttpCode(200)
  @RequirePermission("settings.manage")
  fees(): Promise<Schemas["FeeSettings"]> {
    return this.settings.fees();
  }

  /** adminUpdateFees: { audience: admin, permissions: [settings.manage] } */
  @Put("fees")
  @HttpCode(200)
  @RequirePermission("settings.manage")
  updateFees(@Body() body: unknown, @Headers("if-match") ifMatch?: string): Promise<Schemas["FeeSettings"]> {
    return this.settings.updateFees(body, parseIfMatch(ifMatch));
  }

  /** adminUpdateMinAppVersion: { audience: admin, permissions: [settings.manage] } */
  @Put("min-app-version")
  @HttpCode(200)
  @RequirePermission("settings.manage")
  updateMinAppVersion(
    @Body() body: unknown,
    @Headers("if-match") ifMatch?: string,
  ): Promise<Schemas["AdminMinAppVersionSetting"]> {
    return this.settings.updateMinAppVersion(body, parseIfMatch(ifMatch));
  }

  /** adminUpdateMaintenance: { audience: admin, permissions: [settings.manage] } */
  @Put("maintenance")
  @HttpCode(200)
  @RequirePermission("settings.manage")
  updateMaintenance(
    @Body() body: unknown,
    @Headers("if-match") ifMatch?: string,
  ): Promise<Schemas["AdminMaintenanceSetting"]> {
    return this.settings.updateMaintenance(body, parseIfMatch(ifMatch));
  }

  /** adminUpdateStoreLinks: { audience: admin, permissions: [settings.manage] } */
  @Put("store-links")
  @HttpCode(200)
  @RequirePermission("settings.manage")
  updateStoreLinks(
    @Body() body: unknown,
    @Headers("if-match") ifMatch?: string,
  ): Promise<Schemas["AdminStoreLinksSetting"]> {
    return this.settings.updateStoreLinks(body, parseIfMatch(ifMatch));
  }

  /** adminUpdatePaymentInstructions: { audience: admin, permissions: [settings.manage] } */
  @Put("payment-instructions")
  @HttpCode(200)
  @RequirePermission("settings.manage")
  updatePaymentInstructions(
    @Body() body: unknown,
    @Headers("if-match") ifMatch?: string,
  ): Promise<Schemas["AdminPaymentInstructionsSetting"]> {
    return this.settings.updatePaymentInstructions(body, parseIfMatch(ifMatch));
  }

  /** adminUpdateSupportContact: { audience: admin, permissions: [settings.manage] } */
  @Put("support")
  @HttpCode(200)
  @RequirePermission("settings.manage")
  updateSupport(
    @Body() body: unknown,
    @Headers("if-match") ifMatch?: string,
  ): Promise<Schemas["AdminSupportSetting"]> {
    return this.settings.updateSupport(body, parseIfMatch(ifMatch));
  }
}
