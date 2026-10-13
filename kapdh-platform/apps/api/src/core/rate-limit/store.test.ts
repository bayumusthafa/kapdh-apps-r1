import { describe, expect, it } from "vitest";
import { AppException } from "../errors/app-exception.js";
import { RateLimitService } from "./rate-limit.service.js";
import { MAX_HITS_PER_KEY, MemoryRateLimitStore, storageKey } from "./store.js";

const MINUTE = 60_000;

describe("MemoryRateLimitStore sliding window (PRD 2.5, D1)", () => {
  it("consume mencatat sampai limit lalu memberi waktu tunggu sampai hit tertua keluar jendela", async () => {
    const store = new MemoryRateLimitStore();
    const t0 = 1_000_000;
    expect(await store.consume("otp:a@contoh.test", 3, 10 * MINUTE, t0)).toBe(0);
    expect(await store.consume("otp:a@contoh.test", 3, 10 * MINUTE, t0 + MINUTE)).toBe(0);
    expect(await store.consume("otp:a@contoh.test", 3, 10 * MINUTE, t0 + 2 * MINUTE)).toBe(0);
    // Hit ke-4 ditolak dan TIDAK dicatat; tunggu sampai hit pertama (t0) keluar jendela.
    expect(await store.consume("otp:a@contoh.test", 3, 10 * MINUTE, t0 + 3 * MINUTE)).toBe(7 * MINUTE);
    expect(await store.consume("otp:a@contoh.test", 3, 10 * MINUTE, t0 + 10 * MINUTE + 1)).toBe(0);
  });

  it("peek tidak mencatat; hit mencatat tanpa syarat; reset menghapus", async () => {
    const store = new MemoryRateLimitStore();
    expect(await store.peek("login:x", 1, MINUTE, 0)).toBe(0);
    expect(await store.peek("login:x", 1, MINUTE, 1)).toBe(0);
    // hit mengembalikan jumlah hit dalam jendela sesudah dicatat (sisa percobaan).
    expect(await store.hit("login:x", MINUTE, 10)).toBe(1);
    expect(await store.hit("login:x", MINUTE, 20)).toBe(2);
    expect(await store.peek("login:x", 2, MINUTE, 30)).toBe(MINUTE - 20);
    // Hit yang keluar jendela tidak dihitung.
    expect(await store.hit("login:x", MINUTE, MINUTE + 15)).toBe(2);
    await store.reset("login:x");
    await store.hit("login:x", MINUTE, 10);
    await store.hit("login:x", MINUTE, 20);
    await store.reset("login:x");
    expect(await store.peek("login:x", 1, MINUTE, 30)).toBe(0);
  });

  it("kunci berbeda terpisah dan kunci kedaluwarsa dipangkas (memori tidak tumbuh tanpa batas)", async () => {
    const store = new MemoryRateLimitStore(10);
    for (let i = 0; i < 100; i++) await store.consume(`login-ip:198.51.100.${i}`, 5, MINUTE, i);
    expect(store.size).toBe(100);
    // Setelah jendela lewat, sapuan berkala membuang semua kunci lama; peek kunci baru tidak menambah entri.
    for (let i = 0; i < 20; i++) await store.peek(`acak-${i}`, 5, MINUTE, 10 * MINUTE);
    expect(store.size).toBe(0);
  });

  it("jumlah hit per kunci dibatasi", async () => {
    const store = new MemoryRateLimitStore();
    for (let i = 0; i < MAX_HITS_PER_KEY + 50; i++) await store.hit("login:spam", MINUTE, i);
    expect(await store.peek("login:spam", MAX_HITS_PER_KEY, MINUTE, MAX_HITS_PER_KEY + 50)).toBeGreaterThan(
      0,
    );
    expect(await store.peek("login:spam", MAX_HITS_PER_KEY + 1, MINUTE, MAX_HITS_PER_KEY + 50)).toBe(0);
  });

  it("nama kunci penyimpanan tidak memuat PII mentah (email/IP di-hash)", () => {
    const key = storageKey("otp:rahasia@contoh.test");
    expect(key).toMatch(/^kapdh:rl:otp:[A-Za-z0-9_-]{32}$/);
    expect(key).not.toContain("rahasia");
    expect(storageKey("otp:a@contoh.test")).not.toBe(storageKey("otp:b@contoh.test"));
  });
});

describe("Reservasi atomik acquire/release (PRD 2.5, D1: batas kegagalan tidak dapat dilewati paralel)", () => {
  it("acquire mencatat dan mengembalikan jumlah + tiket; penuh → ms tunggu tanpa pencatatan; release mengembalikan", async () => {
    const store = new MemoryRateLimitStore();
    const first = await store.acquire("mfa:a", 2, MINUTE, 1_000);
    const second = await store.acquire("mfa:a", 2, MINUTE, 1_000);
    expect(first).toMatchObject({ waitMs: 0, count: 1 });
    expect(second).toMatchObject({ waitMs: 0, count: 2 });
    expect(first.ticket).not.toBeNull();
    const full = await store.acquire("mfa:a", 2, MINUTE, 1_500);
    expect(full).toEqual({ waitMs: MINUTE - 500, count: 0, ticket: null });
    await store.release("mfa:a", second.ticket!);
    expect(await store.acquire("mfa:a", 2, MINUTE, 2_000)).toMatchObject({ waitMs: 0, count: 2 });
    // Release tiket yang sudah keluar jendela / kunci tidak ada tidak melempar.
    await store.release("tidak-ada", "1");
  });

  it("RateLimitService.reserve: N panggilan bersamaan → tepat `limit` slot; release idempoten", async () => {
    const service = new RateLimitService(new MemoryRateLimitStore(), {
      now: () => new Date("2026-10-13T02:00:00Z"),
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.reserve("login:x", 5, MINUTE)),
    );
    const slots = results.filter((r) => r.slot !== null);
    expect(slots).toHaveLength(5);
    expect(slots.map((r) => r.slot!.count).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(results.filter((r) => r.slot === null).every((r) => r.wait > 0)).toBe(true);
    await slots[0]!.slot!.release();
    await slots[0]!.slot!.release();
    const again = await service.reserve("login:x", 5, MINUTE);
    expect(again.slot?.count).toBe(5);
    expect((await service.reserve("login:x", 5, MINUTE)).slot).toBeNull();
    await expect(service.reserveOrThrow("login:x", 5, MINUTE, "Coba lagi nanti.")).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
    });
  });
});

describe("RateLimitService (ARCHITECTURE §4.2)", () => {
  it("consume mengembalikan detik tunggu dan consumeOrThrow melempar 429 RATE_LIMITED dengan retry_after", async () => {
    let now = new Date("2026-10-13T02:00:00Z");
    const service = new RateLimitService(new MemoryRateLimitStore(), { now: () => now });
    expect(await service.consume("otp:x", 1, 90_000)).toBe(0);
    expect(await service.consume("otp:x", 1, 90_000)).toBe(90);
    await expect(service.consumeOrThrow("otp:x", 1, 90_000, "Coba lagi nanti.")).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      extra: { retryAfterSeconds: 90 },
    });
    now = new Date(now.getTime() + 89_500);
    const error = await service.assertNotLimited("otp:x", 1, 90_000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).extra.retryAfterSeconds).toBe(1);
    now = new Date(now.getTime() + 1_000);
    await expect(service.assertNotLimited("otp:x", 1, 90_000)).resolves.toBeUndefined();
  });
});
