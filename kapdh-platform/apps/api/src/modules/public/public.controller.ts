import { Controller, Get, Header } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { Public } from "../../core/guards/decorators.js";
import { SettingsService } from "../../core/settings/settings.service.js";

type PublicConfig = components["schemas"]["PublicConfig"];

/**
 * GET /public/config (PRD 4.5, 5.2): versi aplikasi minimum, status maintenance, tautan toko, kontak bantuan, dan
 * versi dokumen legal yang berlaku. Sumbernya app_settings terversi (ARCHITECTURE §5.4), bukan env.
 */
@Controller("public")
export class PublicController {
  constructor(private readonly settings: SettingsService) {}

  @Get("config")
  @Public()
  // Dibaca splash setiap peluncuran; cache singkat di klien/CDN tanpa menahan maintenance terlalu lama.
  @Header("cache-control", "public, max-age=30")
  async getConfig(): Promise<PublicConfig> {
    const [minAppVersion, maintenance, storeLinks, support, legal] = await Promise.all([
      this.settings.get("min_app_version"),
      this.settings.get("maintenance"),
      this.settings.get("store_links"),
      this.settings.get("support"),
      this.settings.get("legal"),
    ]);
    return {
      min_app_version: { android: minAppVersion.android, ios: minAppVersion.ios },
      maintenance: { active: maintenance.active, message: maintenance.message, until: maintenance.until },
      store_links: { android: storeLinks.android, ios: storeLinks.ios },
      support: { email: support.email, whatsapp: support.whatsapp },
      legal: {
        privacy_version: legal.privacy_version,
        terms_version: legal.terms_version,
        community_version: legal.community_version,
      },
    };
  }
}
