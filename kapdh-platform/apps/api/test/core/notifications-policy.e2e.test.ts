import { blocks, notifications, outboxEvents } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { withTx } from "../../src/core/db/tx.js";
import type { Tx } from "../../src/core/db/types.js";
import {
  NotificationInputError,
  NotificationService,
  type NotifyInput,
} from "../../src/core/notifications-kernel/notification.service.js";
import { BlockPolicy } from "../../src/core/policy/block.policy.js";
import { createAlumni } from "../support/factories.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

let t: TestApp;
let service: NotificationService;
let policy: BlockPolicy;

beforeAll(async () => {
  t = await createTestApp();
  service = t.app.get(NotificationService);
  policy = t.app.get(BlockPolicy);
});
afterAll(async () => {
  await t.app.close();
});

function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runAsSystem(() => withTx(t.db, fn));
}

describe("NotificationService.notify (ARCHITECTURE §4.7; AC F04-1, F13-1, F13-6)", () => {
  it("inbox + outbox notification.created dalam transaksi pemanggil; kunci dedup per pengguna; rollback membatalkan keduanya", async () => {
    const a = await createAlumni(t);
    const b = await createAlumni(t);
    const input = (userId: string): NotifyInput => ({
      userId,
      category: "event",
      title: "  Pengingat event H-1  ",
      body: "Reuni akbar dimulai besok pukul 09.00 WIB.",
      route: "/events",
      data: { event_day: 1, reminder: true },
      dedupKey: "event.reminder:uji:h1",
    });
    const forA = await inTx((tx) => service.notify(tx, input(a.userId)));
    // Kunci dedup yang sama untuk pengguna lain bukan duplikat (notifications.dedup_key unik global).
    const forB = await inTx((tx) => service.notify(tx, input(b.userId)));
    expect(forA.created && forB.created).toBe(true);
    const [row] = await t.db.select().from(notifications).where(eq(notifications.id, forA.id));
    expect(row).toMatchObject({
      userId: a.userId,
      category: "event",
      title: "Pengingat event H-1",
      data: { event_day: 1, reminder: true, route: "/events" },
      dedupKey: `u:${a.userId}:event.reminder:uji:h1`,
      readAt: null,
    });
    const [outbox] = await t.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.dedupKey, `notification.created:${forA.id}`));
    expect(outbox).toMatchObject({
      topic: "notification.created",
      payload: { notification_id: forA.id, user_id: a.userId },
    });
    // Job diulang: tidak ada inbox/outbox baru (AC F13-6).
    expect(await inTx((tx) => service.notify(tx, input(a.userId)))).toEqual({ id: forA.id, created: false });
    expect(await service.unreadCount(a.userId)).toBe(1);

    await expect(
      inTx(async (tx) => {
        await service.notify(tx, { ...input(a.userId), dedupKey: "batal" });
        throw new Error("transaksi bisnis gagal");
      }),
    ).rejects.toThrow("transaksi bisnis gagal");
    expect(await service.unreadCount(a.userId)).toBe(1);
  });

  it("validasi masukan: kategori, judul, isi, rute §8.4, data datar tanpa kunci route, dedupKey", async () => {
    const member = await createAlumni(t);
    const base: NotifyInput = { userId: member.userId, category: "payment", title: "Judul", dedupKey: "uji" };
    const invalid: Partial<NotifyInput>[] = [
      { category: "promo" as NotifyInput["category"] },
      { title: "   " },
      { title: "x".repeat(121) },
      { body: "x".repeat(501) },
      { route: "https://phishing.test/payments" },
      { route: "/admin/payments" },
      { data: { route: "/kta" } },
      { data: { "Kunci-Salah": 1 } },
      { data: { nested: { a: 1 } as unknown as string } },
      { dedupKey: "" },
    ];
    for (const patch of invalid)
      await expect(
        inTx((tx) => service.notify(tx, { ...base, ...patch })),
        JSON.stringify(patch),
      ).rejects.toBeInstanceOf(NotificationInputError);
    await expect(t.db.transaction((tx) => service.notify(tx, base))).rejects.toThrow(/withTx/);
    expect(await service.unreadCount(member.userId)).toBe(0);
  });
});

describe("BlockPolicy.isBlockedEitherWay (PRD 3.12, AC F12-1)", () => {
  it("blokir dari salah satu pihak berlaku dua arah; tanpa blokir false; diri sendiri false; membaca tx pemanggil", async () => {
    const a = await createAlumni(t);
    const b = await createAlumni(t);
    const c = await createAlumni(t);
    expect(await policy.isBlockedEitherWay(a.userId, b.userId)).toBe(false);
    await t.db.insert(blocks).values({ blockerId: b.userId, blockedId: a.userId, createdAt: t.clock.now() });
    expect(await policy.isBlockedEitherWay(a.userId, b.userId)).toBe(true);
    expect(await policy.isBlockedEitherWay(b.userId, a.userId)).toBe(true);
    expect(await policy.isBlockedEitherWay(a.userId, c.userId)).toBe(false);
    expect(await policy.isBlockedEitherWay(a.userId, a.userId)).toBe(false);
    expect([...(await policy.blockedEitherWay(a.userId))]).toEqual([b.userId]);

    // Di dalam transaksi yang membuat blokir, keadaan baru langsung terlihat; kunci pasangan dapat diambil ulang.
    await inTx(async (tx) => {
      await policy.lockPair(tx, c.userId, a.userId);
      await policy.lockPair(tx, a.userId, c.userId);
      await tx.insert(blocks).values({ blockerId: a.userId, blockedId: c.userId, createdAt: t.clock.now() });
      expect(await policy.isBlockedEitherWay(c.userId, a.userId, tx)).toBe(true);
    });
    expect(await policy.isBlockedEitherWay(c.userId, a.userId)).toBe(true);
  });
});
