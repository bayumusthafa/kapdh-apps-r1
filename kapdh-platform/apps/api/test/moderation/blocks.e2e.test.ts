import { roomMembers } from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BlockPolicy } from "../../src/core/policy/block.policy.js";
import { expectOperation, expectRealtimeEnvelope } from "../support/contract.js";
import { createAdmin, createAlumni, signInAdmin, signInAlumni } from "../support/factories.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import {
  addRoomMember,
  createDirectRoom,
  createGroupRoom,
  type RecordedEmit,
  recordRealtime,
} from "./fixtures.js";

/**
 * Blokir dua arah (F-12, PRD 3.12, AC F12-1; kontrak moderation.yaml listBlocks/blockMember/unblockMember).
 * Penegakan kirim direct/reaksi/undangan ada di modul chat lewat BlockPolicy (core); di sini dibuktikan bahwa blokir
 * dari SATU pihak membuat BlockPolicy menolak dari kedua arah, dan efek blokir pada undangan/room direct.
 */

let t: TestApp;
let policy: BlockPolicy;
let emits: RecordedEmit[];

beforeAll(async () => {
  t = await createTestApp();
  policy = t.app.get(BlockPolicy);
  emits = recordRealtime(t.app);
});
afterAll(async () => {
  await t.app.close();
});
beforeEach(() => {
  emits.length = 0;
});

async function member(status: "verified" | "expiring" | "expired" | "suspended" = "verified") {
  const fixture = await createAlumni(t, { status, fullName: `Anggota ${status}` });
  const session = await signInAlumni(t, fixture);
  return { ...fixture, token: session.accessToken };
}

const api = () => httpClient(t.app);

