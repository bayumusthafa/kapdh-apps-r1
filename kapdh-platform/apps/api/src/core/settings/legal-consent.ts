import type { components } from "@kapdh/contracts";
import type { SettingValue } from "./keys.js";

export type LegalConsentVersions = components["schemas"]["LegalConsentVersions"];

/**
 * Versi persetujuan registrasi (F-01) yang disusun server dari `app_settings.legal`, tidak pernah dari klien:
 * `policy_version = "privacy:<v>;terms:<v>"` (urutan tetap, tanpa spasi). null bila salah satu dokumen belum pernah
 * terbit, sehingga registrasi belum dapat dibuka (PRD 8.2 langkah 4). Dipakai POST /auth/register (pembanding
 * `accept_policy_version`) dan GET /public/pages (`consent`, domain content).
 */
export function legalConsentVersions(legal: SettingValue<"legal">): LegalConsentVersions {
  const { privacy_version, terms_version } = legal;
  return {
    policy_version:
      privacy_version !== null && terms_version !== null
        ? `privacy:${privacy_version};terms:${terms_version}`
        : null,
    privacy_version,
    terms_version,
  };
}
