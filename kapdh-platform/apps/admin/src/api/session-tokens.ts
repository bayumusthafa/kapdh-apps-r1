import type { components } from "@kapdh/contracts";

type TokenPair = components["schemas"]["TokenPair"];

/**
 * Hasil penukaran cookie refresh `kapdh_admin_rt` (POST /auth/refresh):
 * - `ok`: access token baru;
 * - `rejected`: server menjawab PASTI bahwa sesi tidak dapat dipakai lagi (4xx selain 408/429: sesi dicabut, idle
 *   30 menit, reuse terdeteksi, origin ditolak). Admin harus masuk lagi (N-08, AC F02-3);
 * - `unavailable`: hasil tidak diketahui (jaringan putus, batas waktu, 5xx dari proxy saat deploy, 429). Sesi
 *   DIPERTAHANKAN dan penukaran dicoba lagi berkala, karena jaringan putus tidak boleh mengeluarkan admin
 *   (PRD 4.5, AC F02-5);
 * - `superseded`: sesi lokal berganti (logout/login baru) selama penukaran berjalan; hasilnya diabaikan.
 */
export type RefreshResult =
  | { kind: "ok"; pair: TokenPair }
  | { kind: "rejected"; status: number }
  | { kind: "unavailable"; status?: number }
  | { kind: "superseded" };

/** Status HTTP penukaran yang gagal: 4xx pasti (selain 408/429) = sesi berakhir; sisanya belum diketahui. */
export function classifyRefreshFailure(status: number): RefreshResult {
  return status >= 400 && status < 500 && status !== 408 && status !== 429
    ? { kind: "rejected", status }
    : { kind: "unavailable", status };
}

/** Bagian Web Locks API yang dipakai (navigator.locks); diinjeksi agar dapat diuji. */
export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** Bagian BroadcastChannel yang dipakai; diinjeksi agar dapat diuji. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

/** Pesan antartab admin (asal yang sama saja). Hanya access token di memori yang dibagi, tidak pernah disimpan. */
export type TabMessage =
  | {
      type: "token";
      from: string;
      owner: string | null;
      access_token: string;
      access_expires_at: string;
    }
  | { type: "logout"; from: string; owner: string | null; reason: string };

function isTabMessage(value: unknown): value is TabMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.from !== "string") return false;
  if (v.type === "token")
    return typeof v.access_token === "string" && typeof v.access_expires_at === "string";
  return v.type === "logout" && typeof v.reason === "string";
}

/** Bekal untuk mencabut sesi server setelah sesi lokal diakhiri (lihat `beginLogout`). */
export interface LogoutHandoff {
  /** Access token yang masih segar saat logout dimulai; null bila sudah (hampir) habis. */
  token: string | null;
  loginSeq: number;
}

export interface SessionTokensOptions {
  /** POST /auth/refresh mentah lewat cookie HttpOnly; tidak mengubah state apa pun. */
  requestRefresh: () => Promise<RefreshResult>;
  /** Kunci antartab (navigator.locks). Tanpa ini penukaran hanya digabung di dalam satu tab. */
  locks?: LockManagerLike | null;
  /** Kanal antartab (BroadcastChannel) untuk membagi token baru dan logout. */
  channel?: ChannelLike | null;
  /** Token diperbarui sekian ms sebelum habis (bawaan 60 detik). */
  leewayMs?: number;
  /** Jeda percobaan ulang saat server tidak terjangkau (backoff, elemen terakhir dipakai seterusnya). */
  retryDelaysMs?: readonly number[];
}

export const REFRESH_LOCK_NAME = "kapdh-admin-refresh";
/** Token yang tersisa kurang dari ini dianggap tidak layak dipakai ulang (perlu ditukar). */
const MIN_FRESH_MS = 5_000;
const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;

function randomId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

/**
 * Pemegang access token admin di memori (PRD 5.2) beserta koordinasi rotasi refresh token (N-08, AC F02-3):
 * - Penukaran digabung di dalam tab (single-flight) DAN diserialkan antartab lewat Web Locks, sehingga dua tab
 *   tidak pernah menukar cookie yang sama bersamaan (server menganggapnya reuse dan mencabut seluruh keluarga
 *   sesi).
 * - Setiap rotasi mencabut sesi lama di server, jadi token baru disiarkan ke tab lain (BroadcastChannel). Tab lain
 *   memakainya alih-alih memutar sesi lagi, sehingga tab-tab tidak saling membatalkan token.
 * - Di dalam kunci, tab memeriksa dulu apakah tab lain baru saja memperbarui; bila ya, token itu dipakai tanpa
 *   permintaan ke server.
 * - Penukaran yang `unavailable` tidak mengakhiri sesi: token lama dipertahankan dan dicoba lagi dengan backoff
 *   (serta segera saat peramban kembali online).
 */
