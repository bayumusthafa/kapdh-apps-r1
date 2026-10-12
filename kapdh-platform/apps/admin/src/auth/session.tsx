import type { components } from "@kapdh/contracts";
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
import { api, onSessionExpired, refreshAccessToken, setAccessToken } from "../api/client";

type AdminProfile = components["schemas"]["AdminProfile"];

/** Nilai default sama dengan server (PRD 5.2); dipakai saat sesi dipulihkan dari cookie. */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800;

export type AuthState =
  | { status: "restoring" }
  | { status: "anonymous" }
  | { status: "mfa"; mfaToken: string }
  | { status: "authenticated"; profile: AdminProfile; idleTimeoutSeconds: number };

type LogoutReason = "idle" | "manual" | "expired";

interface AuthApi {
  state: AuthState;
  login(email: string, password: string): Promise<string | null>;
  verifyMfa(code: string): Promise<string | null>;
  logout(reason?: LogoutReason): Promise<void>;
  can(permission: components["schemas"]["Permission"]): boolean;
  lastLogoutReason: LogoutReason | null;
}

const AuthContext = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "restoring" });
  const [lastLogoutReason, setLastLogoutReason] = useState<LogoutReason | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Muat ulang halaman: access token di memori hilang, pulihkan dari cookie refresh bila masih berlaku.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pair = await refreshAccessToken();
      const me = pair ? await api.GET("/admin/me") : null;
      if (cancelled) return;
      if (me?.data) {
        setState({
          status: "authenticated",
          profile: me.data,
          idleTimeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
        });
      } else {
        setAccessToken(null);
        setState({ status: "anonymous" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    onSessionExpired(() => {
      if (stateRef.current.status !== "authenticated") return;
      setAccessToken(null);
      setLastLogoutReason("expired");
      setState({ status: "anonymous" });
    });
    return () => onSessionExpired(null);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { data, error } = await api.POST("/admin/auth/login", { body: { email, password } });
    if (error || !data) return error?.message ?? "Gagal masuk.";
    setLastLogoutReason(null);
    setState({ status: "mfa", mfaToken: data.mfa_token });
    return null;
  }, []);

  const verifyMfa = useCallback(
    async (code: string) => {
      if (state.status !== "mfa") return "Mulai dari login.";
      const body = /^\d{6}$/.test(code)
        ? { mfa_token: state.mfaToken, totp_code: code }
        : { mfa_token: state.mfaToken, backup_code: code };
      const { data, error } = await api.POST("/admin/auth/mfa", { body });
      if (error || !data) return error?.message ?? "Kode tidak valid.";
      setAccessToken(data.access_token, data.access_expires_at);
      const me = await api.GET("/admin/me");
      if (!me.data) return me.error?.message ?? "Gagal memuat profil admin.";
      setState({ status: "authenticated", profile: me.data, idleTimeoutSeconds: data.idle_timeout_seconds });
      return null;
    },
    [state],
  );

  const logout = useCallback(async (reason: LogoutReason = "manual") => {
    // Tunggu server mencabut sesi dan menghapus cookie sebelum token di memori dibuang.
    await api.POST("/auth/logout").catch(() => undefined);
    setAccessToken(null);
    setLastLogoutReason(reason);
    setState({ status: "anonymous" });
  }, []);

  const can = useCallback(
    (permission: components["schemas"]["Permission"]) =>
      state.status === "authenticated" && state.profile.permissions.includes(permission),
    [state],
  );

  const value = useMemo(
    () => ({ state, login, verifyMfa, logout, can, lastLogoutReason }),
    [state, login, verifyMfa, logout, can, lastLogoutReason],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth harus dipakai di dalam AuthProvider");
  return ctx;
}
