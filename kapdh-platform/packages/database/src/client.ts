import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as identity from "./schema/identity.js";
import * as membership from "./schema/membership.js";
import * as payments from "./schema/payments.js";
import * as platform from "./schema/platform.js";

export function createDb(url: string) {
  const sql = postgres(url, { max: 10, prepare: true });
  return { db: drizzle(sql, { schema: { ...identity, ...membership, ...payments, ...platform } }), sql };
}
