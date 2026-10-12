import "reflect-metadata";
import { loadServerEnv } from "@kapdh/config";
import { createDb } from "@kapdh/database";
import { createApp } from "./bootstrap.js";
import { systemClock } from "./infra/clock.js";
import type { Db } from "./infra/db.js";
import { DevLogMailer, SmtpMailer } from "./infra/mailer.js";

async function main() {
  const env = loadServerEnv();
  const { db } = createDb(env.DATABASE_URL);
  const mailer = env.SMTP_URL ? new SmtpMailer(env.SMTP_URL, env.MAIL_FROM) : new DevLogMailer();
  const app = await createApp({ env, db: db as unknown as Db, mailer, clock: systemClock });
  app.enableShutdownHooks();
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

void main();
