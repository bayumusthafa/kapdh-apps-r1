import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountDeletions, alumni, auditLogs, roomMembers, rooms } from "@kapdh/database";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runAsSystem } from "../../src/core/context/request-context.js";
import { RealtimeService } from "../../src/core/realtime/realtime.service.js";
import { MemoryDriver } from "@kapdh/storage";
import {
  ledgerObjectKey,
  readLedgerDirectory,
  writeLedgerEntryMonotonic,
} from "../../src/modules/account/deletion-ledger.js";
import { DeletionLedgerService } from "../../src/modules/account/deletion-ledger.service.js";
import {
  ACCOUNT_DELETION_JOB,
  AccountDeletionProcessor,
  type DeletionRunResult,
  deletionRetryBackoffMs,
  EMAIL_MAX_FAILURES,
} from "../../src/modules/account/deletion-processor.js";
import { redactAuditSnapshot, scrubEvidence } from "../../src/modules/account/deletion-redaction.js";
import { deletedEmailFor } from "../../src/modules/account/deletion-steps.js";
import { OffsiteDeletionLedger } from "../../src/modules/account/offsite-deletion-ledger.js";
import {
  createAlumni,
  DEFAULT_PASSWORD,
  publishLegalVersions,
  signInAlumni,
  TEST_CONSENT_VERSION,
} from "../support/factories.js";
import { expectRealtimeEnvelope } from "../support/contract.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";
import { expectFullyDeleted } from "./expect-deleted.js";
import {
  appFromBackup,
  createRichMember,
  DELETION_STEPS,
  deletionRow,
  ensureAuditPurgeRole,
  exportLedger,
  exportOffsiteLedger,
  personalDataHits,
  personalTerms,
  readLedger,
  requestDeletionViaApp,
  restoreStorage,
  runDeletion,
  snapshotStorage,
  userRow,
} from "./support.js";

/**
 * Job `account.deletion` (F-14, AC F14-2..F14-6, D2; ARCHITECTURE §4.8): penghapusan penuh akun dengan data di setiap
 * tabel, injeksi kegagalan sesudah setiap langkah lalu retry, dan penerapan ulang deletion ledger setelah restore.
 * Pemeriksaan per tabel ada di ./expect-deleted.ts (dipakai juga jalur PostgreSQL 17).
 */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
  await ensureAuditPurgeRole(t.db);
});
afterAll(async () => {
  await t.app.close();
});
afterEach(() => {
  t.app.get(AccountDeletionProcessor).setStepObserver(null);
});

