import type { FastifyRequest } from "fastify";
import { forbidden } from "../errors/app-exception.js";

/**
 * Pemeriksaan Origin untuk mutasi HTTP berbasis cookie (CSRF, PRD 5.2): browser selalu mengirim Origin pada POST
 * lintas situs; nilainya harus sama persis dengan origin tepercaya (ADMIN_ORIGIN sudah dinormalisasi config,
 * tanpa garis miring penutup). Tanpa Origin atau berbeda → 403 FORBIDDEN.
 */
export function assertTrustedOrigin(request: Pick<FastifyRequest, "headers">, trustedOrigin: string): void {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin !== trustedOrigin)
    throw forbidden("Asal permintaan tidak diizinkan.");
}
