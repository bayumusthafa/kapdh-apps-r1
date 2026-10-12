import type { AdminRole } from "@kapdh/contracts";
import { AsyncLocalStorage } from "node:async_hooks";
import { v7 as uuidv7 } from "uuid";

/**
 * Konteks request/job (ARCHITECTURE §4.2) lewat AsyncLocalStorage: request_id korelasi log API, worker, dan audit
 * (N-14), aktor untuk audit (AC F17-1), serta versi/platform aplikasi untuk gerbang versi (PRD 4.5).
 *
 * `requestId` SELALU dibuat server (uuidv7). X-Request-Id dari klien hanya disimpan sebagai `clientRequestId` untuk
 * log, tidak pernah masuk audit, sehingga klien tidak dapat memalsukan/mengulang korelasi audit (audit core).
 */
export type ActorKind = "alumni" | "admin" | "system" | "anonymous";

export interface Actor {
  kind: ActorKind;
  userId: string | null;
  adminId: string | null;
  adminRole: AdminRole | null;
  sessionId: string | null;
}

export type ContextSource = "http" | "job" | "cli" | "test";

export interface RequestContext {
  /** Korelasi audit/outbox: id request HTTP, atau request asal event outbox yang sedang diproses worker. */
  requestId: string;
  /** Id eksekusi job worker (log `job_id`), null untuk request HTTP. */
  jobId: string | null;
  clientRequestId: string | null;
  actor: Actor;
  ip: string | null;
  appVersion: string | null;
  appPlatform: "android" | "ios" | null;
  source: ContextSource;
}

export const ANONYMOUS_ACTOR: Readonly<Actor> = Object.freeze({
  kind: "anonymous",
  userId: null,
  adminId: null,
  adminRole: null,
  sessionId: null,
});

export const SYSTEM_ACTOR: Readonly<Actor> = Object.freeze({
  kind: "system",
  userId: null,
  adminId: null,
  adminRole: null,
  sessionId: null,
});

const storage = new AsyncLocalStorage<RequestContext>();

/** Konteks aktif. Melempar bila dipanggil di luar request/job agar audit tidak pernah tanpa korelasi. */
export function ctx(): RequestContext {
  const current = storage.getStore();
  if (!current)
    throw new Error("ctx() dipanggil di luar konteks request/job; bungkus dengan runInContext/runAsSystem");
  return current;
}

/** Konteks aktif atau undefined (untuk logger dan filter galat). */
export function tryCtx(): RequestContext | undefined {
  return storage.getStore();
}

export function runInContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Menjalankan fn sebagai aktor system (job worker, CLI, seed). `requestId` = korelasi audit (mis. request_id asal
 * event outbox), `jobId` = id eksekusi job untuk log; keduanya dibuat bila tidak diberikan.
 */
export function runAsSystem<T>(
  fn: () => T,
  options: { requestId?: string; jobId?: string; source?: Exclude<ContextSource, "http"> } = {},
): T {
  const jobId = options.jobId ?? uuidv7();
  return storage.run(
    {
      requestId: options.requestId ?? jobId,
      jobId,
      clientRequestId: null,
      actor: { ...SYSTEM_ACTOR },
      ip: null,
      appVersion: null,
      appPlatform: null,
      source: options.source ?? "job",
    },
    fn,
  );
}

/** Dipanggil AuthGuard setelah autentikasi berhasil. */
export function setActor(actor: Actor): void {
  const current = storage.getStore();
  if (current) current.actor = actor;
}
