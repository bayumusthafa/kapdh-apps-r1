import { auditLogs, events, notifications, outboxEvents, tickets } from "@kapdh/database";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { JobRegistry } from "../../src/core/jobs/job-registry.js";
import { PaymentHandlerRegistry } from "../../src/core/payments-kernel/payment-handler.registry.js";
import { EventsJobsService } from "../../src/modules/events/events-jobs.service.js";
import { reminderDedupKey } from "../../src/modules/events/event-rules.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  adminSession,
  createEventRow,
  DAY,
  eventRow,
  HOUR,
  insertTicket,
  memberSession,
  reserve,
  ticketRow,
} from "./support.js";

/**
 * Job modul events (ARCHITECTURE §4.8): reservations.expire (AC F09-2), events.lifecycle (PRD 4.4), events.reminders
 * (AC F13-6), events.cancelled.fanout (AC F09-7). Setiap job dibuktikan aman diulang.
 */

let t: TestApp;
let service: EventsJobsService;
const api = () => httpClient(t.app);

beforeAll(async () => {
  t = await createTestApp();
  service = t.app.get(EventsJobsService);
});
afterAll(async () => {
  await t.app.close();
});

async function remindersFor(userId: string, eventId: string) {
  return t.db
    .select()
    .from(notifications)
    .where(
      and(eq(notifications.userId, userId), like(notifications.dedupKey, `%event.reminder.%:${eventId}:%`)),
    );
}

describe("Registrasi job (ARCHITECTURE §4.8)", () => {
  it("job dan handler terdaftar: reservations.expire 1 menit, events.lifecycle 5 menit, events.reminders 15 menit, topik event.cancelled, handler payment ticket", async () => {
    const names = Object.fromEntries(
      t.app
        .get(JobRegistry)
        .scheduledJobs()
        .map((job) => [job.name, job.everyMs]),
    );
    expect(names).toMatchObject({
      "reservations.expire": 60_000,
      "events.lifecycle": 300_000,
      "events.reminders": 900_000,
    });
    expect(t.app.get(JobRegistry).topics()).toContain("event.cancelled");
    expect(t.app.get(PaymentHandlerRegistry).has("ticket")).toBe(true);
  });
});

describe("reservations.expire (AC F09-2)", () => {
  it("AC F09-2: hold beberapa event dilepas tepat sekali; job paralel/berulang tidak mengurangi kursi dua kali; awaiting_review tidak disentuh", async () => {
    const first = await createEventRow(t, { seatsTotal: 3 });
    const second = await createEventRow(t, { seatsTotal: 3 });
    const a = await reserve(t, await memberSession(t), first);
    const b = await reserve(t, await memberSession(t), first);
    const c = await reserve(t, await memberSession(t), second);
    const review = await insertTicket(t, {
      eventId: second.id,
      userId: (await memberSession(t)).userId,
      status: "awaiting_review",
      total: "75000.00",
    });
    t.clock.advance(24 * HOUR + 1);
    const [one, two] = await Promise.all([
      runAsSystem(() => service.expireHolds(t.clock.now())),
      runAsSystem(() => service.expireHolds(t.clock.now())),
    ]);
    expect(one + two).toBe(3);
    await t.jobs.runScheduled("reservations.expire");
    for (const id of [a.id, b.id, c.id]) expect((await ticketRow(t, id)).status).toBe("expired");
    expect((await ticketRow(t, review.id)).status).toBe("awaiting_review");
    expect(await eventRow(t, first.id)).toMatchObject({ heldQuantity: 0 });
    expect(await eventRow(t, second.id)).toMatchObject({ heldQuantity: 1 });
    expect(await runAsSystem(() => service.expireHolds(t.clock.now()))).toBe(0);
    const notes = await t.db
      .select()
      .from(notifications)
      .where(like(notifications.dedupKey, `%ticket.expired:${a.id}`));
    expect(notes).toHaveLength(1);
    expect((notes[0]!.data as { route: string }).route).toBe(`/tickets/${a.id}`);
  });
});

