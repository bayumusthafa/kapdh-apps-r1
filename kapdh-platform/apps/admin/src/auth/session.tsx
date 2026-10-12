import type { components, Permission } from "@kapdh/contracts";
import { useQueryClient } from "@tanstack/react-query";
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
import {
  api,
  BACKGROUND_HEADERS,
  onSessionExpired,
  refreshAccessToken,
  revokeCurrentSession,
  setAccessToken,
} from "../api/client";
import { ApiError, toApiError } from "../api/errors";
import { useToast } from "../components/ui/Toast";

type AdminProfile = components["schemas"]["AdminProfile"];

/** Nilai default sama dengan server (PRD 5.2, N-08); dipakai saat sesi dipulihkan dari cookie. */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800;

/** Profil dan izin dimuat ulang berkala agar perubahan izin oleh Super Admin terlihat di UI (AC F16-3). */
export const PROFILE_REFRESH_MS = 60_000;

export type AuthState =
  | { status: "restoring" }
  | { status: "anonymous" }
  | { status: "mfa"; mfaToken: string; enrollmentRequired: boolean }
  | { status: "authenticated"; profile: AdminProfile; idleTimeoutSeconds: number };

export type LogoutReason = "idle" | "manual" | "expired";

export type LoginResult = { ok: true; next: "mfa" | "enroll" } | { ok: false; error: ApiError };

/** "any" = cukup sudah masuk; daftar = salah satu izin cukup. */
export type Access = readonly Permission[] | "any";

export interface AuthApi {
  state: AuthState;
  /** Profil admin bila sudah masuk. */
  profile: AdminProfile | null;
  login(email: string, password: string): Promise<LoginResult>;
  verifyMfa(code: string): Promise<ApiError | null>;
  /** Batalkan login yang berhenti di tahap MFA/pendaftaran TOTP dan kembali ke halaman masuk. */
  cancelLogin(): void;
  logout(reason?: LogoutReason): Promise<void>;
  /** Ping GET /admin/me TANPA header latar sehingga idle server ikut diperpanjang ("Tetap masuk", AC F02-5). */
  touch(): Promise<boolean>;
  /** Muat ulang profil dan izin efektif dari server (AC F15-1, F16-3). */
  refreshProfile(opts?: { background?: boolean }): Promise<void>;
  can(permission: Permission): boolean;
  canAny(access: Access): boolean;
  lastLogoutReason: LogoutReason | null;
  /**
   * State terbaru secara sinkron untuk penjaga rute (beforeLoad). Navigasi tepat setelah login/logout harus melihat
   * hasilnya walau React belum merender ulang konteks router.
   */
  snapshot(): { state: AuthState; lastLogoutReason: LogoutReason | null };
  /** Seperti canAny, tetapi dievaluasi terhadap snapshot terbaru. */
  allowsNow(access: Access): boolean;
}

const AuthContext = createContext<AuthApi | null>(null);

function samePermissions(a: AdminProfile, b: AdminProfile): boolean {
  return (
    a.permissions_version === b.permissions_version &&
    a.role === b.role &&
    a.permissions.length === b.permissions.length &&
    a.permissions.every((p) => b.permissions.includes(p))
  );
}

