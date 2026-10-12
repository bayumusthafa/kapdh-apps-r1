import { useCallback, useEffect, useRef, useState } from "react";

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/**
 * Peringatan 2 menit sebelum idle timeout admin 30 menit (AC F02-5).
 * Hanya interaksi pengguna yang dihitung; polling latar tidak memperpanjang sesi.
 * Server tetap sumber kebenaran: request setelah idle akan ditolak walau klien belum logout.
 */
export function useIdleTimeout(opts: {
  timeoutMs: number;
  warnBeforeMs: number;
  onTimeout: () => void;
  enabled: boolean;
}) {
  const { timeoutMs, warnBeforeMs, onTimeout, enabled } = opts;
  const lastActivity = useRef(Date.now());
  const [remainingMs, setRemainingMs] = useState(timeoutMs);

  const markActive = useCallback(() => {
    lastActivity.current = Date.now();
    setRemainingMs(timeoutMs);
  }, [timeoutMs]);

  useEffect(() => {
    if (!enabled) return;
    lastActivity.current = Date.now();
    const onActivity = () => {
      // Saat peringatan tampil, hanya tombol "Tetap masuk" yang memperpanjang agar pengguna sadar.
      if (Date.now() - lastActivity.current < timeoutMs - warnBeforeMs) lastActivity.current = Date.now();
    };
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    const timer = window.setInterval(() => {
      const left = timeoutMs - (Date.now() - lastActivity.current);
      setRemainingMs(Math.max(0, left));
      if (left <= 0) onTimeout();
    }, 1000);
    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
      window.clearInterval(timer);
    };
  }, [enabled, timeoutMs, warnBeforeMs, onTimeout]);

  return {
    remainingMs,
    warning: enabled && remainingMs > 0 && remainingMs <= warnBeforeMs,
    stayActive: markActive,
  };
}
