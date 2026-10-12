import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { IncomingMessage } from "node:http";
import { v7 as uuidv7 } from "uuid";
import { type AppDeps, AppModule } from "./app.module.js";

export async function createApp(deps: AppDeps, options: { logger?: boolean } = {}) {
  const adapter = new FastifyAdapter({
    // request_id menghubungkan log API, worker dan audit (N-14).
    genReqId: (req: IncomingMessage) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : uuidv7();
    },
    trustProxy: true,
    bodyLimit: 1_048_576,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(deps), adapter, {
    logger: options.logger === false ? false : undefined,
  });
  app.setGlobalPrefix("api/v1");
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);
  // Web admin memakai cookie (credentials); situs publik hanya memanggil endpoint publik.
  app.enableCors({ origin: [deps.env.ADMIN_ORIGIN, deps.env.PUBLIC_WEB_URL], credentials: true });
  app
    .getHttpAdapter()
    .getInstance()
    .addHook("onSend", async (req, reply) => {
      reply.header("x-request-id", req.id);
    });
  return app;
}
