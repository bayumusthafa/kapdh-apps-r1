// Tipe kontrak API KAPDH. Sumber: openapi/openapi.yaml; berkas generated dibangkitkan `pnpm generate`.
export type { paths, components, operations } from "./generated/api.js";
import type { components } from "./generated/api.js";

export type Schemas = components["schemas"];
export type ErrorCode = Schemas["ErrorCode"];
export type ApiError = Schemas["Error"];
export type EffectiveStatus = Schemas["EffectiveStatus"];
export type Permission = Schemas["Permission"];
