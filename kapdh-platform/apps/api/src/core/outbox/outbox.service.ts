import { Inject, Injectable } from "@nestjs/common";
import { outboxEvents } from "@kapdh/database";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../adapters/clock.js";
import { tryCtx } from "../context/request-context.js";
import type { DbOrTx } from "../db/types.js";
import { CLOCK } from "../tokens.js";
import { OUTBOX_TOPICS, type OutboxPayload, type OutboxTopic } from "./topics.js";

export interface OutboxMessage<T extends OutboxTopic> {
  topic: T;
  /**
   * Kunci dedup global (outbox_events_dedup_key_key): event yang sama tidak pernah diproses dua kali walau
   * transaksi/job diulang, mis. `notification.created:<notification_id>`.
   */
  dedupKey: string;
  payload: OutboxPayload<T>;
  /** Penundaan pemrosesan pertama (bawaan segera). */
  availableAt?: Date;
}

/**
 * Outbox durable (PRD 5.1, ARCHITECTURE §4.2): ditulis dalam transaksi bisnis yang sama sehingga event tidak hilang
 * bila Redis/worker mati setelah commit (AC F04-1). request_id dari konteks menghubungkan log worker (N-14).
 */
@Injectable()
export class OutboxService {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  /**
   * Menyisipkan event; mengembalikan id baru, atau null bila dedupKey sudah pernah dipublikasikan (idempoten).
   * Payload divalidasi skema topik sehingga data di luar katalog tidak pernah tersimpan.
   */
  async publish<T extends OutboxTopic>(tx: DbOrTx, message: OutboxMessage<T>): Promise<string | null> {
    const payload = OUTBOX_TOPICS[message.topic].parse(message.payload);
    if (message.dedupKey.length === 0 || message.dedupKey.length > 255)
      throw new Error("dedupKey outbox wajib 1..255 karakter");
    const id = uuidv7();
    const now = this.clock.now();
    const inserted = await tx
      .insert(outboxEvents)
      .values({
        id,
        topic: message.topic,
        dedupKey: message.dedupKey,
        payload,
        status: "pending",
        attempts: 0,
        nextAttemptAt: message.availableAt ?? now,
        requestId: tryCtx()?.requestId ?? null,
        createdAt: now,
      })
      .onConflictDoNothing({ target: outboxEvents.dedupKey })
      .returning({ id: outboxEvents.id });
    return inserted[0]?.id ?? null;
  }
}
