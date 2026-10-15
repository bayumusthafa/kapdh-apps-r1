import {
  hashKey,
  type QueryClient,
  type QueryKey,
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { FieldValues, UseFormSetError } from "react-hook-form";
import { useOptionalAuth } from "../auth/session";
import { useToast } from "../components/ui/Toast";
import { BACKGROUND_HEADERS } from "./client";
import { ApiError, toApiError } from "./errors";
import { useReauth } from "./reauth";

/** Bentuk hasil openapi-fetch yang dipakai helper ini. */
export interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/** Ubah hasil openapi-fetch menjadi data atau melempar ApiError bertipe (kontrak `Error`, PRD 5.2). */
export async function unwrap<T>(promise: Promise<FetchResult<T>>): Promise<T> {
  let res: FetchResult<T>;
  try {
    res = await promise;
  } catch (e) {
    if (isAbort(e)) throw e;
    throw toApiError(e);
  }
  if (!res.response.ok) throw ApiError.fromResponse(res.error, res.response.status);
  return res.data as T;
}

/**
 * Jumlah refetch latar (polling, kembali online, pembaruan URL berkas) yang sedang berjalan per hash queryKey.
 * Penanda bertahan selama SELURUH siklus fetch, termasuk percobaan ulang otomatis React Query setelah galat
 * jaringan/5xx, sehingga percobaan ulang itu tetap membawa X-Background-Request (AC F02-5).
 */
const backgroundFetches = new Map<string, number>();

/**
 * Refetch query aktif `queryKey` sebagai permintaan latar: server tidak menghitungnya sebagai aktivitas admin
 * (AC F02-5). Fetch yang sedang berjalan tidak dibatalkan (cancelRefetch: false).
 */
export function refetchInBackground(queryClient: QueryClient, queryKey: QueryKey): Promise<void> {
  const hash = hashKey(queryKey);
  backgroundFetches.set(hash, (backgroundFetches.get(hash) ?? 0) + 1);
  return queryClient
    .refetchQueries({ queryKey, exact: true, type: "active" }, { cancelRefetch: false })
    .finally(() => {
      const left = (backgroundFetches.get(hash) ?? 1) - 1;
      if (left > 0) backgroundFetches.set(hash, left);
      else backgroundFetches.delete(hash);
    });
}

export interface ApiQueryContext {
  signal: AbortSignal;
  /** Berisi X-Background-Request hanya untuk refetch polling (AC F02-5). Teruskan ke `headers` openapi-fetch. */
  headers: Record<string, string>;
}

export interface UseApiQueryOptions<T, TData = T> extends Omit<
  UseQueryOptions<T, ApiError, TData>,
  "queryFn" | "refetchInterval" | "queryKey" | "enabled"
> {
  queryKey: QueryKey;
  request: (ctx: ApiQueryContext) => Promise<FetchResult<T>>;
  enabled?: boolean;
  /**
   * Polling: refetch tiap `pollMs` selama tab terlihat. HANYA refetch otomatis (polling, termasuk percobaan
   * ulangnya, dan refetch saat kembali online) yang membawa X-Background-Request; pemuatan pertama dan perubahan
   * filter oleh admin dihitung sebagai aktivitas (AC F02-5).
   */
  pollMs?: number | false;
}

/**
 * useQuery bertipe untuk API admin: melempar ApiError, memasang header latar hanya pada polling, dan
 * memuat ulang izin admin bila server menjawab FORBIDDEN (izin dicabut saat sesi berjalan, AC F16-3).
 */
export function useApiQuery<T, TData = T>({
  request,
  pollMs,
  ...options
}: UseApiQueryOptions<T, TData>): UseQueryResult<TData, ApiError> {
  const queryClient = useQueryClient();
  const auth = useOptionalAuth();
  const requestRef = useRef(request);
  requestRef.current = request;

  const query = useQuery<T, ApiError, TData>({
    // Refetch otomatis saat kembali online ditangani di bawah sebagai permintaan latar (bukan aktivitas admin).
    refetchOnReconnect: false,
    ...options,
    queryFn: ({ signal, queryKey }) => {
      const background = backgroundFetches.has(hashKey(queryKey));
      return unwrap(requestRef.current({ signal, headers: background ? { ...BACKGROUND_HEADERS } : {} }));
    },
  });

  const keyHash = hashKey(options.queryKey);
  const queryKeyRef = useRef(options.queryKey);
  queryKeyRef.current = options.queryKey;
  const enabled = options.enabled !== false;

  useEffect(() => {
    if (!enabled) return;
    const refetchIfIdle = () => {
      const key = queryKeyRef.current;
      const state = queryClient.getQueryState(key);
      if (!state || state.fetchStatus !== "idle") return;
      void refetchInBackground(queryClient, key);
    };
    const onOnline = () => refetchIfIdle();
    window.addEventListener("online", onOnline);
    const timer = pollMs
      ? window.setInterval(() => {
          if (document.visibilityState !== "hidden") refetchIfIdle();
        }, pollMs)
      : null;
    return () => {
      window.removeEventListener("online", onOnline);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [pollMs, enabled, keyHash, queryClient]);

  const forbidden = query.error?.code === "FORBIDDEN";
  useEffect(() => {
    if (forbidden) void auth?.refreshProfile({ background: true });
  }, [forbidden, auth]);

  return query;
}

/** JSON dengan urutan kunci tetap, untuk sidik jari niat pengguna. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value instanceof Blob) return `blob:${value.size}:${value.type}`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Hasil diketahui pasti bila server memproses dan menolak permintaan (4xx selain 408/429). Galat jaringan, 5xx
 * dan respons tak dikenal berarti hasil belum diketahui: key idempotensi yang sama dipakai lagi (PRD 4.3).
 */
function outcomeKnown(error: ApiError): boolean {
  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

export interface AppliedFieldErrors {
  /** Ada galat yang dipasang ke formulir. */
  applied: boolean;
  /** Galat `_` dipasang sebagai root.server (tampil lewat <FormError role="alert">). */
  root: boolean;
  /** Fokus berpindah ke isian bergalat pertama (galatnya dibacakan lewat aria-describedby). */
  focused: boolean;
  /** Pesan galat pertama, untuk ringkasan bila isian tidak dapat difokus. */
  firstMessage: string | null;
}

/**
 * Pasang field_errors VALIDATION_ERROR ke react-hook-form; kunci `_` menjadi galat akar (root.server). Isian
 * bergalat pertama difokus agar pengguna keyboard/pembaca layar langsung mendengar galatnya (N-11).
 */
export function applyFieldErrors<TFieldValues extends FieldValues>(
  setError: UseFormSetError<TFieldValues>,
  error: ApiError,
): AppliedFieldErrors {
  const entries = Object.entries(error.fieldErrors);
  const before = typeof document !== "undefined" ? document.activeElement : null;
  let root = false;
  let focusRequested = false;
  for (const [field, messages] of entries) {
    const message = messages.join(" ");
    if (field === "_") {
      root = true;
      setError("root.server", { type: "server", message });
    } else {
      setError(
        field as Parameters<UseFormSetError<TFieldValues>>[0],
        { type: "server", message },
        { shouldFocus: !focusRequested },
      );
      focusRequested = true;
    }
  }
  const after = typeof document !== "undefined" ? document.activeElement : null;
  return {
    applied: entries.length > 0,
    root,
    focused: focusRequested && after !== null && after !== before && after !== document.body,
    firstMessage: entries[0]?.[1].join(" ") ?? null,
  };
}

export interface MutationRequestContext {
  /** Satu key per niat pengguna; sama untuk pengulangan setelah hasil tidak diketahui (PRD 4.3). */
  idempotencyKey: string;
  /** Token X-Reauth-Token untuk permintaan berikutnya setelah dialog reautentikasi (ARCHITECTURE §4.3). */
  reauthToken: string | undefined;
  /** Idempotency-Key dan (bila ada) X-Reauth-Token, siap diteruskan ke `headers` openapi-fetch. */
  headers: Record<string, string>;
}

export interface UseApiMutationOptions<T, V, TFieldValues extends FieldValues = FieldValues> {
  request: (vars: V, ctx: MutationRequestContext) => Promise<FetchResult<T>>;
  /** Sidik jari niat; bawaan seluruh variabel. Sertakan versi objek agar keputusan setelah muat ulang memakai key baru. */
  intent?: (vars: V) => unknown;
  /**
   * Minta reautentikasi sebelum percobaan pertama. Hanya untuk tindakan kredensial yang kontraknya `reauth: true`
   * (backup code, kirim ulang undangan/pemulihan admin, reset sandi anggota) atau yang isinya kredensial menurut
   * `ReauthTokenConditional` (koreksi email login admin; ADR-025). Operasi lain tidak memakainya; REAUTH_REQUIRED
   * dari server tetap ditangani generik (dialog lalu ulang sekali).
   */
  requiresReauth?: boolean;
  /** Penjelasan pada dialog reautentikasi, mis. "Membuat ulang backup code". */
  reauthReason?: string;
  /** show_field_errors: field_errors dipasang ke form ini. */
  setError?: UseFormSetError<TFieldValues>;
  /** reload_latest: muat ulang data terbaru, jangan menimpa diam-diam (AC F04-3, F04-4, F15-4). */
  onReloadLatest?: (error: ApiError, vars: V) => void;
  onSuccess?: (data: T, vars: V) => void | Promise<void>;
  onError?: (error: ApiError, vars: V) => void;
  /** Pesan toast sukses (opsional). */
  successMessage?: string | ((data: T, vars: V) => string);
  /** Toast galat otomatis (bawaan true). Galat field yang sudah dipasang ke form tidak di-toast. */
  toastErrors?: boolean;
}

/**
 * useMutation bertipe untuk API admin:
 * - Idempotency-Key per niat pengguna (PRD 4.3);
 * - REAUTH_REQUIRED → buka ReauthDialog lalu ulangi sekali dengan X-Reauth-Token;
 * - VALIDATION_ERROR → setError pada form; reload_latest → onReloadLatest; FORBIDDEN → muat ulang izin;
 * - pesan galat dari katalog ERROR_UI.
 */
export function useApiMutation<T, V = void, TFieldValues extends FieldValues = FieldValues>(
  options: UseApiMutationOptions<T, V, TFieldValues>,
): UseMutationResult<T, ApiError, V> {
  const reauth = useReauth();
  const toast = useToast();
  const auth = useOptionalAuth();
  const optsRef = useRef(options);
  optsRef.current = options;
  const intentRef = useRef<{ fingerprint: string; key: string } | null>(null);

  function idempotencyKeyFor(vars: V): string {
    const fingerprint = stableStringify(optsRef.current.intent ? optsRef.current.intent(vars) : vars);
    if (intentRef.current?.fingerprint !== fingerprint)
      intentRef.current = { fingerprint, key: crypto.randomUUID() };
    return intentRef.current.key;
  }

  return useMutation<T, ApiError, V>({
    mutationFn: async (vars) => {
      const opts = optsRef.current;
      const idempotencyKey = idempotencyKeyFor(vars);
      const send = (reauthToken: string | undefined) =>
        unwrap(
          opts.request(vars, {
            idempotencyKey,
            reauthToken,
            headers: {
              "Idempotency-Key": idempotencyKey,
              ...(reauthToken ? { "X-Reauth-Token": reauthToken } : {}),
            },
          }),
        );
      let token: string | undefined;
      if (opts.requiresReauth) {
        token = (await reauth.request(opts.reauthReason)) ?? undefined;
        if (!token)
          throw new ApiError({
            code: "REAUTH_REQUIRED",
            status: 403,
            message: "Tindakan dibatalkan karena identitas belum dikonfirmasi ulang.",
            reauthCancelled: true,
          });
      }
      try {
        return await send(token);
      } catch (e) {
        const err = toApiError(e);
        if (err.ui.action !== "reauthenticate") throw err;
        const fresh = await reauth.request(opts.reauthReason);
        if (!fresh) throw err.withReauthCancelled();
        return await send(fresh);
      }
    },
    onSuccess: async (data, vars) => {
      intentRef.current = null;
      const opts = optsRef.current;
      const msg =
        typeof opts.successMessage === "function" ? opts.successMessage(data, vars) : opts.successMessage;
      if (msg) toast.success(msg);
      await opts.onSuccess?.(data, vars);
    },
    onError: (error, vars) => {
      const opts = optsRef.current;
      if (outcomeKnown(error) || error.reauthCancelled) intentRef.current = null;
      let handledInline = false;
      let message = error.message;
      switch (error.ui.action) {
        case "show_field_errors": {
          if (!opts.setError) break;
          const result = applyFieldErrors(opts.setError, error);
          // Galat sudah tersampaikan bila fokus pindah ke isian bergalat atau galat akar tampil sebagai alert.
          // Bila tidak (isian berada di balik dialog yang sedang tertutup, fokus tetap di tempat), umumkan
          // ringkasan lewat toast agar pembaca layar tetap mendapat umpan balik (N-11, PRD 4.5).
          handledInline = result.applied && (result.focused || result.root);
          if (result.applied && !handledInline)
            message = `Periksa isian yang ditandai. ${result.firstMessage ?? ""}`.trim();
          break;
        }
        case "reload_latest":
          opts.onReloadLatest?.(error, vars);
          break;
        case "show_forbidden":
          void auth?.refreshProfile({ background: false });
          break;
        default:
          break;
      }
      if (opts.toastErrors !== false && !handledInline && !error.reauthCancelled) toast.error(message);
      opts.onError?.(error, vars);
    },
  });
}