describe("PUT/DELETE /blocks/{userId} (AC F12-1)", () => {
  it("AC F12-1: blokir dari satu pihak membuat BlockPolicy menolak kedua arah; idempoten; buka blokir hanya milik sendiri", async () => {
    const a = await member();
    const b = await member("expiring");

    const res = await api().put(`/blocks/${b.userId}`, undefined, { token: a.token });
    expect(res.statusCode, res.body).toBe(200);
    const blocked = expectOperation("put", "/blocks/{userId}", res) as Record<string, unknown>;
    expect(blocked).toMatchObject({ user_id: b.userId, full_name: "Anggota expiring", avatar_url: null });

    // Dua arah: BlockPolicy (core) yang dipanggil modul chat saat kirim direct/undangan menolak A→B maupun B→A.
    // Bukti end-to-end sendChatMessage/undangan yang ditolak milik slice api-chat (modul chat tidak ada di slice ini).
    expect(await policy.isBlockedEitherWay(a.userId, b.userId)).toBe(true);
    expect(await policy.isBlockedEitherWay(b.userId, a.userId)).toBe(true);

    // Idempoten: blokir yang sudah ada dikembalikan apa adanya.
    t.clock.advance(60_000);
    const again = await api().put(`/blocks/${b.userId}`, undefined, { token: a.token });
    expect(again.statusCode).toBe(200);
    expect(again.json().blocked_at).toBe(blocked.blocked_at);

    // Pihak yang diblokir tidak melihat blokir (N-09) dan tidak dapat menghapus blokir pihak lain.
    const listB = await api().get("/blocks", { token: b.token });
    expect((expectOperation("get", "/blocks", listB) as { items: unknown[] }).items).toEqual([]);
    const unblockByB = await api().delete(`/blocks/${a.userId}`, { token: b.token });
    expect(unblockByB.statusCode).toBe(204);
    expectOperation("delete", "/blocks/{userId}", unblockByB);
    expect(await policy.isBlockedEitherWay(b.userId, a.userId)).toBe(true);

    // Pemblokir membuka blokirnya → tidak ada blokir lagi; idempoten.
    expect((await api().delete(`/blocks/${b.userId}`, { token: a.token })).statusCode).toBe(204);
    expect(await policy.isBlockedEitherWay(a.userId, b.userId)).toBe(false);
    expect((await api().delete(`/blocks/${b.userId}`, { token: a.token })).statusCode).toBe(204);
  });

  it("AC F12-1: blokir dua pihak — membuka blokir sendiri tidak menghapus blokir pihak lain", async () => {
    const a = await member();
    const b = await member();
    await api().put(`/blocks/${b.userId}`, undefined, { token: a.token });
    await api().put(`/blocks/${a.userId}`, undefined, { token: b.token });
    await api().delete(`/blocks/${b.userId}`, { token: a.token });
    expect(await policy.isBlockedEitherWay(a.userId, b.userId)).toBe(true);
  });

  it("AC F12-1: undangan grup tertunda di antara keduanya dibatalkan; event hanya ke calon anggota dan admin grup", async () => {
    const a = await member();
    const b = await member();
    const other = await member();
    // A admin grup G1 mengundang B; B admin grup G2 mengundang A; undangan orang lain di G1 tidak tersentuh.
    const g1 = await createGroupRoom(t, { adminId: a.userId });
    await addRoomMember(t, g1, b.userId, { status: "invited", invitedBy: a.userId });
    await addRoomMember(t, g1, other.userId, { status: "invited", invitedBy: a.userId });
    const g2 = await createGroupRoom(t, { adminId: b.userId });
    await addRoomMember(t, g2, a.userId, { status: "invited", invitedBy: b.userId });

    const res = await api().put(`/blocks/${b.userId}`, undefined, { token: a.token });
    expect(res.statusCode, res.body).toBe(200);

    const statusOf = async (roomId: string, userId: string) =>
      (
        await t.db
          .select({ status: roomMembers.status })
          .from(roomMembers)
          .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
      )[0]?.status;
    expect(await statusOf(g1, b.userId)).toBe("removed");
    expect(await statusOf(g2, a.userId)).toBe("removed");
    expect(await statusOf(g1, other.userId)).toBe("invited");

    const cancelled = emits.filter((e) => e.event === "room.member_changed");
    expect(cancelled).toHaveLength(2);
    for (const emit of cancelled) {
      expectRealtimeEnvelope(emit.data);
      expect(emit.data.payload).toMatchObject({
        change: "invitation_cancelled",
        actor_user_id: null,
        role: null,
      });
      // Tidak pernah ke kanal room (undangan tertunda hanya terlihat admin grup).
      expect(emit.channels.every((channel) => channel.startsWith("user:"))).toBe(true);
    }
    const g1Emit = cancelled.find((e) => e.data.payload.room_id === g1)!;
    expect(new Set(g1Emit.channels)).toEqual(new Set([`user:${b.userId}`, `user:${a.userId}`]));
    expect(g1Emit.data.payload).toMatchObject({ user_id: b.userId, member_count: 1 });
  });

  it("AC F12-1: room direct yang ada: hanya perangkat pemanggil menerima room.updated (send_permission)", async () => {
    const a = await member();
    const b = await member();
    const roomId = await createDirectRoom(t, a.userId, b.userId);
    await api().put(`/blocks/${b.userId}`, undefined, { token: a.token });
    const updated = emits.filter((e) => e.event === "room.updated");
    expect(updated).toHaveLength(1);
    expectRealtimeEnvelope(updated[0]!.data);
    expect(updated[0]!.channels).toEqual([`user:${a.userId}`]);
    expect(updated[0]!.data.payload).toMatchObject({ room_id: roomId, changes: ["send_permission"] });

    emits.length = 0;
    await api().delete(`/blocks/${b.userId}`, { token: a.token });
    expect(emits.filter((e) => e.event === "room.updated").map((e) => e.channels)).toEqual([
      [`user:${a.userId}`],
    ]);
  });

  it("AC F12-1: validasi: diri sendiri dan id bukan UUID → 400; akun tidak ada/admin/pending_otp → 404", async () => {
    const a = await member();
    const self = await api().put(`/blocks/${a.userId}`, undefined, { token: a.token });
    expect(self.statusCode).toBe(400);
    expectOperation("put", "/blocks/{userId}", self);
    expect((await api().delete(`/blocks/${a.userId}`, { token: a.token })).statusCode).toBe(400);
    expect((await api().put("/blocks/bukan-uuid", undefined, { token: a.token })).statusCode).toBe(400);
    expect((await api().delete("/blocks/bukan-uuid", { token: a.token })).statusCode).toBe(400);

    const missing = await api().put(`/blocks/${uuidv7()}`, undefined, { token: a.token });
    expect(missing.statusCode).toBe(404);
    expectOperation("put", "/blocks/{userId}", missing);
    const admin = await createAdmin(t);
    expect((await api().put(`/blocks/${admin.userId}`, undefined, { token: a.token })).statusCode).toBe(404);
    const pending = await createAlumni(t, { status: "pending_otp" });
    expect((await api().put(`/blocks/${pending.userId}`, undefined, { token: a.token })).statusCode).toBe(
      404,
    );
  });

  it("AC F12-1: otorisasi: hanya anggota aktif (expired/suspended 403), sesi admin 403, tanpa sesi 401", async () => {
    const target = await member();
    const expired = await member("expired");
    const res = await api().put(`/blocks/${target.userId}`, undefined, { token: expired.token });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("MEMBERSHIP_REQUIRED");
    const suspended = await member("suspended");
    const blocked = await api().get("/blocks", { token: suspended.token });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe("ACCOUNT_SUSPENDED");

    const admin = await createAdmin(t, { role: "super_admin" });
    const adminSession = await signInAdmin(t, admin);
    expect((await api().get("/blocks", { token: adminSession.accessToken })).statusCode).toBe(403);
    expect((await api().get("/blocks")).statusCode).toBe(401);
    expect((await api().delete(`/blocks/${target.userId}`)).statusCode).toBe(401);
  });
});

describe("GET /blocks", () => {
  it("AC F12-1: hanya blokir milik pemanggil, terbaru dulu, keyset cursor", async () => {
    const owner = await member();
    const targets = [];
    for (let i = 0; i < 3; i++) {
      targets.push(await member());
      await api().put(`/blocks/${targets[i]!.userId}`, undefined, { token: owner.token });
      t.clock.advance(1000);
    }
    const first = await api().get("/blocks", { token: owner.token, query: { limit: "2" } });
    const page1 = expectOperation("get", "/blocks", first) as {
      items: { user_id: string }[];
      next_cursor: string | null;
    };
    expect(page1.items.map((i) => i.user_id)).toEqual([targets[2]!.userId, targets[1]!.userId]);
    expect(page1.next_cursor).not.toBeNull();
    const second = await api().get("/blocks", {
      token: owner.token,
      query: { limit: "2", cursor: page1.next_cursor! },
    });
    const page2 = expectOperation("get", "/blocks", second) as {
      items: { user_id: string }[];
      next_cursor: string | null;
    };
    expect(page2.items.map((i) => i.user_id)).toEqual([targets[0]!.userId]);
    expect(page2.next_cursor).toBeNull();

    const bad = await api().get("/blocks", { token: owner.token, query: { cursor: "rusak!" } });
    expect(bad.statusCode).toBe(400);
    expectOperation("get", "/blocks", bad);
  });
});
