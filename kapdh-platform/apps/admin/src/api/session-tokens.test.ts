import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChannelLike,
  classifyRefreshFailure,
  type LockManagerLike,
  type RefreshResult,
  SessionTokens,
} from "./session-tokens";

/**
 * Server tiruan yang meniru rotasi refresh token API (apps/api auth.service.ts, AC F02-3): setiap refresh membuat
 * sesi baru dan mencabut sesi lama; access token sesi yang dicabut ditolak; cookie lama yang dipakai lagi
 * (reuse) mencabut SELURUH keluarga sesi. Cookie dibagi semua tab seperti cookie HttpOnly peramban.
 */
class RotatingServer {
  private seq = 1;
  /** Cookie peramban (dibagi antartab). */
  cookie = "s1";
  readonly revoked = new Set<string>();
  readonly replaced = new Set<string>();
  familyRevoked = false;
  rotations = 0;
  concurrent = 0;
  maxConcurrent = 0;
  calls = 0;

  constructor(private readonly latencyMs = 20) {}

  tokenFor(session: string): string {
    return `at-${session}`;
  }

  accepts(token: string | null): boolean {
    if (!token || this.familyRevoked) return false;
    const session = token.replace(/^at-/, "");
    return !this.revoked.has(session);
  }

  async refresh(): Promise<RefreshResult> {
    this.calls += 1;
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    const presented = this.cookie;
    await new Promise((r) => setTimeout(r, this.latencyMs));
    this.concurrent -= 1;
    if (this.familyRevoked) return { kind: "rejected", status: 401 };
    if (this.replaced.has(presented)) {
      // Reuse terdeteksi: seluruh keluarga sesi dicabut.
      this.familyRevoked = true;
      return { kind: "rejected", status: 401 };
    }
    this.seq += 1;
    const next = `s${this.seq}`;
    this.replaced.add(presented);
    this.revoked.add(presented);
    this.cookie = next;
    this.rotations += 1;
    return {
      kind: "ok",
      pair: {
        access_token: this.tokenFor(next),
        access_expires_at: new Date(Date.now() + 15 * 60_000 + this.seq).toISOString(),
      },
    };
  }
}

/** Web Locks tiruan: satu pemegang per nama, antrean FIFO (seperti navigator.locks dalam satu origin). */
class FakeLocks implements LockManagerLike {
  private tails = new Map<string, Promise<unknown>>();
  request<T>(name: string, callback: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(name) ?? Promise.resolve();
    const run = prev.then(callback, callback);
    this.tails.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  }
}

/** BroadcastChannel tiruan: pesan dikirim asinkron ke semua anggota lain. */
class FakeHub {
  private members: { listener: ((e: MessageEvent) => void) | null }[] = [];
  join(): ChannelLike {
    const member = { listener: null as ((e: MessageEvent) => void) | null };
    this.members.push(member);
    return {
      postMessage: (message) => {
        for (const other of this.members) {
          if (other === member) continue;
          queueMicrotask(() => other.listener?.({ data: message } as MessageEvent));
        }
      },
      addEventListener: (_type, listener) => {
        member.listener = listener;
      },
    };
  }
}

