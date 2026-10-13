import { safeError } from "@kapdh/api/worker";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import { type HealthReport, httpStatusFor } from "./health.js";

/**
 * Endpoint health kecil worker (PRD 5.5): hanya `GET|HEAD /healthz`, JSON tanpa PII/secret, `Cache-Control: no-store`.
 * Dipakai healthcheck container dan Uptime Kuma lewat jaringan internal; tidak pernah dirutekan publik oleh Traefik.
 * Query string diabaikan dan tidak pernah dicatat.
 */
export class HealthServer {
  private server: Server | null = null;

  constructor(
    private readonly report: () => Promise<HealthReport>,
    private readonly logger: Logger,
  ) {}

  /** Mulai mendengarkan; port 0 = port acak dari OS (uji). Mengembalikan alamat yang dipakai. */
  async listen(port: number, host: string): Promise<AddressInfo> {
    const server = createServer((req, res) => void this.handle(req, res));
    // Klien health singkat: koneksi idle tidak menahan shutdown.
    server.keepAliveTimeout = 1_000;
    server.headersTimeout = 5_000;
    server.requestTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (error) => this.logger.error({ error: safeError(error) }, "galat server health"));
    this.server = server;
    return server.address() as AddressInfo;
  }

  address(): AddressInfo | null {
    return (this.server?.address() as AddressInfo | null) ?? null;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/healthz") return this.send(res, 404, { code: "NOT_FOUND", message: "Tidak ditemukan." });
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return this.send(res, 405, { code: "METHOD_NOT_ALLOWED", message: "Metode tidak didukung." });
    }
    try {
      const report = await this.report();
      this.send(res, httpStatusFor(report.status), report, req.method === "HEAD");
    } catch (error) {
      this.logger.error({ error: safeError(error) }, "laporan health gagal disusun");
      this.send(res, 503, { status: "error", service: "kapdh-worker", issues: ["health_report_failed"] });
    }
  }

  private send(res: ServerResponse, status: number, body: unknown, headOnly = false): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(headOnly ? undefined : payload);
  }
}
