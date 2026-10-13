/**
 * Efek chat dari domain lain lewat ChatLifecycleService (F-11, F-12, F-14; AC F11-5, F14-3, F14-5, F12-1; PRD 3.12):
 * pelepasan akun yang dihapus dengan aturan pengalihan sistem, keputusan moderasi remove_message, dan pemuatan modul di
 * runtime worker (job penghapusan akun berjalan di worker, ARCHITECTURE §4.1, §4.8).
 */
import type { WorkerEnv } from "@kapdh/config";
import { alumni, files, messageReactions, messages, reports, roomMembers, rooms } from "@kapdh/database";
import { MemoryDriver } from "@kapdh/storage";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryMailer } from "../../src/core/adapters/mailer.js";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { withTx } from "../../src/core/db/tx.js";
import { createRootLogger } from "../../src/core/logging/logger.js";
import { ChatLifecycleModule } from "../../src/modules/chat/chat-lifecycle.module.js";
import { ChatLifecycleService } from "../../src/modules/chat/chat-lifecycle.service.js";
import { createWorkerContext } from "../../src/worker.js";
import { expectOperation } from "../support/contract.js";
import { uploadTestFile } from "../support/files.js";
import {
  createTestApp,
  createTestDatabase,
  FakePush,
  type TestApp,
  TestClock,
  testEnv,
} from "../support/test-app.js";
import { api, groupWith, history, member, openDirect, sendRaw, sendText } from "./support.js";

let t: TestApp;
let lifecycle: ChatLifecycleService;

beforeAll(async () => {
  t = await createTestApp();
  lifecycle = t.app.get(ChatLifecycleService);
});
afterAll(async () => {
  await t.app.close();
});

const membership = async (roomId: string, userId: string) =>
  (
    await t.db
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
  )[0];

describe("AC F11-5 / AC F14-5: akun yang dihapus dilepas dari chat dengan aturan pengalihan sistem", () => {
  it("AC F11-5: admin tunggal yang dihapus tidak menghambat: kewenangan dialihkan ke anggota aktif paling lama, grup tanpa anggota aktif ditutup, undangan dibatalkan, pesan menjadi placeholder (AC F14-3)", async () => {
    const leaving = await member(t);
    const early = await member(t);
    const late = await member(t);
    const lapsed = await member(t);
    const inviter = await member(t);
    const groupA = await groupWith(t, leaving, [early, late], "Grup Pengalihan");
    const groupB = await groupWith(t, leaving, [lapsed], "Grup Tanpa Pengganti");
    await t.db
      .update(alumni)
      .set({ expiresAt: new Date(t.clock.now().getTime() - 1000) })
      .where(eq(alumni.userId, lapsed.userId));
    const invited = await api(t).post(
      "/chat/rooms",
      { name: "Grup Undangan", invitee_user_ids: [leaving.userId] },
      { token: inviter.token },
    );
    const groupC = (invited.json() as { room: { id: string } }).room.id;

    const direct = await openDirect(t, leaving, early);
    const image = await uploadTestFile(t, leaving.token, "chat_image");
    const imageMessage = await sendRaw(t, leaving, direct.id, { kind: "image", image_file_id: image.id });
    expect(imageMessage.statusCode).toBe(201);
    const text = await sendText(t, leaving, groupA, "Pesan yang akan menjadi placeholder");
    const fromEarly = await sendText(t, early, groupA, "Pesan anggota lain");
    const reacted = await api(t).put(
      `/chat/rooms/${groupA}/messages/${fromEarly.id}/reactions/${encodeURIComponent("👍")}`,
      {},
      { token: leaving.token },
    );
    expect(reacted.statusCode).toBe(200);

    // Pengungkapan sebelum penghapusan (AC F14-5): dua grup yang admin tunggalnya pengguna ini.
    expect(await lifecycle.soleAdminGroupCount(leaving.userId)).toBe(2);
    const result = await runAsSystem(() => lifecycle.detachDeletedAccount(leaving.userId));
    expect(result).toEqual({
      groupsLeft: 2,
      groupsClosed: 1,
      adminsReassigned: 1,
      invitationsCancelled: 1,
      messagesPlaceholdered: 2,
    });

    // Grup A: anggota aktif yang paling lama bergabung menjadi admin tanpa menunggu respons siapa pun.
    const roomA = await api(t).get(`/chat/rooms/${groupA}`, { token: early.token });
    expect(expectOperation("get", "/chat/rooms/{roomId}", roomA)).toMatchObject({
      my_role: "admin",
      can_manage: true,
      member_count: 2,
      closed_at: null,
    });
    expect((await membership(groupA, late.userId))!.role).toBe("member");
    expect((await membership(groupA, leaving.userId))!.status).toBe("left");
    const seen = (await history(t, early, groupA)).body.items;
    const placeholder = seen.find((m) => m.id === text.id)!;
    expect(placeholder).toMatchObject({ body: null, image: null, reactions: [] });
    expect(placeholder.deleted_at).not.toBeNull();
    expect(seen.find((m) => m.id === fromEarly.id)!.reactions).toEqual([]);
    expect(seen.some((m) => m.kind === "system" && String(m.body).includes("sekarang admin grup"))).toBe(true);

    // Grup B: tidak ada anggota aktif untuk menerima kewenangan → ditutup otomatis.
    const [closedB] = await t.db.select().from(rooms).where(eq(rooms.id, groupB));
    expect(closedB!.closedAt).not.toBeNull();
    // Undangan tertunda untuk pengguna dibatalkan.
    expect((await membership(groupC, leaving.userId))!.status).toBe("removed");
    // Gambar pesan dilepas (tidak dirujuk bukti laporan); reaksi pengguna dihapus.
    const [file] = await t.db.select().from(files).where(eq(files.id, image.id));
    expect(file!.status).toBe("deleted");
    expect(
      await t.db.select().from(messageReactions).where(eq(messageReactions.userId, leaving.userId)),
    ).toEqual([]);

    // Idempoten dan dapat diulang setelah gagal (N-15).
    expect(await runAsSystem(() => lifecycle.detachDeletedAccount(leaving.userId))).toEqual({
      groupsLeft: 0,
      groupsClosed: 0,
      adminsReassigned: 0,
      invitationsCancelled: 0,
      messagesPlaceholdered: 0,
    });
    expect(await lifecycle.soleAdminGroupCount(leaving.userId)).toBe(0);
  });
});