function tab(server: RotatingServer, locks: LockManagerLike | null, hub: FakeHub | null) {
  return new SessionTokens({
    requestRefresh: () => server.refresh(),
    locks,
    channel: hub?.join() ?? null,
    leewayMs: 60_000,
    retryDelaysMs: [1_000],
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("klasifikasi hasil refresh", () => {
  it("4xx pasti = ditolak; 408/429/5xx = belum diketahui", () => {
    expect(classifyRefreshFailure(401).kind).toBe("rejected");
    expect(classifyRefreshFailure(403).kind).toBe("rejected");
    expect(classifyRefreshFailure(408).kind).toBe("unavailable");
    expect(classifyRefreshFailure(429).kind).toBe("unavailable");
    expect(classifyRefreshFailure(502).kind).toBe("unavailable");
    expect(classifyRefreshFailure(503).kind).toBe("unavailable");
  });
});

describe("koordinasi rotasi refresh antartab (N-08, AC F02-3, AC F02-5)", () => {
  it("dua tab memperbarui bersamaan: penukaran diserialkan, tidak ada reuse, kedua tab memegang token yang berlaku", async () => {
    const server = new RotatingServer();
    const locks = new FakeLocks();
    const hub = new FakeHub();
    const a = tab(server, locks, hub);
    const b = tab(server, locks, hub);
    const initial = server.tokenFor("s1");
    a.start(initial, new Date(Date.now() + 30_000).toISOString());
    b.start(initial, new Date(Date.now() + 30_000).toISOString());
    a.setOwner("admin-1");
    b.setOwner("admin-1");

    const [ra, rb] = await Promise.all([a.refresh(), b.refresh()]);
    expect(ra.kind).toBe("ok");
    expect(rb.kind).toBe("ok");
    expect(server.maxConcurrent).toBe(1);
    expect(server.familyRevoked).toBe(false);
    // Tab kedua memakai token yang disiarkan tab pertama alih-alih memutar sesi lagi.
    expect(server.rotations).toBe(1);
    expect(a.accessToken).toBe(b.accessToken);
    expect(server.accepts(a.accessToken)).toBe(true);
    expect(server.accepts(b.accessToken)).toBe(true);
  });

  it("tab lain memutar sesi: token baru diadopsi lewat kanal sehingga tab ini tidak mendapat 401", async () => {
    const server = new RotatingServer();
    const locks = new FakeLocks();
    const hub = new FakeHub();
    const a = tab(server, locks, hub);
    const b = tab(server, locks, hub);
    a.start(server.tokenFor("s1"), new Date(Date.now() + 30_000).toISOString());
    b.start(server.tokenFor("s1"), new Date(Date.now() + 30_000).toISOString());

    await a.refresh();
    await Promise.resolve();
    expect(b.accessToken).toBe(a.accessToken);
    expect(server.accepts(b.accessToken)).toBe(true);
  });

  it("tanpa kanal: tab yang tokennya dicabut rotasi tab lain menukar SETELAH kunci dilepas (tanpa reuse)", async () => {
    const server = new RotatingServer();
    const locks = new FakeLocks();
    const a = tab(server, locks, null);
    const b = tab(server, locks, null);
    a.start(server.tokenFor("s1"), new Date(Date.now() + 30_000).toISOString());
    b.start(server.tokenFor("s1"), new Date(Date.now() + 30_000).toISOString());

    const stale = b.accessToken;
    await a.refresh();
    expect(server.accepts(stale)).toBe(false);
    // Permintaan tab B ditolak 401 → refresh dengan token basi sebagai acuan.
    const result = await b.refresh(stale);
    expect(result.kind).toBe("ok");
    expect(server.familyRevoked).toBe(false);
    expect(server.accepts(b.accessToken)).toBe(true);
  });

  it("401 dengan token lama padahal tab sudah memegang token baru: dipakai langsung tanpa rotasi", async () => {
    const server = new RotatingServer();
    const a = tab(server, new FakeLocks(), null);
    a.start(server.tokenFor("s1"), new Date(Date.now() + 30_000).toISOString());
    const old = a.accessToken;
    await a.refresh();
    const rotations = server.rotations;
    const result = await a.refresh(old);
    expect(result.kind).toBe("ok");
    expect(server.rotations).toBe(rotations);
  });

  it("kontrol: tanpa kunci antartab, dua tab yang menukar bersamaan memicu deteksi reuse", async () => {
    const server = new RotatingServer();
    const a = tab(server, null, null);
    const b = tab(server, null, null);
    a.start(server.tokenFor("s1"), new Date(Date.now() + 30_000).toISOString());
    b.start(server.tokenFor("s1"), new Date(Date.now() + 30_000).toISOString());
    // Cookie yang sama dikirim dua kali sebelum rotasi pertama selesai: server mencabut seluruh keluarga sesi.
    const results = await Promise.all([a.refresh(), b.refresh()]);
    expect(server.maxConcurrent).toBe(2);
    expect(results.map((r) => r.kind).sort()).toEqual(["ok", "rejected"]);
    expect(server.familyRevoked).toBe(true);
  });

  it("logout di satu tab mengakhiri sesi tab lain yang sama pemiliknya", async () => {
    const server = new RotatingServer();
    const hub = new FakeHub();
    const a = tab(server, new FakeLocks(), hub);
    const b = tab(server, new FakeLocks(), hub);
    const other = tab(server, new FakeLocks(), hub);
    const ended = vi.fn();
    const otherEnded = vi.fn();
    b.onLoggedOutElsewhere(ended);
    other.onLoggedOutElsewhere(otherEnded);
    for (const t of [a, b, other]) t.start(server.tokenFor("s1"));
    a.setOwner("admin-1");
    b.setOwner("admin-1");
    other.setOwner("admin-2");

    const handoff = a.beginLogout("idle");
    expect(handoff.token).toBe(server.tokenFor("s1"));
    expect(a.accessToken).toBeNull();
    await Promise.resolve();
    expect(ended).toHaveBeenCalledWith("idle");
    expect(b.accessToken).toBeNull();
    // Sesi admin lain di peramban yang sama tidak terpengaruh.
    expect(otherEnded).not.toHaveBeenCalled();
    expect(other.accessToken).not.toBeNull();
  });
});

describe("penukaran yang tidak terjangkau (PRD 4.5)", () => {
  it("unavailable: token dipertahankan, dicoba lagi dengan backoff; ditolak: onExpired dipanggil sekali", async () => {
    vi.useFakeTimers();
    const results: RefreshResult[] = [
      { kind: "unavailable" },
      { kind: "unavailable", status: 503 },
      {
        kind: "ok",
        pair: { access_token: "baru", access_expires_at: new Date(Date.now() + 15 * 60_000).toISOString() },
      },
    ];
    const requestRefresh = vi.fn(async () => results.shift() ?? { kind: "rejected" as const, status: 401 });
    const tokens = new SessionTokens({ requestRefresh, retryDelaysMs: [1_000, 2_000] });
    const expired = vi.fn();
    tokens.onExpired(expired);
    tokens.start("lama", new Date(Date.now() + 61_000).toISOString());

    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestRefresh).toHaveBeenCalledTimes(1);
    expect(tokens.accessToken).toBe("lama");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requestRefresh).toHaveBeenCalledTimes(2);
    expect(tokens.accessToken).toBe("lama");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(requestRefresh).toHaveBeenCalledTimes(3);
    expect(tokens.accessToken).toBe("baru");
    expect(expired).not.toHaveBeenCalled();

    // Terjadwal berikutnya ditolak server: sesi berakhir.
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(expired).toHaveBeenCalledOnce();
    expect(tokens.accessToken).toBeNull();
  });

  it("kembali online menjalankan percobaan ulang yang tertunda sekarang", async () => {
    vi.useFakeTimers();
    const requestRefresh = vi
      .fn<() => Promise<RefreshResult>>()
      .mockResolvedValueOnce({ kind: "unavailable" })
      .mockResolvedValue({
        kind: "ok",
        pair: { access_token: "baru", access_expires_at: new Date(Date.now() + 15 * 60_000).toISOString() },
      });
    const tokens = new SessionTokens({ requestRefresh, retryDelaysMs: [60_000] });
    tokens.start("lama", new Date(Date.now() + 61_000).toISOString());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestRefresh).toHaveBeenCalledTimes(1);
    tokens.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(requestRefresh).toHaveBeenCalledTimes(2);
    expect(tokens.accessToken).toBe("baru");
  });

  it("hasil penukaran yang selesai setelah logout diabaikan (tidak menghidupkan token lagi)", async () => {
    let release: (r: RefreshResult) => void = () => undefined;
    const tokens = new SessionTokens({
      requestRefresh: () => new Promise<RefreshResult>((r) => (release = r)),
    });
    tokens.start("lama");
    const pending = tokens.refresh("lama");
    tokens.beginLogout("manual");
    release({
      kind: "ok",
      pair: { access_token: "baru", access_expires_at: new Date(Date.now() + 60_000).toISOString() },
    });
    expect((await pending).kind).toBe("superseded");
    expect(tokens.accessToken).toBeNull();
  });
});
