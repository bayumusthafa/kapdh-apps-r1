// Tipe kontrak API KAPDH (PRD 5.2, N-13). Sumber: openapi/root.yaml + openapi/domains/*.yaml yang digabung ke
// dist/openapi.yaml. Isi src/generated/ dibangkitkan `pnpm contracts:gen` (atau build) dan tidak di-commit.
export type { paths, components, operations } from "./generated/api.js";
export * from "./generated/enums.js";
export * from "./generated/realtime.js";
import type { components } from "./generated/api.js";

export type Schemas = components["schemas"];
export type ErrorCode = Schemas["ErrorCode"];
export type ApiError = Schemas["Error"];
export type EffectiveStatus = Schemas["EffectiveStatus"];
export type AccountStatus = Schemas["AccountStatus"];
export type Permission = Schemas["Permission"];
export type AdminRole = Schemas["AdminRole"];
export type Money = Schemas["Money"];
