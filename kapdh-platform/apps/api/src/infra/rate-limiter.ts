/**
 * Pembatas laju sederhana di memori. Cukup untuk satu instance API; saat API lebih dari satu replica,
 * implementasi ini diganti versi Redis dengan antarmuka yang sama (PRD 5.1).
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  /** Mengembalikan detik tunggu bila batas terlampaui, atau 0 bila boleh. */
  check(key: string, limit: number, windowMs: number, now: number): number {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    this.hits.set(key, list);
    if (list.length < limit) return 0;
    return Math.ceil((windowMs - (now - list[0]!)) / 1000);
  }

  hit(key: string, now: number): void {
    const list = this.hits.get(key) ?? [];
    list.push(now);
    this.hits.set(key, list);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
