import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute, guard } from "../__root";

/** Tab halaman detail event (?tab=): ringkasan, peserta/tiket, atau formulir ubah. */
export const EVENT_DETAIL_TABS = ["overview", "tickets", "edit"] as const;
export type EventDetailTab = (typeof EVENT_DETAIL_TABS)[number];

export interface EventDetailSearch {
  tab?: EventDetailTab;
}

export interface CheckinSearch {
  /** Event yang sedang dipindai petugas, agar muat ulang halaman tidak mengosongkan pilihan. */
  event?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Manajemen Event & Tiket (F-09, F-15, AC F15-2) dan pemindai check-in (events.checkin). Area events. */
export const eventsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/events",
  beforeLoad: guard("/events"),
  component: lazyRouteComponent(() => import("./EventsPages"), "EventsPage"),
});

export const newEventRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/events/new",
  beforeLoad: guard("/events/new"),
  component: lazyRouteComponent(() => import("./EventsPages"), "EventCreatePage"),
});

export const eventDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/events/$eventId",
  validateSearch: (search: Record<string, unknown>): EventDetailSearch =>
    EVENT_DETAIL_TABS.includes(search.tab as EventDetailTab) && search.tab !== "overview"
      ? { tab: search.tab as EventDetailTab }
      : {},
  beforeLoad: guard("/events/$eventId"),
  component: lazyRouteComponent(() => import("./EventsPages"), "EventDetailPage"),
});

export const checkinRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/events/checkin",
  validateSearch: (search: Record<string, unknown>): CheckinSearch =>
    typeof search.event === "string" && UUID.test(search.event) ? { event: search.event } : {},
  beforeLoad: guard("/events/checkin"),
  // Potongan kode terpisah: halaman petugas check-in tidak memuat formulir dan tabel event.
  component: lazyRouteComponent(() => import("./CheckinPage"), "CheckinPage"),
});

export const eventsRoutes = [eventsRoute, newEventRoute, eventDetailRoute, checkinRoute] as const;
