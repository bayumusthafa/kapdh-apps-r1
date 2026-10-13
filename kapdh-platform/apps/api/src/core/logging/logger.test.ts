import { HttpException } from "@nestjs/common";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runAsSystem } from "../context/request-context.js";
import { AppException } from "../errors/app-exception.js";
import { AppLogger, createRootLogger, NestPinoLogger, redactPaths } from "./logger.js";
import { safeError, serializeError } from "./safe-error.js";

const SECRET = "RAHASIA-LOG-91c2";

function sink() {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        raw.push(line);
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { stream, lines, text: () => raw.join("\n") };
}

/** DrizzleQueryError membawa SQL + parameter di pesan; cause = galat driver dengan SQLSTATE. */
function drizzleError() {
  const cause = Object.assign(new Error("duplicate key"), {
    severity: "ERROR",
    code: "23505",
    constraint: "users_kind_email_key",
    table: "users",
  });
  return Object.assign(
    new Error(`Failed query: insert into "users"\nparams: ${SECRET}@contoh.test,$2b$04$hash`),
    {
      query: 'insert into "users"',
      params: [`${SECRET}@contoh.test`],
      cause,
    },
  );
}

describe("logger JSON N-14", () => {
  it("path redaksi mencakup kunci di kedalaman 0..4, termasuk nama berkarakter khusus", () => {
    const paths = redactPaths(["password", "set-cookie"], 2);
    expect(paths).toEqual([
      "password",
      "*.password",
      "*.*.password",
      '["set-cookie"]',
      '*["set-cookie"]',
      '*.*["set-cookie"]',
    ]);
  });

  it("menyensor rahasia di data log dan menyertakan request_id/job_id dari konteks", async () => {
    const out = sink();
    const logs = new AppLogger(
      createRootLogger({ level: "info", service: "kapdh-api", destination: out.stream }),
    );
    const log = logs.for("UjiLogger");
    runAsSystem(
      () =>
        log.info("uji", {
          password: SECRET,
          refreshToken: SECRET,
          payload: { otp: SECRET, code: SECRET, nested: { totp_code: SECRET, backup_code_hashes: [SECRET] } },
          headers: { authorization: `Bearer ${SECRET}`, cookie: SECRET },
          keep: "boleh",
        }),
      { requestId: "req-uji-1", jobId: "job-uji-1" },
    );
    expect(out.text()).not.toContain(SECRET);
    expect(out.lines[0]).toMatchObject({
      level: "info",
      service: "kapdh-api",
      module: "UjiLogger",
      request_id: "req-uji-1",
      job_id: "job-uji-1",
      keep: "boleh",
      password: "[REDACTED]",
    });
  });

  it("galat database dicatat sebagai tipe + SQLSTATE + constraint, tanpa SQL/parameter (sekali atau dua kali serialisasi)", () => {
    const out = sink();
    const root = createRootLogger({ level: "info", service: "kapdh-api", destination: out.stream });
    root.error({ error: drizzleError() }, "mentah");
    root.error({ error: safeError(drizzleError()) }, "sudah aman");
    root.error({ err: drizzleError() }, "err");
    expect(out.text()).not.toContain(SECRET);
    expect(out.text()).not.toContain("insert into");
    for (const line of out.lines) {
      const error = (line.error ?? line.err) as Record<string, unknown>;
      expect(error).toMatchObject({
        type: "DrizzleQueryError",
        error_code: "23505",
        constraint: "users_kind_email_key",
      });
      expect(error.message).toBeUndefined();
    }
  });

  it("safeError: AppException memuat pesan pengguna; HttpException status; nilai non-Error hanya tipe", () => {
    expect(safeError(new AppException(409, "VERSION_CONFLICT", "Data sudah berubah."))).toEqual({
      type: "AppException",
      error_code: "VERSION_CONFLICT",
      status: 409,
      message: "Data sudah berubah.",
    });
    expect(safeError(new HttpException("rahasia", 413))).toMatchObject({
      type: "HttpException",
      status: 413,
    });
    expect(safeError({ password: SECRET })).toEqual({ type: "object" });
    expect(safeError(null)).toEqual({ type: "null" });
    expect(JSON.stringify(safeError(new SyntaxError(`Unexpected token ${SECRET}`)))).not.toContain(SECRET);
    const once = safeError(new Error("x"));
    expect(serializeError(once)).toBe(once);
  });

  it("NestPinoLogger tidak mencatat stack mentah berisi pesan galat", () => {
    const out = sink();
    const nest = new NestPinoLogger(
      createRootLogger({ level: "info", service: "kapdh-api", destination: out.stream }),
    );
    nest.error("gagal memuat modul", `Error: ${SECRET}\n    at Foo (x.js:1:1)`, "InstanceLoader");
    nest.error(drizzleError());
    nest.log("Nest siap", "NestApplication");
    expect(out.text()).not.toContain(SECRET);
    expect(out.lines[0]).toMatchObject({
      level: "error",
      module: "InstanceLoader",
      msg: "gagal memuat modul",
    });
    expect(out.lines[2]).toMatchObject({ level: "info", module: "NestApplication", msg: "Nest siap" });
  });
});