export class SessionTokens {
  readonly tabId = randomId();
  private token: string | null = null;
  private expiresAtIso = "";
  private expiresAtMs = 0;
  private owner: string | null = null;
  /** Naik setiap sesi lokal diakhiri atau dimulai; hasil penukaran dari generasi lama diabaikan. */
  private epoch = 0;
  /** Naik hanya saat login baru di tab ini (MFA); logout di latar tidak boleh menyentuh sesi baru. */
  private loginSeq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryPending = false;
  private retryAttempt = 0;
  private inflight: Promise<RefreshResult> | null = null;
  private expiredHandler: (() => void) | null = null;
  private loggedOutElsewhereHandler: ((reason: string) => void) | null = null;
  private readonly leewayMs: number;
  private readonly retryDelaysMs: readonly number[];

  constructor(private readonly opts: SessionTokensOptions) {
    this.leewayMs = opts.leewayMs ?? 60_000;
    this.retryDelaysMs = opts.retryDelaysMs?.length ? opts.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
    opts.channel?.addEventListener("message", (event) => this.onMessage(event.data));
  }

  get accessToken(): string | null {
    return this.token;
  }

  /** Access token ada dan tidak habis dalam `marginMs` (token tanpa waktu kedaluwarsa dianggap segar). */
  hasFresh(marginMs = this.leewayMs): boolean {
    if (!this.token) return false;
    return this.expiresAtMs === 0 || this.expiresAtMs - Date.now() > marginMs;
  }

  /** Dipanggil saat penukaran terjadwal DITOLAK server (sesi benar-benar berakhir). */
  onExpired(handler: (() => void) | null): void {
    this.expiredHandler = handler;
  }

  /** Dipanggil saat tab lain mengakhiri sesi yang sama (logout atau idle). */
  onLoggedOutElsewhere(handler: ((reason: string) => void) | null): void {
    this.loggedOutElsewhereHandler = handler;
  }

  /** Identitas pemilik sesi (admin_id) agar pesan dari sesi admin lain di peramban yang sama diabaikan. */
  setOwner(owner: string | null): void {
    this.owner = owner;
  }

  /** Sesi baru di tab ini (login MFA). */
  start(token: string, expiresAt?: string): void {
    this.epoch += 1;
    this.loginSeq += 1;
    this.retryAttempt = 0;
    this.apply(token, expiresAt);
  }

  /** Buang token dan semua penjadwalan; penukaran yang sedang berjalan menjadi `superseded`. */
  clear(): void {
    this.epoch += 1;
    this.token = null;
    this.expiresAtIso = "";
    this.expiresAtMs = 0;
    this.owner = null;
    this.retryAttempt = 0;
    this.cancelTimer();
  }

  /**
   * Logout di tab ini: token dibuang SEKARANG (UI langsung keluar) dan tab lain diberi tahu. Bekal yang
   * dikembalikan dipakai `revoke` untuk mencabut sesi server di latar.
   */
  beginLogout(reason: string): LogoutHandoff {
    const handoff: LogoutHandoff = {
      token: this.hasFresh(MIN_FRESH_MS) ? this.token : null,
      loginSeq: this.loginSeq,
    };
    const owner = this.owner;
    this.clear();
    this.post({ type: "logout", from: this.tabId, owner, reason });
    return handoff;
  }

  /** True bila belum ada login baru di tab ini sejak `handoff` dibuat. */
  isSameLogin(handoff: LogoutHandoff): boolean {
    return this.loginSeq === handoff.loginSeq && this.token === null;
  }

