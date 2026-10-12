import { useCallback, useEffect, useRef, useState } from "react";

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/** Kunci penyimpanan waktu aktivitas terakhir (hanya angka epoch ms) agar beberapa tab admin selaras. */
export const ACTIVITY_STORAGE_KEY = "kapdh_admin_last_activity";
const SHARE_THROTTLE_MS = 10_000;

function readShared(): number {
  try {
    const v = Number(window.localStorage.getItem(ACTIVITY_STORAGE_KEY));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function writeShared(at: number): void {
  try {
    window.localStorage.setItem(ACTIVITY_STORAGE_KEY, String(at));
  } catch {
    // Penyimpanan diblokir (mode privat): setiap tab menghitung sendiri.
  }
}

export interface IdleTimeoutOptions {
  timeoutMs: number;
  warnBeforeMs: number;
  /** Dipanggil TEPAT SEKALI saat batas idle tercapai (sampai admin aktif lagi atau hook dinonaktifkan). */
  onTimeout: () => void;
  enabled: boolean;
  /**
   * Detak aktivitas: bila admin aktif di halaman (mengetik/mengklik) tetapi tidak ada permintaan non-latar ke
   * server selama `heartbeatMs`, panggil `onHeartbeat` (mis. GET /admin/me tanpa header latar) agar idle server
   * tidak berakhir saat admin sedang mengisi formulir panjang (AC F02-5).
   */
  onHeartbeat?: () => void;
  heartbeatMs?: number;
  /** Waktu (epoch ms) permintaan non-latar terakhir ke server. */
  lastServerActivity?: () => number;
}

/**
 * Peringatan 2 menit sebelum idle timeout admin 30 menit (AC F02-5, N-08).
 * - Hanya interaksi pengguna yang dihitung; polling latar tidak memperpanjang sesi.
 * - Aktivitas dibagi antartab lewat localStorage (hanya stempel waktu) sehingga tab yang tidak dipakai tidak
 *   mengeluarkan admin yang sedang bekerja di tab lain (logout mencabut sesi bersama).
 * - Server tetap sumber kebenaran: permintaan setelah idle server akan ditolak walau klien belum logout.
 */
export function useIdleTimeout({
  timeoutMs,
  warnBeforeMs,
  onTimeout,
  enabled,
  onHeartbeat,
  heartbeatMs = 5 * 60_000,
  lastServerActivity,
}: IdleTimeoutOptions) {
  const lastActivity = useRef(Date.now());
  /** Interaksi nyata terakhir (bukan waktu mount) untuk detak aktivitas. */
  const lastInput = useRef(0);
  const lastShared = useRef(0);
  const lastHeartbeat = useRef(0);
  const fired = useRef(false);
  const [remainingMs, setRemainingMs] = useState(timeoutMs);
  const callbacks = useRef({ onTimeout, onHeartbeat, lastServerActivity });
  callbacks.current = { onTimeout, onHeartbeat, lastServerActivity };

  const markActive = useCallback(() => {
    const now = Date.now();
    lastActivity.current = now;
    fired.current = false;
    lastShared.current = now;
    writeShared(now);
    setRemainingMs(timeoutMs);
  }, [timeoutMs]);

  useEffect(() => {
    if (!enabled) return;
    const start = Date.now();
    lastActivity.current = start;
    fired.current = false;
    lastShared.current = start;
    writeShared(start);

    const onActivity = () => {
      const now = Date.now();
      // Saat peringatan tampil, hanya tombol "Tetap masuk" yang memperpanjang agar admin sadar.
      if (now - lastActivity.current >= timeoutMs - warnBeforeMs) return;
      lastActivity.current = now;
      lastInput.current = now;
      if (now - lastShared.current >= SHARE_THROTTLE_MS) {
        lastShared.current = now;
        writeShared(now);
      }
    };
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));

    const timer = window.setInterval(() => {
      const now = Date.now();
      const shared = readShared();
      if (shared > lastActivity.current) lastActivity.current = shared;
      const left = timeoutMs - (now - lastActivity.current);
      setRemainingMs(Math.max(0, left));
      if (left <= 0) {
        if (!fired.current) {
          fired.current = true;
          callbacks.current.onTimeout();
        }
        return;
      }
      const { onHeartbeat: beat, lastServerActivity: lastServer } = callbacks.current;
      if (!beat) return;
      const recentlyActive = now - lastInput.current < 60_000;
      const serverQuiet = now - Math.max(lastServer?.() ?? 0, lastHeartbeat.current) >= heartbeatMs;
      if (recentlyActive && serverQuiet && left > warnBeforeMs) {
        lastHeartbeat.current = now;
        beat();
      }
    }, 1000);

    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
      window.clearInterval(timer);
    };
  }, [enabled, timeoutMs, warnBeforeMs, heartbeatMs]);

  return {
    remainingMs,
    warning: enabled && remainingMs > 0 && remainingMs <= warnBeforeMs,
    stayActive: markActive,
  };
}