describe("Job account.deletion: penghapusan penuh (AC F14-3, F14-4, F14-5)", () => {
  it("AC F14-3, AC F14-4, AC F14-5, AC F14-6: outbox account.deletion.requested memicu job; seluruh tabel diperiksa, email konfirmasi dan selesai terkirim, ledger eksternal hanya id", async () => {
    const rich = await createRichMember(t);
    // Pemeriksaan per tabel tidak hampa: sebelum penghapusan data pribadi ditemukan di tabel-tabel berikut.
    expect(Object.keys(await personalDataHits(t.db, personalTerms(rich)))).toEqual(
      expect.arrayContaining([
        "alumni",
        "audit_logs",
        "idempotency_keys",
        "membership_events",
        "messages",
        "notifications",
        "payment_adjustments",
        "payment_events",
        "payments",
        "reports",
        "tickets",
        "users",
      ]),
    );
    const mailBefore = t.mailer.mail.length;
    const { id, requestNumber } = await requestDeletionViaApp(t, rich.session);

    // Pemicu topik outbox (ARCHITECTURE §4.8): dispatcher worker menjalankan job sampai selesai.
    await t.jobs.drainOutbox();
    const deletion = await expectFullyDeleted(t, rich, requestNumber);
    expect(deletion.completedAt!.getTime() - deletion.requestedAt.getTime()).toBeLessThanOrEqual(
      7 * 24 * 3600_000,
    );

    // Email konfirmasi (nomor permintaan) lalu email selesai, dikirim sebelum alamat dihapus (F-14).
    const mail = t.mailer.mail.slice(mailBefore);
    expect(mail.map((m) => m.to)).toEqual([rich.member.email, rich.member.email]);
    expect(mail[0]!.subject).toContain(requestNumber);
    expect(mail[0]!.text).toContain(requestNumber);
    expect(mail[1]!.subject).toBe(`Penghapusan akun KAPDH ${requestNumber} selesai`);

    // Deletion ledger eksternal (AC F14-6): satu objek per permintaan, hanya id dan object key.
    const key = ledgerObjectKey(requestNumber, deletion.requestedAt);
    expect(key).toBe(`ledger/account-deletions/2026/10/${requestNumber.toLowerCase()}.json`);
    const ledger = readLedger(t.storage, key);
    expect(ledger).toMatchObject({
      kind: "kapdh.account_deletion",
      deletion_id: id,
      request_number: requestNumber,
      user_id: rich.member.userId,
      source: "app",
      state: "completed",
    });
    expect(ledger.object_keys).toEqual(
      expect.arrayContaining([rich.files.avatar.objectKey, rich.files.proofOld.objectKey]),
    );
    const raw = JSON.stringify(ledger) + JSON.stringify(deletion.ledger);
    for (const term of personalTerms(rich)) expect(raw).not.toContain(term);

    // Audit penyelesaian tanpa data pribadi.
    const [done] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "account.deletion_completed"), eq(auditLogs.entityId, id)));
    expect(done).toMatchObject({
      effectiveRole: "system",
      after: { request_number: requestNumber, status: "completed" },
    });

    // Akun tidak lagi dapat login; status penghapusan tidak lagi muncul lewat login (akun sudah dihapus).
    const login = await httpClient(t.app).post("/auth/login", {
      email: rich.member.email,
      password: DEFAULT_PASSWORD,
    });
    expect(login.statusCode).toBe(401);

    // Nomor urut anggota (N) tidak pernah dipakai ulang setelah profil dihapus (sequence, PRD 3.5).
    const next = await createAlumni(t, { status: "verified" });
    expect(next.memberSeq!).toBeGreaterThan(rich.member.memberSeq!);
    expect(
      await t.db
        .select({ id: alumni.userId })
        .from(alumni)
        .where(eq(alumni.memberSeq, rich.member.memberSeq!)),
    ).toEqual([]);
  });

  it("AC F14-5, PRD 3.14: identitas Super Admin tertaut tetap aktif; penghapusan tidak menunggu respons anggota grup lain", async () => {
    const owner = await createAlumni(t, { status: "verified" });
    const invited = await createAlumni(t, { status: "verified" });
    const session = await signInAlumni(t, owner);
    const now = t.clock.now();
    const roomId = uuidv7();
    await t.db.insert(rooms).values({
      id: roomId,
      kind: "group",
      name: "Grup Undangan",
      createdBy: owner.userId,
      createdAt: now,
      updatedAt: now,
    });
    await t.db.insert(roomMembers).values([
      {
        roomId,
        userId: owner.userId,
        role: "admin",
        status: "joined",
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        roomId,
        userId: invited.userId,
        role: "member",
        status: "invited",
        invitedBy: owner.userId,
        invitedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const { id } = await requestDeletionViaApp(t, session);
    expect(await runDeletion(t, id)).toMatchObject({ outcome: "completed" });
    // Undangan yang belum dijawab tidak menahan penghapusan: grup ditutup, undangan dibatalkan.
    const [room] = await t.db.select().from(rooms).where(eq(rooms.id, roomId));
    expect(room!.closedAt).not.toBeNull();
    const [invitation] = await t.db
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, invited.userId)));
    expect(invitation).toMatchObject({ status: "removed", invitedBy: null });
  });

  it("F-14, D2: pendaftaran pending_otp yang dibatalkan lewat web dihapus job tanpa nomor anggota; email dapat dipakai mendaftar lagi", async () => {
    const pending = await createAlumni(t, { status: "pending_otp", fullName: "Calon Terhapus" });
    const api = httpClient(t.app);
    const started = await api.post("/public/deletion/challenge", { email: pending.email });
    const verified = await api.post("/public/deletion/verify", {
      challenge_id: started.json().challenge_id,
      code: t.mailer.last(pending.email),
    });
    expect(verified.json()).toMatchObject({ registration_pending: true });
    const confirmed = await api.post("/public/deletion/confirm", {
      deletion_token: verified.json().deletion_token,
      confirm: true,
      acknowledged_disclosure_version: verified.json().disclosure.version,
    });
    expect(confirmed.statusCode, confirmed.body).toBe(202);
    const [row] = await t.db
      .select()
      .from(accountDeletions)
      .where(eq(accountDeletions.requestNumber, confirmed.json().request_number));
    expect(await runDeletion(t, row!.id)).toMatchObject({ outcome: "completed" });
    expect(await userRow(t.db, pending.userId)).toMatchObject({
      status: "deleted",
      email: deletedEmailFor(pending.userId),
    });
    expect(await personalDataHits(t.db, [pending.email, "Calon Terhapus"])).toEqual({});

    await publishLegalVersions(t);
    const again = await api.post("/auth/register", {
      full_name: "Calon Baru",
      gender: "male",
      email: pending.email,
      password: DEFAULT_PASSWORD,
      cohort: 29,
      class_in: 1,
      class_out: 6,
      accept_policy_version: TEST_CONSENT_VERSION,
    });
    expect(again.statusCode, again.body).toBe(201);
  });

  it("AC F14-1, AC F14-3, AC F14-5: event realtime permintaan dan job (session.revoked, message.created/deleted, room.member_changed, room.updated) sesuai skema kontrak dan tanpa isi pesan pengguna", async () => {
    const own = await createTestApp();
    try {
      await ensureAuditPurgeRole(own.db);
      const captured: { channels: string[]; event: string; data: unknown; except: string[] }[] = [];
      own.app.get(RealtimeService).useTransport({
        kind: "none",
        emit: (channels, event, data, except) => captured.push({ channels, event, data, except }),
        join: () => undefined,
        leave: () => undefined,
        disconnect: () => undefined,
      });
      const rich = await createRichMember(own);
      const { id } = await requestDeletionViaApp(own, rich.session);
      // Socket pengguna diputus setelah commit permintaan (AC F14-1).
      expect(captured.map((c) => c.event)).toContain("session.revoked");
      expect(await runDeletion(own, id)).toMatchObject({ outcome: "completed" });
      for (const { data } of captured) expectRealtimeEnvelope(data);
      const types = new Set(captured.map((c) => c.event));
      for (const type of ["message.created", "message.deleted", "room.member_changed", "room.updated"])
        expect(types, type).toContain(type);
      // AC F14-5: pengalihan admin (role_changed) sampai ke room dan ke user:<pengganti>, tepat sekali per socket.
      const roleChanged = captured.filter(
        (c) =>
          c.event === "room.member_changed" &&
          (c.data as { payload: { change: string } }).payload.change === "role_changed",
      );
      expect(roleChanged.map(({ channels, except }) => ({ channels, except }))).toEqual([
        { channels: [`room:${rich.rooms.transfer}`], except: [`user:${rich.peer.userId}`] },
        { channels: [`user:${rich.peer.userId}`], except: [] },
      ]);
      for (const { data } of roleChanged)
        expect((data as { payload: unknown }).payload).toMatchObject({
          room_id: rich.rooms.transfer,
          user_id: rich.peer.userId,
          role: "admin",
          actor_user_id: null,
        });
      const serialized = JSON.stringify(captured);
      for (const term of personalTerms(rich)) expect(serialized).not.toContain(term);
    } finally {
      await own.app.close();
    }
  });
});