  /**
   * Perbarui access token. `staleToken` adalah token yang ditolak server atau hampir habis; bila tab ini sudah
   * memegang token lain yang segar (diperbarui permintaan serentak atau tab lain), token itu langsung dipakai.
   */
  refresh(staleToken: string | null = this.token): Promise<RefreshResult> {
    const adopted = this.adoptedPair(staleToken);
    if (adopted) return Promise.resolve({ kind: "ok", pair: adopted });
    this.inflight ??= this.runRefresh(staleToken).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * Penukaran untuk logout di latar: tetap diserialkan antartab, tetapi hasilnya TIDAK dipasang di tab ini dan
   * tidak disiarkan (sesi lokal sudah berakhir).
   */
  refreshDetached(): Promise<RefreshResult> {
    return this.locked(() => this.opts.requestRefresh());
  }

  /** Peramban kembali online: jalankan percobaan ulang yang tertunda sekarang. */
  retryNow(): void {
    if (!this.retryPending) return;
    this.cancelTimer();
    this.runScheduled();
  }

  private adoptedPair(staleToken: string | null): TokenPair | null {
    if (!this.token || this.token === staleToken || !this.hasFresh(MIN_FRESH_MS)) return null;
    return { access_token: this.token, access_expires_at: this.expiresAtIso };
  }

  private async runRefresh(staleToken: string | null): Promise<RefreshResult> {
    const epoch = this.epoch;
    const result = await this.locked(async (): Promise<RefreshResult> => {
      // Di dalam kunci: tab lain mungkin baru saja memutar sesi dan menyiarkan token barunya.
      const adopted = this.epoch === epoch ? this.adoptedPair(staleToken) : null;
      if (adopted) return { kind: "ok", pair: adopted };
      const r = await this.opts.requestRefresh();
      // Disiarkan sebelum kunci dilepas agar tab berikutnya yang mendapat kunci sudah memegang token ini.
      if (r.kind === "ok" && this.epoch === epoch)
        this.post({ type: "token", from: this.tabId, owner: this.owner, ...r.pair });
      return r;
    });
    if (this.epoch !== epoch) return { kind: "superseded" };
    if (result.kind === "ok") {
      this.retryAttempt = 0;
      if (result.pair.access_token !== this.token)
        this.apply(result.pair.access_token, result.pair.access_expires_at);
    } else if (result.kind === "rejected") {
      this.clear();
    } else if (result.kind === "unavailable") {
      this.scheduleRetry();
    }
    return result;
  }

  private async locked<T>(task: () => Promise<T>): Promise<T> {
    const locks = this.opts.locks;
    if (!locks) return task();
    let ran = false;
    try {
      return await locks.request(REFRESH_LOCK_NAME, () => {
        ran = true;
        return task();
      });
    } catch (e) {
      // Web Locks tidak tersedia (mis. konteks tidak aman): tetap jalan dengan penggabungan di dalam tab.
      if (ran) throw e;
      return task();
    }
  }

  private apply(token: string, expiresAt?: string): void {
    this.token = token;
    this.expiresAtIso = expiresAt ?? "";
    this.expiresAtMs = expiresAt ? Date.parse(expiresAt) : 0;
    this.cancelTimer();
    if (expiresAt) {
      const delay = Math.max(MIN_FRESH_MS, this.expiresAtMs - Date.now() - this.leewayMs);
      this.timer = setTimeout(() => this.runScheduled(), delay);
    }
  }

  private runScheduled(): void {
    this.timer = null;
    this.retryPending = false;
    void this.refresh(this.token).then((r) => {
      if (r.kind === "rejected") this.expiredHandler?.();
    });
  }

  private scheduleRetry(): void {
    if (this.token === null) return;
    const delays = this.retryDelaysMs;
    const delay = delays[Math.min(this.retryAttempt, delays.length - 1)] ?? 60_000;
    this.retryAttempt += 1;
    this.cancelTimer();
    this.retryPending = true;
    this.timer = setTimeout(() => this.runScheduled(), delay);
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.retryPending = false;
  }

  private post(message: TabMessage): void {
    try {
      this.opts.channel?.postMessage(message);
    } catch {
      // Kanal ditutup: tab lain akan memperbarui sendiri saat token mereka ditolak.
    }
  }

  private onMessage(data: unknown): void {
    if (!isTabMessage(data) || data.from === this.tabId || this.token === null) return;
    // Sesi admin lain di peramban yang sama (cookie sudah berganti) tidak memengaruhi tab ini.
    if (data.owner && this.owner && data.owner !== this.owner) return;
    if (data.type === "logout") {
      this.clear();
      this.loggedOutElsewhereHandler?.(data.reason);
      return;
    }
    if (data.access_token === this.token) return;
    const incoming = Date.parse(data.access_expires_at);
    // Pesan yang terlambat (token lebih lama dari milik tab ini) diabaikan.
    if (this.expiresAtMs !== 0 && !(incoming > this.expiresAtMs)) return;
    this.retryAttempt = 0;
    this.apply(data.access_token, data.access_expires_at);
  }
}
