import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { ReauthDialog } from "../components/ui/ReauthDialog";

/**
 * Reautentikasi untuk tindakan sensitif (ubah biaya/metode bayar, izin admin; AC F15-3, F16-1, ARCHITECTURE §4.3).
 * `request()` membuka satu ReauthDialog; permintaan serentak berbagi dialog yang sama. Token hasil POST
 * /auth/reauth dikembalikan ke pemanggil untuk dikirim sebagai X-Reauth-Token pada permintaan berikutnya, lalu
 * tidak disimpan di mana pun.
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
  const inflight = useRef<Promise<string | null> | null>(null);

  const request = useCallback((reason?: string) => {
    inflight.current ??= new Promise<string | null>((resolve) => {
      setPending({
        reason,
        resolve: (token) => {
          inflight.current = null;
          setPending(null);
          resolve(token);
        },
      });
    });
    return inflight.current;
  }, []);

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
