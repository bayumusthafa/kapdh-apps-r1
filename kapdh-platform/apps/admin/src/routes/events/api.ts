import type { components } from "@kapdh/contracts";
import { keepPreviousData, type QueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import { unwrap, useApiQuery } from "../../api/query";

/**
 * Akses API area Manajemen Event & Tiket (kontrak admin-events C5 dan kategori event admin-content). Kunci query
 * terpusat agar mutasi memperbarui daftar, detail, statistik dan tiket secara konsisten.
 */
export type AdminEventSummary = components["schemas"]["AdminEventSummary"];
export type AdminEventDetail = components["schemas"]["AdminEventDetail"];
export type AdminEventTicket = components["schemas"]["AdminEventTicket"];
export type AdminEventCategory = components["schemas"]["AdminEventCategory"];
export type EventStatus = components["schemas"]["EventStatus"];
export type TicketStatus = components["schemas"]["TicketStatus"];
export type AdminEventSort = components["schemas"]["AdminEventSort"];
export type AdminEventTicketSort = components["schemas"]["AdminEventTicketSort"];
export type AdminEventCoverMedia = components["schemas"]["AdminEventCoverMedia"];
export type AdminCheckinEvent = components["schemas"]["AdminCheckinEvent"];

export const eventKeys = {
  all: ["admin-events"] as const,
  lists: ["admin-events", "list"] as const,
  list: (filters: unknown) => ["admin-events", "list", filters] as const,
  detail: (eventId: string) => ["admin-events", "detail", eventId] as const,
  stats: (eventId: string) => ["admin-events", "detail", eventId, "stats"] as const,
  tickets: (eventId: string, filters?: unknown) =>
    filters === undefined
      ? (["admin-events", "detail", eventId, "tickets"] as const)
      : (["admin-events", "detail", eventId, "tickets", filters] as const),
  categories: ["admin-event-categories"] as const,
  managedCategories: (filters?: unknown) =>
    filters === undefined
      ? (["admin-event-categories", "managed"] as const)
      : (["admin-event-categories", "managed", filters] as const),
  checkinEvents: ["admin-checkin-events"] as const,
};

/** Ukuran halaman tabel event (server: bawaan 30, maks 100). */
export const EVENT_PAGE_SIZE = 20;
export const TICKET_PAGE_SIZE = 20;

/** Kategori event (aktif dan nonaktif) untuk formulir dan filter (adminListEventCategories). */
export function useEventCategories() {
  return useApiQuery({
    queryKey: eventKeys.categories,
    staleTime: 60_000,
    request: ({ signal, headers }) => api.GET("/admin/event-categories", { signal, headers }),
  });
}

export interface EventListFilters {
  q: string;
  status: EventStatus | "all";
  categoryId: string;
  sort: AdminEventSort;
}

export function useEventList(filters: EventListFilters, cursor: string | null) {
  return useApiQuery({
    queryKey: eventKeys.list({ ...filters, cursor }),
    placeholderData: keepPreviousData,
    request: ({ signal, headers }) =>
      api.GET("/admin/events", {
        params: {
          query: {
            ...(filters.q ? { q: filters.q } : {}),
            ...(filters.status !== "all" ? { status: filters.status } : {}),
            ...(filters.categoryId ? { category_id: filters.categoryId } : {}),
            sort: filters.sort,
            ...(cursor ? { cursor } : {}),
            limit: EVENT_PAGE_SIZE,
          },
        },
        signal,
        headers,
      }),
  });
}

export function useEventDetail(eventId: string) {
  return useApiQuery({
    queryKey: eventKeys.detail(eventId),
    request: ({ signal, headers }) =>
      api.GET("/admin/events/{eventId}", { params: { path: { eventId } }, signal, headers }),
  });
}

export function useEventStats(eventId: string) {
  return useApiQuery({
    queryKey: eventKeys.stats(eventId),
    request: ({ signal, headers }) =>
      api.GET("/admin/events/{eventId}/stats", { params: { path: { eventId } }, signal, headers }),
  });
}

export interface TicketFilters {
  q: string;
  status: TicketStatus | "all";
  checkedIn: "all" | "true" | "false";
  sort: AdminEventTicketSort;
}

export function useEventTickets(eventId: string, filters: TicketFilters, cursor: string | null) {
  return useApiQuery({
    queryKey: eventKeys.tickets(eventId, { ...filters, cursor }),
    placeholderData: keepPreviousData,
    request: ({ signal, headers }) =>
      api.GET("/admin/events/{eventId}/tickets", {
        params: {
          path: { eventId },
          query: {
            ...(filters.q ? { q: filters.q } : {}),
            ...(filters.status !== "all" ? { status: filters.status } : {}),
            ...(filters.checkedIn !== "all" ? { checked_in: filters.checkedIn === "true" } : {}),
            sort: filters.sort,
            ...(cursor ? { cursor } : {}),
            limit: TICKET_PAGE_SIZE,
          },
        },
        signal,
        headers,
      }),
  });
}

/**
 * Simpan detail terbaru (respons mutasi atau `current` konflik) ke cache lalu tandai turunan event basi: daftar,
 * statistik dan tiket dimuat ulang saat dibuka.
 */
export function storeEventDetail(queryClient: QueryClient, detail: AdminEventDetail): void {
  queryClient.setQueryData(eventKeys.detail(detail.id), detail);
  void queryClient.invalidateQueries({ queryKey: eventKeys.lists });
  void queryClient.invalidateQueries({ queryKey: eventKeys.stats(detail.id) });
  void queryClient.invalidateQueries({ queryKey: eventKeys.tickets(detail.id) });
}

/** Detail event dari `current` galat konflik (VERSION_CONFLICT, VALIDATION_ERROR kuota; AC F15-2, F15-4). */
export function currentEventDetail(current: unknown): AdminEventDetail | null {
  if (
    current &&
    typeof current === "object" &&
    "id" in current &&
    "version" in current &&
    "allowed_actions" in current
  )
    return current as AdminEventDetail;
  return null;
}

/** Tiket dari `current` galat pembatalan tiket (VERSION_CONFLICT, PAYMENT_STATE_CONFLICT). */
export function currentTicket(current: unknown): AdminEventTicket | null {
  if (
    current &&
    typeof current === "object" &&
    "id" in current &&
    "holder" in current &&
    "can_refund" in current
  )
    return current as AdminEventTicket;
  return null;
}

/** POST /admin/event-covers multipart (N-10). Melempar ApiError (FILE_INVALID, RATE_LIMITED, ...). */
export function uploadEventCover(file: File, signal?: AbortSignal): Promise<AdminEventCoverMedia> {
  const form = new FormData();
  form.append("file", file, file.name);
  return unwrap(
    api.POST("/admin/event-covers", {
      // openapi-fetch meneruskan FormData apa adanya; peramban menetapkan boundary multipart.
      body: form as unknown as components["schemas"]["AdminEventCoverUploadRequest"],
      signal,
    }),
  );
}
