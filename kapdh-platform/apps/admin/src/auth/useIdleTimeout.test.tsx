import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_STORAGE_KEY, useIdleTimeout } from "./useIdleTimeout";

const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useIdleTimeout (AC F02-5)", () => {
  it("memperingatkan 2 menit sebelum batas dan memanggil onTimeout TEPAT SEKALI", () => {
    const onTimeout = vi.fn();
    const { result } = renderHook(() =>
      useIdleTimeout({ timeoutMs: 30 * MIN, warnBeforeMs: 2 * MIN, onTimeout, enabled: true }),
    );
    act(() => vi.advanceTimersByTime(27 * MIN));
    expect(result.current.warning).toBe(false);
    act(() => vi.advanceTimersByTime(MIN + 1_000));
    expect(result.current.warning).toBe(true);
    act(() => vi.advanceTimersByTime(3 * MIN));
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("interaksi pengguna menunda batas; saat peringatan hanya 'Tetap masuk' yang memperpanjang", () => {
    const onTimeout = vi.fn();
    const { result } = renderHook(() =>
      useIdleTimeout({ timeoutMs: 30 * MIN, warnBeforeMs: 2 * MIN, onTimeout, enabled: true }),
    );
    act(() => vi.advanceTimersByTime(20 * MIN));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown")));
    act(() => vi.advanceTimersByTime(20 * MIN));
    expect(onTimeout).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(8 * MIN + 30_000));
    expect(result.current.warning).toBe(true);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown")));
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current.warning).toBe(true);
    act(() => result.current.stayActive());
    expect(result.current.warning).toBe(false);
  });

  it("aktivitas di tab lain (localStorage) mencegah logout di tab yang tidak dipakai", () => {
    const onTimeout = vi.fn();
    renderHook(() =>
      useIdleTimeout({ timeoutMs: 30 * MIN, warnBeforeMs: 2 * MIN, onTimeout, enabled: true }),
    );
    act(() => vi.advanceTimersByTime(25 * MIN));
    window.localStorage.setItem(ACTIVITY_STORAGE_KEY, String(Date.now()));
    act(() => vi.advanceTimersByTime(25 * MIN));
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("detak: admin aktif mengetik tanpa permintaan server selama 5 menit → onHeartbeat (bukan latar)", () => {
    const onHeartbeat = vi.fn();
    renderHook(() =>
      useIdleTimeout({
        timeoutMs: 30 * MIN,
        warnBeforeMs: 2 * MIN,
        onTimeout: vi.fn(),
        enabled: true,
        onHeartbeat,
        lastServerActivity: () => 0,
      }),
    );
    // Tidak ada interaksi: tidak ada detak.
    act(() => vi.advanceTimersByTime(6 * MIN));
    expect(onHeartbeat).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown")));
    act(() => vi.advanceTimersByTime(2_000));
    expect(onHeartbeat).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown")));
    act(() => vi.advanceTimersByTime(2_000));
    expect(onHeartbeat).toHaveBeenCalledTimes(1);
  });
});