describe("Job account.deletion: kegagalan dan retry (AC F14-2)", () => {
  it.each(DELETION_STEPS.map((step, index) => [step, index] as const))(
    "AC F14-2: gagal sesudah langkah %s → status failed dengan last_error aman, retry setelah backoff melanjutkan steps_done tanpa mengulang transaksi",
    async (step, index) => {
      const rich = await createRichMember(t);
      const { id, requestNumber } = await requestDeletionViaApp(t, rich.session);
      const processor = t.app.get(AccountDeletionProcessor);
      let injected = false;
      processor.setStepObserver(({ step: done }) => {
        if (done === step && !injected) {
          injected = true;
          throw new Error(`gangguan uji ${rich.member.email}`);
        }
      });
      expect(await runDeletion(t, id)).toEqual({ outcome: "failed", requestNumber, step });
      const failed = await deletionRow(t.db, id);
      expect(failed.status).toBe("failed");
      expect(failed.stepsDone).toEqual(DELETION_STEPS.slice(0, index + 1));
      expect(failed.lastError).toBe(`${step}:Error`);
      expect(failed.lastError).not.toContain(rich.member.email);
      expect(failed.nextAttemptAt!.getTime()).toBe(t.clock.now().getTime() + deletionRetryBackoffMs(1));

      // Sebelum backoff: belum dijalankan ulang; sesudahnya dilanjutkan dari steps_done.
      expect(await runDeletion(t, id)).toEqual({ outcome: "skipped" });
      t.clock.advance(deletionRetryBackoffMs(1));
      expect(await runDeletion(t, id)).toEqual({ outcome: "completed", requestNumber });
      const completed = await expectFullyDeleted(t, rich, requestNumber);
      expect(completed.attempts).toBe(2);
    },
    120_000,
  );

  it("AC F14-2: storage gagal di tengah langkah files → objek yang sudah terhapus tidak menjadi galat saat retry", async () => {
    const rich = await createRichMember(t);
    const { id, requestNumber } = await requestDeletionViaApp(t, rich.session);
    const processor = t.app.get(AccountDeletionProcessor);
    processor.setStepObserver(({ step }) => {
      if (step === "community") t.storage.failNext("delete", 1);
    });
    // Langkah files: objek pertama gagal dihapus → permintaan failed di langkah files.
    const first = await runDeletion(t, id);
    expect(first).toMatchObject({ outcome: "failed", step: "files" });
    processor.setStepObserver(null);
    t.clock.advance(deletionRetryBackoffMs(1));
    expect(await runDeletion(t, id)).toMatchObject({ outcome: "completed" });
    await expectFullyDeleted(t, rich, requestNumber);
  });

  it("F-14, D2: email konfirmasi gagal → diulang; setelah gagal berulang langkah email dilewati agar data pribadi tidak tertahan", async () => {
    const rich = await createRichMember(t);
    const { id, requestNumber } = await requestDeletionViaApp(t, rich.session);
    t.mailer.failNextTransactional(1);
    expect(await runDeletion(t, id)).toMatchObject({ outcome: "failed", step: "notify_requested" });
    expect((await deletionRow(t.db, id)).stepsDone).toEqual(["ledger_open"]);
    t.clock.advance(deletionRetryBackoffMs(1));
    // Email kedua berhasil; sisanya berjalan normal.
    expect(await runDeletion(t, id)).toMatchObject({ outcome: "completed" });
    await expectFullyDeleted(t, rich, requestNumber);

    const other = await createRichMember(t);
    const second = await requestDeletionViaApp(t, other.session);
    t.mailer.failNextTransactional(EMAIL_MAX_FAILURES);
    for (let attempt = 1; attempt < EMAIL_MAX_FAILURES; attempt++) {
      expect(await runDeletion(t, second.id)).toMatchObject({ outcome: "failed", step: "notify_requested" });
      t.clock.advance(deletionRetryBackoffMs(attempt));
    }
    expect(await runDeletion(t, second.id)).toMatchObject({ outcome: "completed" });
    const done = await expectFullyDeleted(t, other, second.requestNumber);
    expect(done.ledger).toMatchObject({
      skipped: ["notify_requested"],
      email_failures: { notify_requested: 3 },
    });
  });

  it("AC F14-2: sapuan 10 menit memproses permintaan pending tanpa pemicu outbox dan mengambil alih klaim yang sewanya habis; eksekusi bersamaan diklaim sekali", async () => {
    const processor = t.app.get(AccountDeletionProcessor);
    const job = t.jobs;
    const lost = await createAlumni(t, { status: "verified" });
    const { id } = await requestDeletionViaApp(t, await signInAlumni(t, lost));
    // Worker mati setelah klaim: baris processing dengan sewa yang masih berlaku tidak diambil.
    await t.db
      .update(accountDeletions)
      .set({
        status: "processing",
        attempts: 1,
        nextAttemptAt: new Date(t.clock.now().getTime() + 15 * 60_000),
      })
      .where(eq(accountDeletions.id, id));
    expect(await runDeletion(t, id)).toEqual({ outcome: "skipped" });
    t.clock.advance(15 * 60_000);
    await job.runScheduled(ACCOUNT_DELETION_JOB);
    expect(await deletionRow(t.db, id)).toMatchObject({ status: "completed", attempts: 2 });

    const raced = await createAlumni(t, { status: "verified" });
    const request = await requestDeletionViaApp(t, await signInAlumni(t, raced));
    const results = await Promise.all([runDeletion(t, request.id), runDeletion(t, request.id)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["completed", "skipped"]);
    expect(processor).toBeInstanceOf(AccountDeletionProcessor);
  });

  it("AC F14-2, AC F14-6, D2: worker yang macet melewati sewa saat mengirim email kehilangan klaimnya; worker pengambil alih menyelesaikan, worker lama tidak menimpa steps_done/ledger dan tidak mengirim email lagi", async () => {
    const rich = await createRichMember(t);
    const { id, requestNumber } = await requestDeletionViaApp(t, rich.session);
    const mailBefore = t.mailer.mail.length;
    const original = t.mailer.sendTransactional.bind(t.mailer);
    let takeover: DeletionRunResult | undefined;
    t.mailer.sendTransactional = async (mail) => {
      await original(mail);
      if (takeover) return;
      // Server SMTP menerima email worker A, lalu proses A macet melewati sewa 15 menit; sapuan (worker B)
      // mengambil alih klaim dan menyelesaikan penghapusan sebelum A berjalan lagi.
      t.clock.advance(16 * 60_000);
      takeover = { outcome: "skipped" };
      takeover = await runDeletion(t, id);
    };
    let stale: DeletionRunResult;
    try {
      stale = await runDeletion(t, id);
    } finally {
      t.mailer.sendTransactional = original;
    }
    expect(takeover).toEqual({ outcome: "completed", requestNumber });
    expect(stale).toEqual({ outcome: "claim_lost", requestNumber, step: "notify_requested" });

    const done = await expectFullyDeleted(t, rich, requestNumber);
    expect(done.attempts).toBe(2);
    const deletedKeys = [
      rich.files.avatar,
      rich.files.chatImage,
      rich.files.groupAvatar,
      rich.files.proofPaid,
      rich.files.proofOld,
      rich.files.proofReview,
      rich.files.adminProof,
      rich.files.proofTicket,
      rich.files.evidence,
    ]
      .map((file) => file.objectKey)
      .sort();
    expect((done.ledger as { object_keys: string[] }).object_keys).toEqual(deletedKeys);
    expect(readLedger(t.storage, ledgerObjectKey(requestNumber, done.requestedAt))).toMatchObject({
      state: "completed",
      object_keys: deletedKeys,
    });
    // Email: kiriman A yang sudah diterima SMTP, lalu email B; tidak ada email sesudah email selesai.
    expect(t.mailer.mail.slice(mailBefore).map((m) => m.subject)).toEqual([
      expect.stringContaining(requestNumber),
      expect.stringContaining(requestNumber),
      `Penghapusan akun KAPDH ${requestNumber} selesai`,
    ]);
    const completions = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "account.deletion_completed"), eq(auditLogs.entityId, id)));
    expect(completions).toHaveLength(1);
  });

  it("AC F14-2, AC F14-6: klaim hilang di antara langkah → eksekusi lama berhenti pada transaksi berikutnya tanpa efek; status gagal/selesai milik pemegang klaim baru tidak ditimpa", async () => {
    const rich = await createRichMember(t);
    const { id, requestNumber } = await requestDeletionViaApp(t, rich.session);
    const processor = t.app.get(AccountDeletionProcessor);
    let takeover: DeletionRunResult | undefined;
    processor.setStepObserver(async ({ step }) => {
      if (step !== "credentials" || takeover) return;
      takeover = { outcome: "skipped" };
      t.clock.advance(16 * 60_000);
      takeover = await runDeletion(t, id);
    });
    const stale = await runDeletion(t, id);
    expect(takeover).toEqual({ outcome: "completed", requestNumber });
    expect(stale).toEqual({ outcome: "claim_lost", requestNumber, step: "ledger_final" });
    const done = await expectFullyDeleted(t, rich, requestNumber);
    expect(done).toMatchObject({ status: "completed", attempts: 2, lastError: null });
  });

  it("AC F14-6: ledger eksternal ditulis monoton (completed tidak diturunkan, object key tidak hilang)", async () => {
    const storage = new MemoryDriver();
    const entry = {
      v: 1 as const,
      kind: "kapdh.account_deletion" as const,
      deletion_id: uuidv7(),
      request_number: "DEL-2026-ABCD1234",
      user_id: uuidv7(),
      source: "app" as const,
      requested_at: "2026-10-13T02:00:00.000Z",
      state: "completed" as const,
      completed_at: "2026-10-14T02:00:00.000Z",
      object_keys: ["avatar/2026/10/a", "payment_proof/2026/10/b"],
      written_at: "2026-10-14T02:00:00.000Z",
    };
    const key = await writeLedgerEntryMonotonic(storage, entry);
    await writeLedgerEntryMonotonic(storage, {
      ...entry,
      state: "requested",
      completed_at: null,
      object_keys: [],
    });
    expect(readLedger(storage, key)).toMatchObject({ state: "completed", object_keys: entry.object_keys });
    await writeLedgerEntryMonotonic(storage, { ...entry, object_keys: ["chat_image/2026/10/c"] });
    expect(readLedger(storage, key)).toMatchObject({
      state: "completed",
      object_keys: ["avatar/2026/10/a", "chat_image/2026/10/c", "payment_proof/2026/10/b"],
    });
  });
});

