import { auditLogs, notifications, outboxEvents, posts } from "@kapdh/database";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobRegistry } from "../../src/core/jobs/job-registry.js";
import { createAdmin, createAlumni } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { adminSession, insertPost, postRow } from "./support.js";

/**
 * Job `content.announce` (AC F15-5, ARCHITECTURE §4.8): berita terjadwal diterbitkan/diumumkan tepat sekali ketika
 * waktunya tiba; berita yang diarsipkan atau dibatalkan jadwalnya tidak pernah dihidupkan kembali atau diumumkan.
 */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

const announce = () => t.jobs.runScheduled("content.announce");

async function newsFor(postId: string) {
  return t.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.category, "news"), like(notifications.dedupKey, `%:news:${postId}:%`)));
}

describe("AC F15-5: pengumuman berita terjadwal tepat sekali", () => {
  it("AC F15-5: job terdaftar setiap menit (ARCHITECTURE §4.8)", () => {
    const job = t.app.get(JobRegistry).scheduledJob("content.announce");
    expect(job?.everyMs).toBe(60_000);
  });

  it("AC F15-5: saat waktunya tiba, berita diumumkan sekali ke anggota aktif saja; eksekusi ulang tidak menggandakan", async () => {
    const recipients = {
      verified: await createAlumni(t, { status: "verified" }),
      expiring: await createAlumni(t, { status: "expiring" }),
    };
    const excluded = [
      await createAlumni(t, { status: "unverified" }),
      await createAlumni(t, { status: "expired" }),
      await createAlumni(t, { status: "suspended" }),
      await createAlumni(t, { status: "pending_otp" }),
      await createAlumni(t, { status: "verified", accountStatus: "disabled" }),
      await createAlumni(t, { status: "verified", accountStatus: "deletion_pending" }),
    ];
    const admin = await createAdmin(t, { permissions: ["content.manage"] });
    const post = await insertPost(t, {
      publishedAt: new Date(t.clock.now().getTime() + 120_000),
      title: "Pengumuman Reuni",
      excerpt: "Reuni akbar alumni tahun ini.",
    });

    await announce();
    expect(await newsFor(post.id)).toHaveLength(0);
    expect((await postRow(t, post.id))!.announcedAt).toBeNull();

    t.clock.advance(120_000);
    await announce();
    await announce();
    const inbox = await newsFor(post.id);
    const userIds = inbox.map((n) => n.userId);
    for (const member of Object.values(recipients)) expect(userIds.filter((id) => id === member.userId)).toHaveLength(1);
    for (const member of excluded) expect(userIds).not.toContain(member.userId);
    expect(userIds).not.toContain(admin.userId);
    expect(inbox.find((n) => n.userId === recipients.verified.userId)).toMatchObject({
      category: "news",
      title: "Pengumuman Reuni",
      body: "Reuni akbar alumni tahun ini.",
      data: { post_id: post.id, route: `/news/${post.slug}` },
    });

    const row = await postRow(t, post.id);
    expect(row!.announcedAt).toEqual(t.clock.now());
    // Pengumuman bukan suntingan pengurus: versi If-Match tidak berubah.
    expect(row!.version).toBe(post.version);

    const outbox = await t.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.topic, "notification.created"),
          inArray(
            outboxEvents.dedupKey,
            inbox.map((n) => `notification.created:${n.id}`),
          ),
        ),
      );
    expect(outbox).toHaveLength(inbox.length);
    const audit = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, post.id), eq(auditLogs.action, "post.announced")));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.effectiveRole).toBe("system");
  });

  it("AC F15-5: klaim yang dibatalkan lalu diulang tidak menggandakan inbox (dedup per pengguna + berita)", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const post = await insertPost(t, { publishedAt: new Date(t.clock.now().getTime() - 1000) });
    await announce();
    expect((await newsFor(post.id)).filter((n) => n.userId === member.userId)).toHaveLength(1);
    // Simulasi job lama/terulang: announced_at dikosongkan lalu job berjalan lagi.
    await t.db.update(posts).set({ announcedAt: null }).where(eq(posts.id, post.id));
    await announce();
    expect((await newsFor(post.id)).filter((n) => n.userId === member.userId)).toHaveLength(1);
  });

  it("AC F15-5: berita diarsipkan atau dibatalkan jadwalnya sebelum waktunya tidak pernah diumumkan/dihidupkan job", async () => {
    await createAlumni(t, { status: "verified" });
    const admin = await adminSession(t, ["content.manage"]);
    const api = httpClient(t.app);
    const make = async (title: string) => {
      const created = await api.post(
        "/admin/content/posts",
        { title, body_html: "<p>x</p>" },
        { token: admin.token },
      );
      const scheduled = await api.post(
        `/admin/content/posts/${created.json().id}/publish`,
        { published_at: new Date(t.clock.now().getTime() + 120_000).toISOString() },
        { token: admin.token, headers: { "if-match": created.json().version } },
      );
      expect(scheduled.json().state).toBe("scheduled");
      return scheduled.json() as { id: string; version: string };
    };
    const toArchive = await make("Akan diarsipkan");
    const toUnschedule = await make("Akan dibatalkan");
    const archived = await api.post(`/admin/content/posts/${toArchive.id}/archive`, {}, {
      token: admin.token,
      headers: { "if-match": toArchive.version },
    });
    expect(archived.json().state).toBe("archived");
    const unscheduled = await api.post(`/admin/content/posts/${toUnschedule.id}/unschedule`, {}, {
      token: admin.token,
      headers: { "if-match": toUnschedule.version },
    });
    expect(unscheduled.json().state).toBe("draft");

    t.clock.advance(180_000);
    await announce();
    for (const id of [toArchive.id, toUnschedule.id]) {
      expect(await newsFor(id)).toHaveLength(0);
      const row = await postRow(t, id);
      expect(row!.announcedAt).toBeNull();
      expect(row!.publishedAt).toBeNull();
      expect(row!.status).not.toBe("published");
    }
  });

  it("AC F15-5: berita yang sudah diumumkan tidak diumumkan lagi walau diarsipkan lalu diterbitkan ulang", async () => {
    const member = await createAlumni(t, { status: "verified" });
    const admin = await adminSession(t, ["content.manage"]);
    const api = httpClient(t.app);
    const created = await api.post("/admin/content/posts", { title: "Sekali", body_html: "<p>x</p>" }, { token: admin.token });
    let post = (
      await api.post(`/admin/content/posts/${created.json().id}/publish`, {}, {
        token: admin.token,
        headers: { "if-match": created.json().version },
      })
    ).json();
    await announce();
    expect((await newsFor(post.id)).filter((n) => n.userId === member.userId)).toHaveLength(1);
    for (const step of ["archive", "restore", "publish"] as const) {
      const res = await api.post(`/admin/content/posts/${post.id}/${step}`, {}, {
        token: admin.token,
        headers: { "if-match": post.version },
      });
      expect(res.statusCode, `${step}: ${res.body}`).toBe(200);
      post = res.json();
    }
    await announce();
    expect((await newsFor(post.id)).filter((n) => n.userId === member.userId)).toHaveLength(1);
  });
});