describe("events.lifecycle (PRD 4.4)", () => {
  it("PRD 4.4: open → closed sesudah tutup daftar; open/closed → done sesudah acara berakhir; draft/cancelled tidak berubah; berulang aman", async () => {
    const closing = await createEventRow(t, { startsInMs: 2 * HOUR, registrationClosesBeforeStartMs: HOUR });
    const ending = await createEventRow(t, {
      startsInMs: 30 * 60_000,
      durationMs: HOUR,
      registrationClosesBeforeStartMs: 10 * 60_000,
    });
    const draft = await createEventRow(t, {
      status: "draft",
      startsInMs: 30 * 60_000,
      durationMs: HOUR,
      registrationClosesBeforeStartMs: 10 * 60_000,
    });
    const cancelled = await createEventRow(t, {
      status: "cancelled",
      startsInMs: 30 * 60_000,
      durationMs: HOUR,
      registrationClosesBeforeStartMs: 10 * 60_000,
    });
    t.clock.advance(HOUR + 31 * 60_000);
    const result = await runAsSystem(() => service.advanceLifecycle(t.clock.now()));
    expect(result.closed).toBeGreaterThanOrEqual(1);
    expect(result.done).toBeGreaterThanOrEqual(1);
    expect(await eventRow(t, closing.id)).toMatchObject({ status: "closed", version: 2 });
    expect(await eventRow(t, ending.id)).toMatchObject({ status: "done", version: 2 });
    expect((await eventRow(t, draft.id)).status).toBe("draft");
    expect((await eventRow(t, cancelled.id)).status).toBe("cancelled");
    await t.jobs.runScheduled("events.lifecycle");
    expect(await eventRow(t, closing.id)).toMatchObject({ status: "closed", version: 2 });
    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, ending.id), eq(auditLogs.action, "event.status_changed")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.effectiveRole).toBe("system");
    t.clock.advance(5 * HOUR); // acara closing (mulai +2 jam, 4 jam) sudah berakhir
    await t.jobs.runScheduled("events.lifecycle");
    expect((await eventRow(t, closing.id)).status).toBe("done");
  });
});

describe("events.reminders (AC F13-6)", () => {
  it("AC F13-6: H-3 lalu H-1 sekali per pemegang tiket paid; job berulang tidak menggandakan; pemegang suspended/hold dilewati", async () => {
    const event = await createEventRow(t, { price: "0.00", startsInMs: 4 * DAY });
    const holder = await memberSession(t);
    await reserve(t, holder, event);
    const suspended = await memberSession(t, "suspended");
    await insertTicket(t, { eventId: event.id, userId: suspended.userId, status: "paid" });
    const pending = await memberSession(t);
    await insertTicket(t, { eventId: event.id, userId: pending.userId, status: "awaiting_payment" });
    await t.jobs.runScheduled("events.reminders");
    expect(await remindersFor(holder.userId, event.id)).toHaveLength(0);
    t.clock.advance(DAY + HOUR); // < 3 hari sebelum mulai
    await t.jobs.runScheduled("events.reminders");
    await t.jobs.runScheduled("events.reminders");
    const h3 = await remindersFor(holder.userId, event.id);
    expect(h3).toHaveLength(1);
    expect(h3[0]).toMatchObject({
      category: "event",
      dedupKey: `u:${holder.userId}:${reminderDedupKey(event.id, "h3", event.startsAt)}`,
    });
    t.clock.advance(2 * DAY); // < 1 hari sebelum mulai
    await t.jobs.runScheduled("events.reminders");
    await t.jobs.runScheduled("events.reminders");
    const both = await remindersFor(holder.userId, event.id);
    expect(both.map((n) => n.dedupKey.includes(".h1:")).sort()).toEqual([false, true]);
    expect(await remindersFor(suspended.userId, event.id)).toHaveLength(0);
    expect(await remindersFor(pending.userId, event.id)).toHaveLength(0);
  });

  it("AC F13-6: event diubah jadwalnya → pemegang diberi tahu, pengingat jadwal lama tidak berlaku dan jadwal baru mendapat pengingatnya; event dibatalkan tidak diingatkan", async () => {
    const event = await createEventRow(t, { price: "0.00", startsInMs: 2 * DAY });
    const holder = await memberSession(t);
    const ticket = await reserve(t, holder, event);
    await t.jobs.runScheduled("events.reminders");
    expect(await remindersFor(holder.userId, event.id)).toHaveLength(1);
    const manager = await adminSession(t, ["events.manage"]);
    const moved = new Date(event.startsAt.getTime() + 7 * DAY);
    const res = await api().patch(
      `/admin/events/${event.id}`,
      {
        starts_at: moved.toISOString(),
        ends_at: new Date(moved.getTime() + 4 * HOUR).toISOString(),
        registration_closes_at: new Date(moved.getTime() - HOUR).toISOString(),
      },
      { token: manager.token, headers: { "if-match": "1" } },
    );
    expect(res.statusCode, res.body).toBe(200);
    const [changed] = await t.db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupKey, `u:${holder.userId}:event.updated:${event.id}:v2`));
    expect(changed).toMatchObject({ category: "event" });
    expect((changed!.data as { route: string }).route).toBe(`/tickets/${ticket.id}`);
    // Jadwal lama tidak lagi memicu pengingat; jadwal baru belum masuk jendela H-3.
    await t.jobs.runScheduled("events.reminders");
    expect(await remindersFor(holder.userId, event.id)).toHaveLength(1);
    t.clock.advance(6 * DAY);
    await t.jobs.runScheduled("events.reminders");
    const after = await remindersFor(holder.userId, event.id);
    expect(after).toHaveLength(2);
    expect(after.some((n) => n.dedupKey.endsWith(`:${moved.getTime()}`))).toBe(true);

    const cancelledEvent = await createEventRow(t, {
      price: "0.00",
      startsInMs: 2 * DAY,
      status: "cancelled",
    });
    const other = await memberSession(t);
    await insertTicket(t, { eventId: cancelledEvent.id, userId: other.userId, status: "paid" });
    await t.jobs.runScheduled("events.reminders");
    expect(await remindersFor(other.userId, cancelledEvent.id)).toHaveLength(0);
  });
});

