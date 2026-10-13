import { describe, expect, it } from "vitest";
import { InlineQueueDriver } from "../src/queue/inline-driver.js";
import { backoffDelay, queueJobId, settledWithin } from "../src/queue/queue-driver.js";
import { eventually, memoryLogger } from "./support/fixtures.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("Antrean inline tanpa Redis (ARCHITECTURE §1, PRD 5.1)", () => {
  it("menjalankan job dengan batas paralel per antrean dan melaporkan slot kosong (backpressure)", async () => {
    const { logger } = memoryLogger();
    const driver = new InlineQueueDriver(logger);
    const gate = deferred();
    let active = 0;
    let peak = 0;
    const done: string[] = [];
    driver.register<{ n: string }>(
      "outbox",
      async (data) => {
        active++;
        peak = Math.max(peak, active);
        await gate.promise;
        active--;
        done.push(data.n);
      },
      { concurrency: 2 },
    );
    await driver.start();
    expect(await driver.capacity("outbox")).toBe(2);
    for (const n of ["a", "b", "c"])
      await driver.enqueue("outbox", { jobId: `outbox.${n}`, data: { n }, attempts: 1, backoffMs: 1 });
    expect(await driver.capacity("outbox")).toBe(0);
    expect(active).toBe(2);
    gate.resolve();
    await driver.drained();
    expect(peak).toBe(2);
    expect(done.sort()).toEqual(["a", "b", "c"]);
    expect(await driver.capacity("outbox")).toBe(2);
    expect(await driver.close(1_000)).toBe(true);
  });

  it("PRD 5.1: jobId = kunci dedup — job yang sama tidak masuk dua kali selama menunggu/berjalan", async () => {
    const driver = new InlineQueueDriver(memoryLogger().logger);
    const gate = deferred();
    let runs = 0;
    driver.register(
      "scheduled",
      async () => {
        runs++;
        await gate.promise;
      },
      { concurrency: 1 },
    );
    await driver.start();
    const job = { jobId: "scheduled.membership.expiry-reminders.1", data: {}, attempts: 1, backoffMs: 1 };
    expect(await driver.enqueue("scheduled", job)).toBe(true);
    expect(await driver.enqueue("scheduled", job)).toBe(false);
    expect(await driver.isPending("scheduled", job.jobId)).toBe(true);
    gate.resolve();
    await driver.drained();
    expect(runs).toBe(1);
    expect(await driver.isPending("scheduled", job.jobId)).toBe(false);
    await driver.close(1_000);
  });

  it("galat processor dicoba ulang dengan backoff eksponensial sampai percobaan maksimum; log terstruktur memuat job_id", async () => {
    const { logger, lines } = memoryLogger();
    const driver = new InlineQueueDriver(logger);
    const attempts: number[] = [];
    driver.register(
      "outbox",
      async (_data, meta) => {
        attempts.push(meta.attempt);
        throw Object.assign(new Error("koneksi putus"), { code: "ECONNRESET" });
      },
      { concurrency: 1 },
    );
    await driver.start();
    await driver.enqueue("outbox", { jobId: "outbox.x", data: {}, attempts: 3, backoffMs: 5 });
    await driver.drained();
    expect(attempts).toEqual([1, 2, 3]);
    const retries = lines.filter((line) => line.msg === "job antrean gagal; dicoba ulang");
    expect(retries.map((line) => line.retry_in_ms)).toEqual([5, 10]);
    expect(retries[0]).toMatchObject({ queue: "outbox", job_id: "outbox.x", attempt: 1, level: "warn" });
    expect(lines.find((line) => line.msg === "job antrean gagal setelah percobaan maksimum")).toMatchObject({
      level: "error",
      job_id: "outbox.x",
      attempt: 3,
      error: { type: "Error", error_code: "ECONNRESET" },
    });
    expect(JSON.stringify(lines)).not.toContain("koneksi putus");
    await driver.close(1_000);
  });

  it("shutdown: job yang belum mulai dibuang lewat discard (klaim dilepas), job berjalan ditunggu sampai selesai", async () => {
    const driver = new InlineQueueDriver(memoryLogger().logger);
    const gate = deferred();
    const finished: string[] = [];
    const discarded: string[] = [];
    driver.register<{ n: string }>(
      "outbox",
      async (data) => {
        await gate.promise;
        finished.push(data.n);
      },
      { concurrency: 1, discard: async (data) => void discarded.push(data.n) },
    );
    await driver.start();
    await driver.enqueue("outbox", { jobId: "outbox.a", data: { n: "a" }, attempts: 1, backoffMs: 1 });
    await driver.enqueue("outbox", { jobId: "outbox.b", data: { n: "b" }, attempts: 1, backoffMs: 1 });
    const closing = driver.close(2_000);
    await eventually(() => discarded.length === 1);
    expect(discarded).toEqual(["b"]);
    expect(finished).toEqual([]);
    gate.resolve();
    expect(await closing).toBe(true);
    expect(finished).toEqual(["a"]);
    await expect(
      driver.enqueue("outbox", { jobId: "outbox.c", data: { n: "c" }, attempts: 1, backoffMs: 1 }),
    ).rejects.toThrow(/ditutup/);
    expect(await driver.capacity("outbox")).toBe(0);
  });

  it("shutdown: retry yang tertunda dibuang; batas waktu habis → close() mengembalikan false", async () => {
    const driver = new InlineQueueDriver(memoryLogger().logger);
    const discarded: string[] = [];
    let calls = 0;
    const never = new Promise<void>(() => undefined);
    driver.register<{ n: string }>(
      "outbox",
      async (data) => {
        calls++;
        if (data.n === "retry") throw new Error("gagal");
        await never;
      },
      { concurrency: 2, discard: async (data) => void discarded.push(data.n) },
    );
    await driver.start();
    await driver.enqueue("outbox", { jobId: "outbox.retry", data: { n: "retry" }, attempts: 5, backoffMs: 60_000 });
    await driver.enqueue("outbox", { jobId: "outbox.hang", data: { n: "hang" }, attempts: 1, backoffMs: 1 });
    await eventually(() => calls === 2);
    expect(await driver.close(150)).toBe(false);
    expect(discarded).toEqual(["retry"]);
  });

  it("utilitas: queueJobId aman untuk BullMQ (tanpa ':'), backoff berlipat dengan batas, settledWithin", async () => {
    const id = queueJobId("outbox", "notification.created:u:0190", "1760320800000");
    expect(id).toBe("outbox.notification.created%3Au%3A0190.1760320800000");
    expect(id).not.toContain(":");
    expect([1, 2, 3, 4].map((attempt) => backoffDelay(1_000, attempt))).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(backoffDelay(1_000, 40)).toBe(3_600_000);
    expect(await settledWithin(Promise.reject(new Error("x")), 50)).toBe(true);
    expect(await settledWithin(new Promise(() => undefined), 20)).toBe(false);
  });
});