describe("Keputusan moderasi remove_message (kontrak admin-moderation, PRD 3.12)", () => {
  it("PRD 3.12: pesan menjadi placeholder dan reaksinya dihapus; gambar yang dirujuk bukti laporan ditahan; pesan sistem atau yang sudah dihapus tidak diproses", async () => {
    const a = await member(t);
    const b = await member(t);
    const room = await openDirect(t, a, b);
    const image = await uploadTestFile(t, a.token, "chat_image");
    const sent = await sendRaw(t, a, room.id, { kind: "image", image_file_id: image.id, body: "Bukti" });
    const id = (sent.json() as { id: string }).id;
    await api(t).put(`/chat/rooms/${room.id}/messages/${id}/reactions/${encodeURIComponent("😮")}`, {}, { token: b.token });
    await t.db.insert(reports).values({
      id: uuidv7(),
      reporterId: b.userId,
      targetType: "message",
      targetUserId: a.userId,
      targetMessageId: id,
      roomId: room.id,
      category: "harassment",
      evidence: { messages: [{ message_id: id, image: { file_id: image.id } }] },
      dueAt: new Date(t.clock.now().getTime() + 86_400_000),
      createdAt: t.clock.now(),
      updatedAt: t.clock.now(),
    });

    const removed = await runAsSystem(() => withTx(t.db, (tx) => lifecycle.removeMessage(tx, id)));
    expect(removed).toMatchObject({ roomId: room.id });
    const [row] = await t.db.select().from(messages).where(eq(messages.id, id));
    expect(row).toMatchObject({ body: null, imageFileId: null });
    expect(row!.deletedAt).not.toBeNull();
    expect(await t.db.select().from(messageReactions).where(eq(messageReactions.messageId, id))).toEqual([]);
    const [file] = await t.db.select().from(files).where(eq(files.id, image.id));
    expect(file!.status).toBe("ready");
    expect(await runAsSystem(() => withTx(t.db, (tx) => lifecycle.removeMessage(tx, id)))).toBeNull();

    const admin = await member(t);
    const groupId = await groupWith(t, admin, [b]);
    const system = (await history(t, admin, groupId)).body.items.find((m) => m.kind === "system")!;
    expect(await runAsSystem(() => withTx(t.db, (tx) => lifecycle.removeMessage(tx, system.id)))).toBeNull();
  });
});

describe("Runtime worker (ARCHITECTURE §4.1, §4.8)", () => {
  it("ChatLifecycleModule dapat dimuat di worker tanpa provider khusus API (job penghapusan akun F-14)", async () => {
    const { pg, db } = await createTestDatabase();
    const env: WorkerEnv = {
      NODE_ENV: "test",
      DATABASE_URL: testEnv.DATABASE_URL,
      REDIS_URL: undefined,
      LOG_LEVEL: "silent",
      PUBLIC_WEB_URL: testEnv.PUBLIC_WEB_URL,
      API_PUBLIC_URL: testEnv.API_PUBLIC_URL,
      ADMIN_ORIGIN: testEnv.ADMIN_ORIGIN,
      SMTP_URL: undefined,
      MAIL_FROM: testEnv.MAIL_FROM,
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_ROOT: "/tmp",
      S3_ENDPOINT: undefined,
      S3_REGION: undefined,
      S3_BUCKET: undefined,
      S3_ACCESS_KEY_ID: undefined,
      S3_SECRET_ACCESS_KEY: undefined,
      S3_FORCE_PATH_STYLE: false,
      FILE_URL_SECRET: testEnv.FILE_URL_SECRET,
      FCM_PROJECT_ID: undefined,
      FCM_SERVICE_ACCOUNT_JSON: undefined,
      WORKER_CONCURRENCY: 2,
    };
    try {
      const worker = await createWorkerContext(
        {
          env,
          db,
          mailer: new MemoryMailer(),
          clock: new TestClock(),
          push: new FakePush(),
          storage: new MemoryDriver(),
          redis: null,
        },
        {
          extraModules: [ChatLifecycleModule],
          logger: createRootLogger({ level: "silent", service: "kapdh-worker" }),
        },
      );
      try {
        const service = worker.app.get(ChatLifecycleService);
        expect(service).toBeInstanceOf(ChatLifecycleService);
        const unknown = uuidv7();
        expect(await service.soleAdminGroupCount(unknown)).toBe(0);
        expect(await runAsSystem(() => service.detachDeletedAccount(unknown))).toMatchObject({ groupsLeft: 0 });
      } finally {
        await worker.close();
      }
    } finally {
      await pg.close();
    }
  });
});
