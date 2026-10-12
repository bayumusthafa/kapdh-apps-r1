import {
  hashKey,
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

/** Hash queryKey yang refetch berikutnya berasal dari polling (bukan tindakan admin). */
const backgroundFetches = new Set<string>();

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
   * Polling: refetch tiap `pollMs` selama tab terlihat. HANYA refetch polling yang membawa X-Background-Request;
   * pemuatan pertama dan perubahan filter oleh admin dihitung sebagai aktivitas (AC F02-5).
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
    ...options,
    queryFn: ({ signal, queryKey }) => {
      const background = backgroundFetches.delete(hashKey(queryKey));
      return unwrap(requestRef.current({ signal, headers: background ? { ...BACKGROUND_HEADERS } : {} }));
    },
  });

  const keyHash = hashKey(options.queryKey);
  const queryKeyRef = useRef(options.queryKey);
  queryKeyRef.current = options.queryKey;
  const enabled = options.enabled !== false;

  useEffect(() => {
    if (!pollMs || !enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      const key = queryKeyRef.current;
      const state = queryClient.getQueryState(key);
      if (!state || state.fetchStatus !== "idle") return;
      backgroundFetches.add(keyHash);
      void queryClient
        .refetchQueries({ queryKey: key, exact: true, type: "active" })
        .finally(() => backgroundFetches.delete(keyHash));
    }, pollMs);
    return () => window.clearInterval(timer);
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

/** Pasang field_errors VALIDATION_ERROR ke react-hook-form; kunci `_` menjadi galat akar (root.server). */
export function applyFieldErrors<TFieldValues extends FieldValues>(
  setError: UseFormSetError<TFieldValues>,
  error: ApiError,
): boolean {
  const entries = Object.entries(error.fieldErrors);
  for (const [field, messages] of entries) {
    const message = messages.join(" ");
    if (field === "_") setError("root.server", { type: "server", message });
    else setError(field as Parameters<UseFormSetError<TFieldValues>>[0], { type: "server", message });
  }
  return entries.length > 0;
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
  /** Minta reautentikasi sebelum percobaan pertama untuk operasi yang selalu sensitif (AC F15-3, F16-1). */
  requiresReauth?: boolean;
  /** Penjelasan pada dialog reautentikasi, mis. "Mengubah biaya iuran". */
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
      switch (error.ui.action) {
        case "show_field_errors":
          handledInline = opts.setError ? applyFieldErrors(opts.setError, error) : false;
          break;
        case "reload_latest":
          opts.onReloadLatest?.(error, vars);
          break;
        case "show_forbidden":
          void auth?.refreshProfile({ background: false });
          break;
        default:
          break;
      }
      if (opts.toastErrors !== false && !handledInline && !error.reauthCancelled) toast.error(error.message);
      opts.onError?.(error, vars);
    },
  });
}
