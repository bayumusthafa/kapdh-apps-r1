import type { Clock } from "../../src/core/adapters/clock.js";
import type { PushMessage, PushResult, PushSender } from "../../src/core/adapters/push.js";

/** Jam yang bisa dimajukan untuk menguji kedaluwarsa, idle timeout, dan periode (ARCHITECTURE §9.1). */
export class TestClock implements Clock {
  constructor(private current = new Date("2026-10-13T02:00:00Z")) {}
  now() {
    return new Date(this.current);
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(at: Date) {
    this.current = new Date(at);
  }
}

/**
 * Pengirim push palsu (F-13): mencatat pesan; hasil per token dapat diatur untuk menguji kelas galat FCM
 * (unregistered → token dinonaktifkan, unavailable → retry).
 */
export class FakePush implements PushSender {
  enabled = true;
  readonly sent: PushMessage[] = [];
  private readonly outcomes = new Map<string, PushResult[]>();
  private counter = 0;

  /** Hasil berikutnya untuk token tertentu (antrean; setelah habis kembali sukses). */
  failNext(token: string, result: Exclude<PushResult, { ok: true }>): void {
    const queue = this.outcomes.get(token) ?? [];
    queue.push(result);
    this.outcomes.set(token, queue);
  }

  async send(message: PushMessage): Promise<PushResult> {
    this.sent.push(structuredClone(message));
    const queued = this.outcomes.get(message.token)?.shift();
    if (queued) return queued;
    return { ok: true, messageId: `projects/uji/messages/${++this.counter}` };
  }

  /** Pesan untuk token tertentu. */
  to(token: string): PushMessage[] {
    return this.sent.filter((m) => m.token === token);
  }

  clear(): void {
    this.sent.length = 0;
    this.outcomes.clear();
  }
}
