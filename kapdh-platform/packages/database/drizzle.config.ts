import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/*.ts",
  out: "./migrations",
  schemaFilter: ["app"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://kapdh:kapdh-dev-only@localhost:5432/kapdh" },
  strict: true,
});
