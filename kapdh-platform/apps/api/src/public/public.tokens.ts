import type { components } from "@kapdh/contracts";

export const PUBLIC_CONFIG = Symbol("PUBLIC_CONFIG");

/** Bagian statis PublicConfig; `server_time` ditambahkan per request dari Clock (ARCHITECTURE §2.6). */
export type StaticPublicConfig = Omit<components["schemas"]["PublicConfig"], "server_time">;