describe("Deletion ledger: penerapan ulang setelah restore (AC F14-6)", () => {
  it("AC F14-6: backup sebelum penghapusan dipulihkan → ledger diterapkan ulang sebelum layanan dibuka; data dan berkas yang sudah dihapus tidak muncul kembali, tanpa email ulang", async () => {
    const source = await createTestApp();
    let restored: TestApp | undefined;
    let ledgerDir: string | undefined;
    try {
      await ensureAuditPurgeRole(source.db);
      const rich = await createRichMember(source);
      // Backup harian (DB + berkas) dibuat SEBELUM permintaan penghapusan.
      const dbBackup = await source.pg.dumpDataDir("none");
      const fileBackup = snapshotStorage(source.storage);

      const { id, requestNumber } = await requestDeletionViaApp(source, rich.session);
      expect(await runDeletion(source, id)).toMatchObject({ outcome: "completed" });
      await expectFullyDeleted(source, rich, requestNumber);

      // Bencana: DB dan berkas dipulihkan dari backup; ledger terbaru diambil dari salinan di luar backup.
      ledgerDir = exportLedger(source.storage);
      restored = await appFromBackup(dbBackup, await restoreStorage(fileBackup), source.clock);
      expect((await userRow(restored.db, rich.member.userId))!.status).toBe("active");
      expect(await restored.storage.exists(rich.files.avatar.objectKey)).toBe(true);

      const entries = readLedgerDirectory(ledgerDir);
      expect(entries.map((e) => [e.request_number, e.state])).toEqual([[requestNumber, "completed"]]);
      const summary = await runAsSystem(() => restored!.app.get(DeletionLedgerService).reapply(entries));
      expect(summary).toMatchObject({
        entries: 1,
        reapplied: [requestNumber],
        failed: [],
        absent: [],
        alreadyDeleted: [],
      });
      await expectFullyDeleted(restored, rich, requestNumber);
      // Email penghapusan tidak dikirim ulang ke alamat yang dipulihkan.
      expect(restored.mailer.mail).toEqual([]);
      // Ledger di storage pulihan (berasal dari backup berkas lama) dilengkapi kembali.
      expect(
        readLedger(restored.storage, ledgerObjectKey(requestNumber, new Date(entries[0]!.requested_at))),
      ).toMatchObject({ request_number: requestNumber, state: "completed" });
      const [reapplied] = await restored.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "account.deletion_reapplied"));
      expect(reapplied).toMatchObject({ effectiveRole: "system", after: { request_number: requestNumber } });

      // Penerapan ulang idempoten: entri yang sama sekarang tercatat sudah terhapus.
      const again = await runAsSystem(() => restored!.app.get(DeletionLedgerService).reapply(entries));
      expect(again).toMatchObject({ reapplied: [], alreadyDeleted: [requestNumber], failed: [] });
    } finally {
      await restored?.app.close();
      await source.app.close();
      if (ledgerDir) rmSync(ledgerDir, { recursive: true, force: true });
    }
  });

  it("AC F14-6: permintaan yang belum selesai saat bencana (ledger requested) diselesaikan saat restore termasuk email selesai; akun yang tidak ada di backup dilewati; berkas ledger rusak ditolak", async () => {
    const source = await createTestApp();
    let restored: TestApp | undefined;
    let ledgerDir: string | undefined;
    try {
      await ensureAuditPurgeRole(source.db);
      const rich = await createRichMember(source);
      const dbBackup = await source.pg.dumpDataDir("none");
      const fileBackup = snapshotStorage(source.storage);
      const { id, requestNumber } = await requestDeletionViaApp(source, rich.session);
      // Job baru menulis entri `requested` dan email konfirmasi ketika layanan berhenti.
      source.app.get(AccountDeletionProcessor).setStepObserver(({ step }) => {
        if (step === "notify_requested") throw new Error("server mati");
      });
      expect(await runDeletion(source, id)).toMatchObject({ outcome: "failed" });
      // Akun yang mendaftar SETELAH backup lalu dihapus: tidak ada di database pulihan.
      const late = await createAlumni(source, { status: "verified" });
      source.app.get(AccountDeletionProcessor).setStepObserver(null);
      const lateRequest = await requestDeletionViaApp(source, await signInAlumni(source, late));
      expect(await runDeletion(source, lateRequest.id)).toMatchObject({ outcome: "completed" });

      ledgerDir = exportLedger(source.storage);
      restored = await appFromBackup(dbBackup, await restoreStorage(fileBackup), source.clock);
      const entries = readLedgerDirectory(ledgerDir);
      expect(Object.fromEntries(entries.map((e) => [e.request_number, e.state]))).toEqual({
        [requestNumber]: "requested",
        [lateRequest.requestNumber]: "completed",
      });
      const summary = await runAsSystem(() => restored!.app.get(DeletionLedgerService).reapply(entries));
      expect(summary).toMatchObject({
        reapplied: [requestNumber],
        absent: [lateRequest.requestNumber],
        failed: [],
      });
      await expectFullyDeleted(restored, rich, requestNumber);
      const lateEntry = entries.find((e) => e.request_number === lateRequest.requestNumber)!;
      expect(
        readLedger(
          restored.storage,
          ledgerObjectKey(lateEntry.request_number, new Date(lateEntry.requested_at)),
        ),
      ).toMatchObject({ state: "completed", user_id: late.userId });
      // Email konfirmasi sudah terkirim sebelum bencana; email selesai dikirim sekarang.
      expect(restored.mailer.mail.map((m) => m.subject)).toEqual([
        `Penghapusan akun KAPDH ${requestNumber} selesai`,
      ]);
      const [row] = await restored.db.select().from(accountDeletions).where(eq(accountDeletions.id, id));
      expect(row).toMatchObject({ requestNumber, status: "completed" });
      expect(row!.ledger).toMatchObject({ restored: true });
      expect(readLedger(restored.storage, ledgerObjectKey(requestNumber, row!.requestedAt))).toMatchObject({
        state: "completed",
      });

      writeFileSync(join(ledgerDir, "rusak.json"), JSON.stringify({ kind: "lain" }));
      expect(() => readLedgerDirectory(ledgerDir!)).toThrow();
    } finally {
      await restored?.app.close();
      await source.app.close();
      if (ledgerDir) rmSync(ledgerDir, { recursive: true, force: true });
    }
  });
});

