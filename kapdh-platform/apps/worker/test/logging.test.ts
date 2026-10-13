import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OutboxDispatcher } from "../src/outbox/dispatcher.js";
import { InlineQueueDriver } from "../src/queue/inline-driver.js";
import {
  createJobRunner,
  createTestDatabase,
  fakeRegistry,
  insertOutboxEvent,
  memoryLogger,
  type TestDatabase,
  TestClock,
} from "./support/fixtures.js";

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.close();
});

describe("Log terstruktur worker (N-14)", () => {
  it("N-14: log JSON memuat service, job_id dan request_id asal event; kunci rahasia disensor; payload tidak dicatat", async () => {
    const clock = new TestClock();
    const { logger, lines } = memoryLogger("debug");
    const fake = fakeRegistry();
    const jobs = createJobRunner(fake.registry, tdb.db, clock, logger);
    const queue = new InlineQueueDriver(logger);
    const dispatcher = new OutboxDispatcher(
      { jobs, queue, clock, logger },
      { pollIntervalMs: 250, batchSize: 10, leaseMs: 60_000, concurrency: 1, attempts: 1, backoffMs: 1 },
    );
    dispatcher.attach();
    await queue.start();
    fake.control.failNext = 1;
    // Handler yang ceroboh mencatat objek berisi rahasia: logger root menyensornya (lapis kedua, N-14).
    fake.control.onHandle = () => {
      logger.info(
        {
          refresh_token: "rt-rahasia",
          password: "sandi-rahasia",
          push_token: "fcm-rahasia",
          nested: { otp: "123456" },
        },
        "handler mencatat konteks",
      );
    };
    const id = await insertOutboxEvent(tdb.db, clock, {
      requestId: "0190a6f2-aaaa-7000-8000-000000000abc",
      payload: { event_id: "0190a6f2-bbbb-7000-8000-000000000def" },
    });
    await dispatcher.pollOnce();
    await queue.drained();

    for (const line of lines) {
      expect(line.service).toBe("kapdh-worker");
      expect(typeof line.time).toBe("string");
      expect(typeof line.level).toBe("string");
    }
    const failure = lines.find((line) => line.msg === "event outbox gagal; dijadwalkan ulang");
    expect(failure).toMatchObject({
      level: "warn",
      job_id: `outbox:${id}`,
      request_id: "0190a6f2-aaaa-7000-8000-000000000abc",
      topic: "event.cancelled",
      attempts: 1,
    });
    const queued = lines.find((line) => line.msg === "job antrean selesai");
    expect(queued).toMatchObject({ queue: "outbox", attempt: 1 });
    expect(String(queued!.job_id)).toMatch(/^outbox\.event\.cancelled%3A/);
    const leak = lines.find((line) => line.msg === "handler mencatat konteks");
    expect(leak).toMatchObject({
      refresh_token: "[REDACTED]",
      password: "[REDACTED]",
      push_token: "[REDACTED]",
      nested: { otp: "[REDACTED]" },
    });
    const text = JSON.stringify(lines);
    for (const secret of ["rt-rahasia", "sandi-rahasia", "fcm-rahasia", "123456", "rahasia@contoh.id"])
      expect(text).not.toContain(secret);
    // Payload event (id domain) tidak ikut tercatat oleh dispatcher/antrean.
    expect(text).not.toContain("0190a6f2-bbbb-7000-8000-000000000def");
    await queue.close(1_000);
  });
});