describe("events.cancelled.fanout (AC F09-7)", () => {
  it("AC F09-7: outbox event.cancelled diproses worker; notifikasi satu per pemegang terdampak; pemrosesan ulang tidak menggandakan", async () => {
    const event = await createEventRow(t, { price: "0.00", seatsTotal: 5 });
    const a = await memberSession(t);
    const b = await memberSession(t);
    const earlier = await memberSession(t);
    const ticketA = await reserve(t, a, event);
    await reserve(t, b, event);
    const old = await reserve(t, earlier, event);
    await api().post(
      `/me/tickets/${old.id}/cancel`,
      { expected_refund_eligible: false },
      {
        token: earlier.token,
        headers: { "if-match": old.version },
      },
    );
    const manager = await adminSession(t, ["events.manage"]);
    const res = await api().post(
      `/admin/events/${event.id}/cancel`,
      { reason: "Lokasi tidak tersedia" },
      {
        token: manager.token,
        headers: { "if-match": "1" },
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    await t.jobs.drainOutbox();
    const [outbox] = await t.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.dedupKey, `event.cancelled:${event.id}`));
    expect(outbox!.status).toBe("dispatched");
    expect(await runAsSystem(() => service.fanoutCancellation(event.id))).toBe(2);
    const notes = await t.db
      .select()
      .from(notifications)
      .where(like(notifications.dedupKey, `%:event.cancelled:${event.id}`));
    expect(notes.map((n) => n.userId).sort()).toEqual([a.userId, b.userId].sort());
    const noteA = notes.find((n) => n.userId === a.userId)!;
    expect(noteA.body).toMatch(/Lokasi tidak tersedia/);
    expect((noteA.data as { route: string }).route).toBe(`/tickets/${ticketA.id}`);
    // Event yang belum dibatalkan tidak menghasilkan notifikasi.
    const open = await createEventRow(t);
    expect(await runAsSystem(() => service.fanoutCancellation(open.id))).toBe(0);
    const [row] = await t.db.select().from(events).where(eq(events.id, event.id));
    expect(row!.status).toBe("cancelled");
    expect(await t.db.select().from(tickets).where(eq(tickets.eventId, event.id))).toHaveLength(3);
  });
});