describe("Deletion ledger luar VPS (AC F14-6, D5-07)", () => {
  it("AC F14-6, D5-07: VPS hilang (DB dan /data/files dari backup harian sebelum penghapusan, ledger lokal ikut hilang) → ledger luar VPS append-only tetap menerapkan ulang penghapusan sebelum layanan dibuka", async () => {
    const source = await createTestApp();
    const offsite = new MemoryDriver();
    source.app.get(OffsiteDeletionLedger).useDriver(offsite);
    let restored: TestApp | undefined;
    let ledgerDir: string | undefined;
    try {
      await ensureAuditPurgeRole(source.db);
      const rich = await createRichMember(source);
      // Backup harian terakhir (DB + berkas) dibuat SEBELUM permintaan penghapusan.
      const dbBackup = await source.pg.dumpDataDir("none");
      const fileBackup = snapshotStorage(source.storage);

      const { id, requestNumber } = await requestDeletionViaApp(source, rich.session);
      expect(await runDeletion(source, id)).toEqual({ outcome: "completed", requestNumber });
      await expectFullyDeleted(source, rich, requestNumber);

      // Store luar VPS: satu objek BARU per penulisan (requested lalu completed), tidak ada yang ditimpa; isinya
      // hanya id dan object key.
      const keys = offsite.keys();
      expect(keys).toHaveLength(2);
      for (const key of keys)
        expect(key).toMatch(
          new RegExp(
            `^account-deletions/2026/10/${requestNumber.toLowerCase()}/(requested|completed)-[0-9a-f-]{36}\\.json$`,
          ),
        );
      expect(keys.map((key) => readLedger(offsite, key).state).sort()).toEqual(["completed", "requested"]);
      const raw = keys.map((key) => offsite.contents(key)!.toString("utf8")).join("");
      for (const term of personalTerms(rich)) expect(raw).not.toContain(term);

      // Bencana: VPS hilang. Database dan seluruh /data/files (termasuk ledger/account-deletions) hanya tersedia dari
      // backup harian terakhir, yang belum memuat entri ledger permintaan ini.
      expect([...fileBackup.keys()].some((key) => key.startsWith("ledger/"))).toBe(false);
      restored = await appFromBackup(dbBackup, await restoreStorage(fileBackup), source.clock);
      expect((await userRow(restored.db, rich.member.userId))!.status).toBe("active");
      expect(await restored.storage.exists(rich.files.avatar.objectKey)).toBe(true);

      // Runbook restore: salinan bucket ledger luar VPS (rclone copy) diberikan ke CLI ledger-reapply.
      ledgerDir = exportOffsiteLedger(offsite);
      const entries = readLedgerDirectory(ledgerDir);
      expect(entries).toEqual([
        expect.objectContaining({ deletion_id: id, request_number: requestNumber, state: "completed" }),
      ]);
      expect(entries[0]!.object_keys).toEqual(
        expect.arrayContaining([rich.files.avatar.objectKey, rich.files.proofOld.objectKey]),
      );
      const summary = await runAsSystem(() => restored!.app.get(DeletionLedgerService).reapply(entries));
      expect(summary).toMatchObject({ entries: 1, reapplied: [requestNumber], failed: [], absent: [] });
      await expectFullyDeleted(restored, rich, requestNumber);
      expect(await restored.storage.exists(rich.files.avatar.objectKey)).toBe(false);
      expect(restored.mailer.mail).toEqual([]);
    } finally {
      await restored?.app.close();
      await source.app.close();
      if (ledgerDir) rmSync(ledgerDir, { recursive: true, force: true });
    }
  });

  it("D5-07: penulisan ke ledger luar VPS gagal → langkah ledger gagal sebelum data dihapus (tidak dicatat selesai), dicoba ulang dengan backoff lalu selesai; last_error aman", async () => {
    const offsite = new MemoryDriver();
    const ledger = t.app.get(OffsiteDeletionLedger);
    ledger.useDriver(offsite);
    try {
      const rich = await createRichMember(t);
      const { id, requestNumber } = await requestDeletionViaApp(t, rich.session);

      // ledger_open: store luar VPS menolak → tidak ada langkah selesai, tidak ada data yang dihapus, salinan lokal
      // juga belum ditulis (urutan: luar VPS dahulu).
      offsite.failNext("put", 1);
      expect(await runDeletion(t, id)).toEqual({ outcome: "failed", requestNumber, step: "ledger_open" });
      const failed = await deletionRow(t.db, id);
      expect(failed).toMatchObject({ status: "failed", stepsDone: [] });
      expect(failed.lastError).toBe("ledger_open:OffsiteLedgerWriteError");
      expect(await t.storage.exists(ledgerObjectKey(requestNumber, failed.requestedAt))).toBe(false);
      expect(await t.storage.exists(rich.files.avatar.objectKey)).toBe(true);
      expect((await userRow(t.db, rich.member.userId))!.status).toBe("deletion_pending");
      expect(offsite.keys()).toEqual([]);

      // ledger_final: gagal setelah data dihapus → permintaan tidak selesai sampai entri completed ada di luar VPS.
      t.clock.advance(deletionRetryBackoffMs(1));
      t.app.get(AccountDeletionProcessor).setStepObserver(({ step }) => {
        if (step === "credentials") offsite.failNext("put", 1);
      });
      expect(await runDeletion(t, id)).toEqual({ outcome: "failed", requestNumber, step: "ledger_final" });
      t.app.get(AccountDeletionProcessor).setStepObserver(null);
      expect((await deletionRow(t.db, id)).stepsDone).not.toContain("ledger_final");

      t.clock.advance(deletionRetryBackoffMs(2));
      expect(await runDeletion(t, id)).toEqual({ outcome: "completed", requestNumber });
      await expectFullyDeleted(t, rich, requestNumber);
      expect(
        offsite
          .keys()
          .map((key) => readLedger(offsite, key).state)
          .sort(),
      ).toEqual(["completed", "requested"]);
    } finally {
      ledger.useDriver(null);
    }
  });
});

