import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOptionalAuth } from "../auth/session";
import { ReauthDialog } from "../components/ui/ReauthDialog";

/**
 * Reautentikasi untuk tindakan sensitif (ubah biaya/metode bayar, izin admin; AC F15-3, F16-1, ARCHITECTURE §4.3).
 * `request()` membuka satu ReauthDialog; permintaan serentak berbagi dialog yang sama. Token hasil POST
 * /auth/reauth dikembalikan ke pemanggil untuk dikirim sebagai X-Reauth-Token pada permintaan berikutnya, lalu
 * tidak disimpan di mana pun. Bila sesi berakhir (idle, kedaluwarsa, keluar di tab lain) selagi dialog terbuka,
 * permintaan diselesaikan dengan null dan dialog ditutup sehingga tidak tertinggal di atas halaman masuk.
 */
export interface ReauthApi {
  request(reason?: string): Promise<string | null>;
}

const ReauthContext = createContext<ReauthApi | null>(null);

interface Pending {
  reason: string | undefined;
  resolve: (token: string | null) => void;
}

export function ReauthProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const inflight = useRef<Promise<string | null> | null>(null);

  const request = useCallback((reason?: string) => {
    inflight.current ??= new Promise<string | null>((resolve) => {
      let settled = false;
      const entry: Pending = {
        reason,
        resolve: (token) => {
          if (settled) return;
          settled = true;
          inflight.current = null;
          pendingRef.current = null;
          setPending(null);
          resolve(token);
        },
      };
      pendingRef.current = entry;
      setPending(entry);
    });
    return inflight.current;
  }, []);

  // Sesi berakhir saat dialog terbuka: batalkan (null) agar mutasi yang menunggu selesai tanpa toast galat.
  const status = useOptionalAuth()?.state.status;
  const previousStatus = useRef(status);
  useEffect(() => {
    const was = previousStatus.current;
    previousStatus.current = status;
    if (was === "authenticated" && status !== "authenticated") pendingRef.current?.resolve(null);
  }, [status]);

  const value = useMemo(() => ({ request }), [request]);
  return (
    <ReauthContext.Provider value={value}>
      {children}
      <ReauthDialog open={pending !== null} reason={pending?.reason} onResult={(t) => pending?.resolve(t)} />
    </ReauthContext.Provider>
  );
}

export function useReauth(): ReauthApi {
  const ctx = useContext(ReauthContext);
  if (!ctx) throw new Error("useReauth harus dipakai di dalam ReauthProvider");
  return ctx;
}