/**
 * Sesi admin (F-02, N-08): login dua tahap (sandi lalu TOTP/backup code), access token di memori, pemulihan dari
 * cookie refresh HttpOnly saat halaman dimuat ulang, logout yang mencabut sesi server walau access token sudah
 * habis, pembersihan cache React Query saat logout/kedaluwarsa, dan muat ulang izin berkala (AC F16-3).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [state, setState] = useState<AuthState>({ status: "restoring" });
  const [lastLogoutReason, setLastLogoutReasonState] = useState<LogoutReason | null>(null);
  // Salinan sinkron untuk penjaga rute: navigasi tepat setelah login/logout harus melihat state terbaru walau
  // React belum merender ulang.
  const stateRef = useRef<AuthState>(state);
  const reasonRef = useRef<LogoutReason | null>(null);
  const commit = useCallback((next: AuthState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const setLastLogoutReason = useCallback((reason: LogoutReason | null) => {
    reasonRef.current = reason;
    setLastLogoutReasonState(reason);
  }, []);
  const logoutInflight = useRef<Promise<void> | null>(null);

  /** Akhiri sesi lokal: buang token di memori dan seluruh cache data admin sebelumnya. */
  const endLocalSession = useCallback(
    (reason: LogoutReason) => {
      setAccessToken(null);
      // Cache admin sebelumnya tidak boleh tampil untuk admin berikutnya di tab yang sama.
      queryClient.clear();
      setLastLogoutReason(reason);
      commit({ status: "anonymous" });
    },
    [queryClient, commit, setLastLogoutReason],
  );

  // Muat ulang halaman: access token di memori hilang, pulihkan dari cookie refresh bila masih berlaku.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pair = await refreshAccessToken();
      const me = pair ? await api.GET("/admin/me").catch(() => null) : null;
      if (cancelled) return;
      if (me?.data) {
        commit({
          status: "authenticated",
          profile: me.data,
          idleTimeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
        });
      } else {
        setAccessToken(null);
        commit({ status: "anonymous" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    onSessionExpired(() => {
      if (stateRef.current.status !== "authenticated") return;
      endLocalSession("expired");
    });
    return () => onSessionExpired(null);
  }, [endLocalSession]);

  const logout = useCallback(
    (reason: LogoutReason = "manual") => {
      logoutInflight.current ??= (async () => {
        // Cabut sesi di server lebih dulu (refresh dulu bila access token sudah habis) agar cookie
        // kapdh_admin_rt tidak memulihkan sesi saat halaman dimuat ulang.
        const revoked = await revokeCurrentSession();
        endLocalSession(reason);
        if (!revoked)
          toast.warning(
            "Anda sudah keluar di perangkat ini, tetapi server belum mengonfirmasi. Tutup peramban bila memakai komputer bersama.",
          );
      })().finally(() => {
        logoutInflight.current = null;
      });
      return logoutInflight.current;
    },
    [endLocalSession, toast],
  );

  const applyProfile = useCallback(
    (profile: AdminProfile) => {
      const current = stateRef.current;
      if (current.status !== "authenticated") return;
      const permissionsChanged = !samePermissions(current.profile, profile);
      if (!permissionsChanged && current.profile.display_name === profile.display_name) return;
      commit({ ...current, profile });
      if (permissionsChanged) {
        toast.info("Izin akun Anda diperbarui oleh Super Admin. Menu disesuaikan.");
        void queryClient.invalidateQueries();
      }
    },
    [queryClient, toast, commit],
  );

  const fetchProfile = useCallback(
    async (background: boolean): Promise<boolean> => {
      if (stateRef.current.status !== "authenticated") return false;
      const res = await api
        .GET("/admin/me", background ? { headers: BACKGROUND_HEADERS } : {})
        .catch(() => null);
      if (!res) return false; // jaringan putus: jangan keluarkan admin (PRD 4.5)
      if (res.data) {
        applyProfile(res.data);
        return true;
      }
      // 401 sudah ditangani middleware (refresh lalu onSessionExpired). 403 berarti akun admin dinonaktifkan atau
      // MFA tidak berlaku lagi: sesi tidak dapat dipakai, cabut di server lalu keluar.
      if (res.response.status === 403 && stateRef.current.status === "authenticated") void logout("expired");
      return false;
    },
    [applyProfile, logout],
  );

  const refreshProfile = useCallback(
    async (opts: { background?: boolean } = {}) => {
      await fetchProfile(opts.background ?? true);
    },
    [fetchProfile],
  );

  const touch = useCallback(() => fetchProfile(false), [fetchProfile]);

  const authenticated = state.status === "authenticated";
  useEffect(() => {
    if (!authenticated) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void fetchProfile(true);
    }, PROFILE_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void fetchProfile(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [authenticated, fetchProfile]);

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      try {
        const { data, error, response } = await api.POST("/admin/auth/login", { body: { email, password } });
        if (!data) return { ok: false, error: ApiError.fromResponse(error, response.status) };
        setLastLogoutReason(null);
        const enrollmentRequired = data.totp_enrollment_required === true;
        commit({ status: "mfa", mfaToken: data.mfa_token, enrollmentRequired });
        return { ok: true, next: enrollmentRequired ? "enroll" : "mfa" };
      } catch (e) {
        return { ok: false, error: toApiError(e) };
      }
    },
    [commit, setLastLogoutReason],
  );

  const verifyMfa = useCallback(
    async (code: string): Promise<ApiError | null> => {
      const current = stateRef.current;
      if (current.status !== "mfa")
        return new ApiError({ code: "UNAUTHENTICATED", status: 401, message: "Mulai dari halaman masuk." });
      const body = /^\d{6}$/.test(code)
        ? { mfa_token: current.mfaToken, totp_code: code }
        : { mfa_token: current.mfaToken, backup_code: code.toUpperCase() };
      try {
        const mfa = await api.POST("/admin/auth/mfa", { body });
        if (!mfa.data) return ApiError.fromResponse(mfa.error, mfa.response.status);
        setAccessToken(mfa.data.access_token, mfa.data.access_expires_at);
        const me = await api.GET("/admin/me");
        if (!me.data) {
          setAccessToken(null);
          return ApiError.fromResponse(me.error, me.response.status);
        }
        queryClient.clear();
        commit({
          status: "authenticated",
          profile: me.data,
          idleTimeoutSeconds: mfa.data.idle_timeout_seconds,
        });
        return null;
      } catch (e) {
        return toApiError(e);
      }
    },
    [queryClient, commit],
  );

  const cancelLogin = useCallback(() => {
    if (stateRef.current.status === "mfa") commit({ status: "anonymous" });
  }, [commit]);

  const snapshot = useCallback(() => ({ state: stateRef.current, lastLogoutReason: reasonRef.current }), []);
  const allowsNow = useCallback((access: Access) => {
    const current = stateRef.current;
    return (
      current.status === "authenticated" &&
      (access === "any" || access.some((p) => current.profile.permissions.includes(p)))
    );
  }, []);

  const can = useCallback(
    (permission: Permission) =>
      state.status === "authenticated" && state.profile.permissions.includes(permission),
    [state],
  );

  const canAny = useCallback(
    (access: Access) =>
      state.status === "authenticated" &&
      (access === "any" || access.some((p) => state.profile.permissions.includes(p))),
    [state],
  );

  const value = useMemo<AuthApi>(
    () => ({
      state,
      profile: state.status === "authenticated" ? state.profile : null,
      login,
      verifyMfa,
      cancelLogin,
      logout,
      touch,
      refreshProfile,
      can,
      canAny,
      lastLogoutReason,
      snapshot,
      allowsNow,
    }),
    [
      state,
      login,
      verifyMfa,
      cancelLogin,
      logout,
      touch,
      refreshProfile,
      can,
      canAny,
      lastLogoutReason,
      snapshot,
      allowsNow,
    ],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth harus dipakai di dalam AuthProvider");
  return ctx;
}

/** Untuk komponen design system yang juga dipakai di luar sesi (mis. uji komponen terisolasi). */
export function useOptionalAuth(): AuthApi | null {
  return useContext(AuthContext);
}