describe("Redaksi snapshot (D2, AC F14-4)", () => {
  it("AC F14-4: snapshot audit hanya mempertahankan angka, waktu, Money, UUID rujukan dan kode; UUID akun dan teks bebas dibuang", () => {
    const userId = uuidv7();
    const other = uuidv7();
    expect(
      redactAuditSnapshot(
        {
          status: "paid",
          amount: "60000.00",
          phone: "081234567890",
          full_name: "Budi",
          user_id: userId,
          payment_id: other,
          version: 3,
          at: "2026-10-13T02:00:00.000Z",
          lines: [{ code: "registration", amount: "50000.00", label: "Biaya pendaftaran Budi" }],
          request_number: "DEL-2026-ABCD1234",
        },
        userId,
      ),
    ).toEqual({
      status: "paid",
      amount: "60000.00",
      user_id: null,
      payment_id: other,
      version: 3,
      at: "2026-10-13T02:00:00.000Z",
      lines: [{ amount: "50000.00" }],
      request_number: "DEL-2026-ABCD1234",
    });
  });

  it("AC F14-4: angka identitas (angkatan, kelas, nomor urut) pada snapshot koreksi identitas dibuang; hitungan, versi dan nominal tetap", () => {
    const userId = uuidv7();
    // Snapshot member.identity_corrected / member.number_corrected dari MembershipKernel (core).
    expect(
      redactAuditSnapshot(
        { cohort: 12, class_in: 1, class_out: 6, gender: "male", member_number: "12.1.L.5", member_seq: 5 },
        userId,
      ),
    ).toEqual({});
    expect(
      redactAuditSnapshot(
        {
          version: 4,
          proof_version: 2,
          member_count: 3,
          held_quantity: 1,
          self_cancel_days: 3,
          attempts: 2,
          birth_year: 1990,
          amount: 50000,
          flags: [1, 2],
        },
        userId,
      ),
    ).toEqual({
      version: 4,
      proof_version: 2,
      member_count: 3,
      held_quantity: 1,
      self_cancel_days: 3,
      attempts: 2,
      amount: 50000,
      flags: [],
    });
  });

  it("D2: bukti moderasi membersihkan objek milik akun dan rujukan berkas yang dihapus tanpa mengubah data pihak lain", () => {
    const userId = uuidv7();
    const peer = uuidv7();
    const fileId = uuidv7();
    expect(
      scrubEvidence(
        {
          messages: [
            {
              sender_user_id: userId,
              sender_name: "Budi",
              body: "isi",
              image: { file_id: fileId, url: "x" },
            },
            { sender_user_id: peer, sender_name: "Ahmad", body: "balas", image: null },
          ],
          profile: { full_name: "Budi", bio: "bio" },
        },
        { userId, deletedFileIds: new Set([fileId]), subjectIsUser: true },
      ),
    ).toEqual({
      messages: [
        { sender_user_id: null, sender_name: null, body: null, image: { file_id: null, url: null } },
        { sender_user_id: peer, sender_name: "Ahmad", body: "balas", image: null },
      ],
      profile: { full_name: null, bio: null },
    });
  });
});
